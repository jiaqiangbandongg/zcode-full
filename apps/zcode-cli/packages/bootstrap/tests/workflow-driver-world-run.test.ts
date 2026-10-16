/**
 * world.run 的 driver 侧执行（docs/dynamic-workflow/authoring.md）。照
 * workflow-driver-world-read-args.test.ts 的形状：只碰 driver 端口本身，不经脚本、不经引擎
 * ——facade 类型签名与编译期字面量规则在上游拦截，这里防的是编译期之外的接线错误，
 * 以及「执行结果 → 值 / 拒绝」的映射契约。
 */

import { describe, expect, it } from "vitest";
import type { ExecutionPort, ExecutionResult, FileSystemPort } from "@zcode/contracts";
import { InMemoryJournalStore, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";

/** 触及即失败的 fs 端口：world.run 不该碰文件系统。 */
function unsupportedFileSystemPort(): FileSystemPort {
  return new Proxy({} as FileSystemPort, {
    get(_target, name) {
      return () => {
        throw new Error(`fileSystemPort.${String(name)} 不应被 world.run 触及`);
      };
    },
  });
}

function noopSink(): WorkflowReportSink {
  const unexpected = (name: string) => (): never => {
    throw new Error(`noopSink.${name} 不应被触及`);
  };
  return {
    askSubmitAttempted: unexpected("askSubmitAttempted"),
    askTurnEnded: unexpected("askTurnEnded"),
    askProgress: unexpected("askProgress"),
    askStats: unexpected("askStats"),
    askFailed: unexpected("askFailed"),
  };
}

interface RecordedRun {
  file: string;
  args: string[] | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
  maxInlineBytes: number | undefined;
}

/** 记录请求并回放配置结果的 ExecutionPort 桩。 */
function stubExecutionPort(result: Partial<ExecutionResult>): {
  port: ExecutionPort;
  calls: RecordedRun[];
} {
  const calls: RecordedRun[] = [];
  const stream = (text: string) => ({ text, bytes: Buffer.byteLength(text, "utf8"), truncated: false });
  const full: ExecutionResult = {
    status: "completed",
    exitCode: 0,
    stdout: stream(""),
    stderr: stream(""),
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(0),
    completedAt: new Date(1),
    ...result,
  } as ExecutionResult;
  return {
    calls,
    port: {
      run: async (request) => {
        const command = request.command;
        calls.push({
          file: command.mode === "argv" ? command.file : `(shell) ${command.command}`,
          args: command.mode === "argv" ? command.args : undefined,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          maxInlineBytes: request.outputLimit?.maxInlineBytes,
        });
        return full;
      },
    } as ExecutionPort,
  };
}

const CAP = 256 * 1024;

function makeDriver(executionPort: ExecutionPort) {
  return createAgentRuntimeWorkflowDriver({
    journal: new InMemoryJournalStore(),
    emit: () => undefined,
    fileSystemPort: unsupportedFileSystemPort(),
    executionPort,
    escalationRegistry: createWorkflowEscalationRegistry(),
    cwd: "/workspace/root",
    runtimeFactory: () => {
      throw new Error("runtimeFactory 不应被 world.run 触及");
    },
  })(noopSink());
}

describe("workflow driver — world.run", () => {
  it("passes argv, cwd, default 300s timeout and cap+1 output limit to the port", async () => {
    const { port, calls } = stubExecutionPort({ exitCode: 0, stdout: { text: "ok", bytes: 2, truncated: false } as never });
    const driver = makeDriver(port);
    const value = await driver.executeWorldRead("run", ["lean", ["--make", "a.lean"]]);
    expect(value).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(calls).toEqual([
      {
        file: "lean",
        args: ["--make", "a.lean"],
        cwd: "/workspace/root",
        timeoutMs: 300_000,
        maxInlineBytes: CAP + 1,
      },
    ]);
  });

  it("honours opts.timeoutMs with no upper clamp (long-running tests are in-contract)", async () => {
    const { port, calls } = stubExecutionPort({});
    const driver = makeDriver(port);
    await driver.executeWorldRead("run", ["lake", ["build"], { timeoutMs: 3_600_000 }]);
    expect(calls[0]?.timeoutMs).toBe(3_600_000);
  });

  it("returns a nonzero exit as a value, not a rejection (the gating loop's normal case)", async () => {
    const { port } = stubExecutionPort({
      status: "failed",
      exitCode: 2,
      stderr: { text: "proof failed", bytes: 12, truncated: false } as never,
    });
    const driver = makeDriver(port);
    await expect(driver.executeWorldRead("run", ["lean", ["a.lean"]])).resolves.toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "proof failed",
    });
  });

  it("rejects a timeout as a catchable DriverError naming the wall clock", async () => {
    const { port } = stubExecutionPort({
      status: "timed_out",
      timedOut: true,
      error: { type: "timeout", message: "Command timed out" },
    });
    const driver = makeDriver(port);
    await expect(driver.executeWorldRead("run", ["lake", ["build"]])).rejects.toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("300000ms"),
    });
  });

  it("rejects spawn errors as DriverError (the observation never ran)", async () => {
    const { port } = stubExecutionPort({
      status: "spawn_error",
      error: { type: "spawn_error", message: "ENOENT: lean not found" },
    });
    const driver = makeDriver(port);
    await expect(driver.executeWorldRead("run", ["lean", []])).rejects.toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("runs whatever command the compiled script hands it: there is no runtime allowlist", async () => {
    // 授权只在编译期（9003 字面量 + 确认窗）。driver 曾另持一份 launch 时收集的命令集复验，
    // 补全函数体里新出现的命令因此被误拒（workflow-world-read.ts 文件头第 2 条）；这里钉住
    // "driver 不再有第二份名单"：一条 launch 时不存在的命令照样执行。
    const { port, calls } = stubExecutionPort({});
    const driver = makeDriver(port);
    await expect(driver.executeWorldRead("run", ["echo", ["hi"]])).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(calls.map((call) => call.file)).toEqual(["echo"]);
  });

  it("rejects stdout over the 256KB cap with actionable guidance (cap+1 probe)", async () => {
    const big = "x".repeat(CAP + 1);
    const { port } = stubExecutionPort({
      stdout: { text: big, bytes: CAP + 1, truncated: false } as never,
    });
    const driver = makeDriver(port);
    await expect(driver.executeWorldRead("run", ["node", ["-e", "spam"]])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
      message: expect.stringContaining("stdout"),
    });
  });

  it("rejects stderr over the cap the same way", async () => {
    const { port } = stubExecutionPort({
      stderr: { text: "y", bytes: 1, truncated: true } as never,
    });
    const driver = makeDriver(port);
    await expect(driver.executeWorldRead("run", ["node", []])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
      message: expect.stringContaining("stderr"),
    });
  });

  it("validates argument shapes loudly, never coercing", async () => {
    const { port, calls } = stubExecutionPort({});
    const driver = makeDriver(port);
    const reject = (args: unknown[]) =>
      expect(driver.executeWorldRead("run", args)).rejects.toMatchObject({ code: "DriverError" });
    await reject([]);
    await reject([42]);
    await reject(["lean", "not-an-array"]);
    await reject(["lean", [1]]);
    await reject(["lean", [], "not-opts"]);
    await reject(["lean", [], { timeoutMs: 0 }]);
    await reject(["lean", [], { timeoutMs: 1.5 }]);
    await reject(["lean", [], {}, "extra"]);
    expect(calls).toEqual([]);
  });
});
