import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "@zcode/services/process/processTreeTerminator";
import { ZCodeStdioTransport } from "@zcode/services/node";

const activeChildren = new Set<ChildProcessWithoutNullStreams>();

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    // Windows 没有系统 ps；Git 附带的 ps 既不保证 stdout，也不能可靠查询原生 PID。
    // process.kill(pid, 0) 已完成当前平台的存活探测。
    return true;
  }
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const status = result.stdout.trim();
  return status.length > 0 && !status.startsWith("Z");
}

afterEach(() => {
  for (const child of activeChildren) {
    terminateProcessTree(child);
  }
  activeChildren.clear();
});

describe("ZCodeStdioTransport", () => {
  it("stderr failure alone leaves a responsive protocol usable", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      process.stdin.on("data", () => process.stdout.write(JSON.stringify({ id: "pong", result: {} }) + "\\n"));
      process.stdin.once("end", () => process.exit(0));
      process.stdout.write(JSON.stringify({ id: "ready", result: {} }) + "\\n");
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    await new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    child.stderr.emit("error", new Error("diagnostic reader failed"));
    const response = new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    await transport.send({ id: "ping", method: "workspace/readState", params: {} });
    await response;
    expect(closed).toBe(false);
    await transport.disposeAndWait();
    expect(child.exitCode).toBe(0);
  });

  it("keeps the final stderr line while EOF retires the protocol", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      process.stdin.resume();
      process.stdin.once("end", () => process.stderr.write("FINAL_DIAGNOSTIC", () => process.exit(0)));
      process.stdout.write(JSON.stringify({ id: "ready", result: {} }) + "\\n");
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    activeChildren.add(child);
    const lines: string[] = [];
    const transport = new ZCodeStdioTransport(child, { onStderrLine: (line) => lines.push(line) });
    await new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    // 修复原因：退出后的进程身份复核可能阻塞事件循环，让 250ms drain timer
    // 先于 stderr EOF 投递。本用例只验证尾行收集，真实退出时限由后续用例验证。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await transport.disposeAndWait();
      expect(child.exitCode).toBe(0);
      expect(lines).toEqual(["FINAL_DIAGNOSTIC"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposeAndWait 优先用 stdin EOF 关闭 stdio agent", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdin.once("close", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    await delay(50);

    const startedAt = Date.now();
    // Bugfix: app-server --stdio 的自然关闭边界是 stdin EOF，不能每次关闭都直接
    // 进入进程树强杀等待，否则即使 agent 可正常收尾也会带来几秒关窗延迟。
    await transport.disposeAndWait();
    const durationMs = Date.now() - startedAt;

    expect(child.exitCode).toBe(0);
    // 阈值依据：产品约束是 Windows 清理落在 Host 3.5s service phase 预算内
    // （disposeAndWaitOnce 的绝对 deadline 即按它构造）。原 1s 紧断言在部分
    // Windows 机器上不稳定——stdin 管道拆除 + 进程树快照（WMI/CIM 查询）合计
    // 可合法耗时 ~2s 且优雅退出仍然成立（exitCode=0），属机器性能差异而非回归；
    // Linux/mac 保留 1s 紧阈值不变。
    const shutdownBudgetMs = process.platform === "win32" ? 3_500 : 1_000;
    expect(durationMs).toBeLessThan(shutdownBudgetMs);
    activeChildren.delete(child);
  });

  it.runIf(process.platform !== "win32")(
    "stdin EOF 让根进程先退出时仍回收已发现的 detached 后代",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
process.stderr.write("starting\\n");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); process.send?.("ready"); setInterval(() => {}, 1000);'],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => process.stderr.write(String(descendant.pid) + "\\n"));
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      let reportPid: ((pid: number) => void) | undefined;
      const descendantPidPromise = new Promise<number>((resolve) => {
        reportPid = resolve;
      });
      const transport = new ZCodeStdioTransport(child, {
        onStderrLine: (line) => {
          const pid = Number(line);
          if (Number.isInteger(pid)) reportPid?.(pid);
        },
      });
      const descendantPid = await descendantPidPromise;
      expect(isPidRunning(descendantPid)).toBe(true);

      try {
        // 修复原因：EOF 正常关闭期间根进程可能先退出，但 detached MCP 不会随之退出。
        // disposeAndWait 必须使用 EOF 前保存的进程树快照完成后代回收。
        await transport.disposeAndWait();
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) {
          process.kill(-descendantPid, "SIGKILL");
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "根进程异常退出后仍按 Host 已拥有的进程组回收后代",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
process.stderr.write("starting\\n");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.send?.("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => {
  const frame = JSON.stringify({ method: "state.updated", params: { pid: descendant.pid } }) + "\\n";
  process.stdout.write(frame, () => setTimeout(() => process.exit(1), 50));
});
`,
        ],
        {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      const transport = new ZCodeStdioTransport(child, {
        ownedProcessGroupId: child.pid,
      });
      const descendantPidPromise = new Promise<number>((resolve) => {
        transport.onMessage((message) => {
          if (!("method" in message) || message.method !== "state.updated") return;
          const pid = (message.params as { pid?: unknown } | undefined)?.pid;
          if (typeof pid === "number") resolve(pid);
        });
      });
      const descendantPid = await descendantPidPromise;
      await waitForExit(child);
      expect(isPidRunning(descendantPid)).toBe(true);

      try {
        // 修复原因：运行期协议热路径不能为了异常退出兜底扫描进程表。
        // POSIX Host 已把 Agent 放进独立进程组；root 退出后应在 cleanup 边界
        // 按已拥有的 PGID 找回同组后代，而不是依赖某条运行期 notification。
        await transport.disposeAndWait();
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) {
          process.kill(-descendantPid, "SIGKILL");
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform === "win32")(
    "Windows 根进程异常退出后仍按 ParentProcessId 回收 task tree",
    async () => {
      const spawnRequestedAt = Date.now();
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.send?.("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => {
  const frame = JSON.stringify({ method: "state.updated", params: { pid: descendant.pid } }) + "\\n";
  process.stdout.write(frame, () => process.exit(1));
});
`,
        ],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      activeChildren.add(child);
      const transport = new ZCodeStdioTransport(child, {
        ownedProcessStartedAtMs: spawnRequestedAt,
      });
      const descendantPidPromise = new Promise<number>((resolve) => {
        transport.onMessage((message) => {
          if (!("method" in message) || message.method !== "state.updated") return;
          const pid = (message.params as { pid?: unknown } | undefined)?.pid;
          if (typeof pid === "number") resolve(pid);
        });
      });
      const descendantPid = await descendantPidPromise;
      await waitForExit(child);

      try {
        // 修复原因：Windows 没有 POSIX PGID；root 先退出时不能重新 taskkill 裸 root。
        // cleanup 只沿 Win32_Process 保留的 ParentProcessId 找回成员，并用 CreationDate
        // 固定 descendant 身份，确保 app quit 仍能回收原 task tree。
        await transport.disposeAndWait();
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
      }
      activeChildren.delete(child);
    },
  );

  it("高频 telemetry 保持实时有序分发且应用退出后仍回收 Agent", async () => {
    const frameCount = 300;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const frames = Array.from({ length: ${frameCount} }, (_, index) => ({
  method: "v4/telemetry/event",
  params: { index, pid: process.pid },
}));
process.stdout.write(frames.map((frame) => JSON.stringify(frame)).join("\\n") + "\\n");
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    let firstFrameAt = 0;
    let receivedFrameCount = 0;
    let agentPid = 0;
    const receivedIndexes: number[] = [];
    const allFramesPromise = new Promise<void>((resolve) => {
      transport.onMessage((message) => {
        if (!("method" in message) || message.method !== "v4/telemetry/event") return;
        const params = message.params as { index?: unknown; pid?: unknown } | undefined;
        if (firstFrameAt === 0) firstFrameAt = Date.now();
        if (typeof params?.pid === "number") agentPid = params.pid;
        if (typeof params?.index === "number") receivedIndexes.push(params.index);
        receivedFrameCount += 1;
        if (receivedFrameCount === frameCount) resolve();
      });
    });
    await allFramesPromise;

    try {
      // 修复原因：进程清理曾在每条 telemetry 前同步 spawnSync("ps")，300 条消息
      // 会阻塞 Host 数秒并让 subagent 面板空白。运行期帧必须直接交付；完整树扫描
      // 只允许在 disposeAndWait 已进入退出阶段后执行。
      expect(Date.now() - firstFrameAt).toBeLessThan(750);
      expect(receivedIndexes).toEqual(Array.from({ length: frameCount }, (_, index) => index));
      expect(isPidRunning(agentPid)).toBe(true);
      await transport.disposeAndWait();
      expect(isPidRunning(agentPid)).toBe(false);
    } finally {
      if (isPidRunning(agentPid)) {
        process.kill(process.platform === "win32" ? agentPid : -agentPid, "SIGKILL");
      }
    }
    activeChildren.delete(child);
  }, 15_000);

  it("agent 退出后会把 transport 视为关闭", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10);"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    await expect(
      transport.send({
        type: "zcode-hello-ack",
        version: 1,
        clientId: "test",
      } as never),
    ).rejects.toThrow("ZCode agent stdio transport is closed");
    activeChildren.delete(child);
  });

  it("按 LF 分帧时允许 JSON 字符串包含 Unicode 行分隔符", async () => {
    const frame = Buffer.from(
      `{"method":"session/event","params":{"text":"before\u2028middle\u2029after"}}\n`,
      "utf8",
    ).toString("base64");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const frame = Buffer.from("${frame}", "base64");
process.stdout.write(frame, () => setTimeout(() => process.exit(0), 10));
`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    let closeReason: string | undefined;
    transport.onClose((event) => {
      closeReason = event.reason;
    });
    const messagePromise = new Promise((resolve) => {
      transport.onMessage((message) => resolve(message));
    });

    await expect(messagePromise).resolves.toEqual({
      method: "session/event",
      params: {
        text: "before\u2028middle\u2029after",
      },
    });
    await waitForExit(child);

    expect(closeReason ?? "").not.toContain("protocol_parse_error");
    activeChildren.delete(child);
  });
});

// 用 PassThrough 模拟 child 的 stdio，便于精确控制 stdout 分块边界。
function createFakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    pid: undefined,
    exitCode: null,
    signalCode: null,
  });
  return child as unknown as ChildProcessWithoutNullStreams & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
}

function writeInChunks(stream: PassThrough, bytes: Buffer, chunkBytes: number): void {
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    stream.write(bytes.subarray(offset, offset + chunkBytes));
  }
}

describe("ZCodeStdioTransport stdout 分帧", () => {
  it("跨 chunk 的超大多字节帧、同 chunk 多帧与 EOF 尾帧按序完整交付", async () => {
    const child = createFakeChild();
    const transport = new ZCodeStdioTransport(child);
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));
    const closed = new Promise<string | undefined>((resolve) => {
      transport.onClose((event) => resolve(event.reason));
    });

    const big = { method: "session/event", params: { text: "中文🙂\u2028".repeat(40_000) } };
    const small = [1, 2, 3].map((n) => ({ id: `small-${n}`, result: { n } }));
    const tail = { id: "tail", result: {} };
    const bytes = Buffer.from(
      `${JSON.stringify(small[0])}\n${JSON.stringify(big)}\r\n${JSON.stringify(small[1])}\n\n${JSON.stringify(small[2])}\n${JSON.stringify(tail)}`,
      "utf8",
    );
    // 7 字节的奇数分块会切开 UTF-8 多字节序列与 CRLF。
    writeInChunks(child.stdout, bytes, 7);
    child.stdout.end();

    await expect(closed).resolves.toBe("stdout_closed");
    expect(messages).toEqual([small[0], big, small[1], small[2], tail]);
  });

  it("超大单行按小块到达时换行扫描量保持线性", async () => {
    const child = createFakeChild();
    const transport = new ZCodeStdioTransport(child);
    const received = new Promise((resolve) => transport.onMessage(resolve));
    const line = Buffer.from(
      `${JSON.stringify({ method: "session/event", params: { text: "x".repeat(4 << 20) } })}\n`,
      "utf8",
    );

    // Bug 原因：旧实现每个 chunk 都对累积 buffer 整体 indexOf("\n")，V8 需把 cons string
    // 整体拍平，15MB 的 session/read 响应按 64KB 到达时每轮分配数 GB（host CPU 100%）。
    // 这里统计对 "\n" 的扫描字符数，线性实现应与帧长同量级。
    let scannedChars = 0;
    const originalIndexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (this: string, search: string, position?: number) {
      if (search === "\n") scannedChars += this.length - (position ?? 0);
      return originalIndexOf.call(this, search, position);
    };
    try {
      writeInChunks(child.stdout, line, 4096);
      await received;
    } finally {
      String.prototype.indexOf = originalIndexOf;
    }
    expect(scannedChars).toBeLessThan(line.length * 2);
    child.stdout.end();
  });
});
