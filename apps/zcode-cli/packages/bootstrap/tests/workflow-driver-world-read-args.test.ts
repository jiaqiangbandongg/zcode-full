/**
 * world-read 实参校验（driver 侧）。见 docs/execution-engine.md 的"World reads"
 * 与 "Boundary B: the driver port"。
 *
 * Boundary A 的 `worldRead(siteId, op, args)` 带的是**位置实参数组**：lowering 原样打包、不看 op、
 * 不看元数，所以「每个 op 需要几个什么类型的实参」这道关只在 driver 这一侧
 * （spec 的 "Driver owns arity and validation"）。这里直接调端口而不经脚本：facade 的类型签名在
 * 编译期就拦住了畸形调用，而这道防线要防的恰是编译期之外的接线错误——线协议、lowering，
 * 或者下一步新增 op 时忘了在 driver 里接上。
 *
 * 为什么独立成文件而不并入 workflow-driver.test.ts：那份用例经 helpers 在运行时 import
 * `@zcode/core`（真实 AgentRuntime）。本文件只碰 driver 端口本身（它对 `@zcode/core` 只有
 * 类型导入），因此不依赖模型侧的任何东西。
 */

import { describe, expect, it } from "vitest";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { InMemoryJournalStore, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";

/** 极简内存 fs 端口：只实现 world-read 用到的两个方法，其余被触及即失败。 */
function stubFileSystemPort(glob: string[], read: string): FileSystemPort {
  const unsupported = (name: string) => () => {
    throw new Error(`stubFileSystemPort.${name} 不应被 world-read 触及`);
  };
  return {
    async searchFiles(request: { path: string; pattern: string }) {
      return {
        path: request.path,
        pattern: request.pattern,
        durationMs: 0,
        files: glob,
        numFiles: glob.length,
        truncated: false,
      };
    },
    async readTextFile(request: { path: string }) {
      return {
        path: request.path,
        content: read,
        encoding: "utf-8",
        bytesRead: read.length,
        sizeBytes: read.length,
        truncated: false,
      };
    },
    createDirectory: unsupported("createDirectory"),
    stat: unsupported("stat"),
    readBinaryFile: unsupported("readBinaryFile"),
    readTextFileRange: unsupported("readTextFileRange"),
    writeTextFile: unsupported("writeTextFile"),
    removeFile: unsupported("removeFile"),
    listDirectory: unsupported("listDirectory"),
    searchText: unsupported("searchText"),
  } as unknown as FileSystemPort;
}

/**
 * 世界读取用不到子进程的用例里的 ExecutionPort 占位：被触及即失败。
 *
 * deps 里 executionPort 是**必填**（见 workflow-driver.ts 的字段注释：可选会给出一条静默
 * 降级的运行路径），所以这里不能省；而一个会抛的占位比一个空实现好——它让"本用例其实跑了
 * 一次 git"变成一次显式失败，而不是一个被忽略的空结果。
 */
function unsupportedExecutionPort(): ExecutionPort {
  return {
    run: () => {
      throw new Error("本用例不应触及 ExecutionPort（git.* world-read）");
    },
  };
}

/** 向上回报 sink：实参校验不经引擎，任一回调被触及都说明接错了。 */
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

function makeDriver() {
  return createAgentRuntimeWorkflowDriver({
    journal: new InMemoryJournalStore(),
    emit: () => undefined,
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: stubFileSystemPort(["a.ts"], "body"),
    escalationRegistry: createWorkflowEscalationRegistry(),
    cwd: process.cwd(),
    runId: "run",
    runtimeFactory: () => {
      throw new Error("实参校验不该创建 actor runtime");
    },
  })(noopSink());
}

describe("driver world-read argument validation", () => {
  it("passes well-formed positional args through to the fs port", async () => {
    await expect(makeDriver().executeWorldRead("glob", ["src/**"])).resolves.toEqual(["a.ts"]);
    await expect(makeDriver().executeWorldRead("read", ["a.ts"])).resolves.toBe("body");
  });

  it("rejects a missing argument with a structured DriverError (never a coerced path)", async () => {
    // `String(args[0])` 会把 undefined 变成路径 "undefined" 再去读文件，报出的 ENOENT
    // 指不回真正的错处——所以这里必须是一条结构化、指名 op 与实参名的拒绝。
    await expect(makeDriver().executeWorldRead("read", [])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(makeDriver().executeWorldRead("read", [])).rejects.toThrow(/read/);
    await expect(makeDriver().executeWorldRead("read", [])).rejects.toThrow(/path/);
  });

  it("rejects a wrong-typed argument", async () => {
    await expect(makeDriver().executeWorldRead("glob", [42])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(makeDriver().executeWorldRead("glob", [undefined])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(makeDriver().executeWorldRead("glob", [["src/**"]])).rejects.toMatchObject({
      code: "DriverError",
    });
  });

  it("rejects extra arguments (only a wiring fault can produce them)", async () => {
    // facade 的 `glob(pattern: string)` 在编译期就拒绝多余实参，所以运行期出现多参
    // 意味着 lowering / 线协议出了岔子；静默忽略等于把一个可定位的 bug 藏成一次语义不明的读取。
    await expect(makeDriver().executeWorldRead("glob", ["src/**", "extra"])).rejects.toMatchObject({
      code: "DriverError",
    });
  });

  it("rejects rather than throwing synchronously (so the node settles as failed)", async () => {
    // 同步抛错会从 engine.worldRead 里穿出去——引擎是在准入落 journal 之后才 `.then(...)`，
    // 于是会留下一个永远 running 的节点。executeWorldRead 因此必须是 async。
    const driver = makeDriver();
    let promise: Promise<unknown> | undefined;
    let threwSynchronously = false;
    try {
      promise = driver.executeWorldRead("glob", []);
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(false);
    await expect(promise).rejects.toMatchObject({ code: "DriverError" });
  });
});
