import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureProcessTreeSnapshot,
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTree,
  terminateProcessTreeAndWait,
  type ProcessIdentity,
  type ProcessTreeSnapshot,
} from "@zcode/services/process/processTreeTerminator";

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const tempDirs = new Set<string>();

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPidRunning(pid: number): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const status = result.stdout.trim();
  return status.length > 0 && !status.startsWith("Z");
}

async function waitForPidExit(
  pid: number,
  timeoutMs = 4_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await delay(50);
  }
  return !isPidAlive(pid);
}

async function waitForProcessTreeSnapshotIdentity(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  timeoutMs = 4_000,
): Promise<
  | {
    snapshot: ProcessTreeSnapshot;
    identity: ProcessIdentity;
  }
  | undefined
> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = captureProcessTreeSnapshot(child);
    const identity = snapshot?.identities.find((item) => item.pid === pid);
    if (snapshot && identity) {
      return { snapshot, identity };
    }
    await delay(50);
  }
  const snapshot = captureProcessTreeSnapshot(child);
  const identity = snapshot?.identities.find((item) => item.pid === pid);
  return snapshot && identity ? { snapshot, identity } : undefined;
}

function readFirstStdoutLine(
  child: ChildProcessWithoutNullStreams,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderrBuffer = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `child did not report grandchild pid stdout=${JSON.stringify(buffer)} stderr=${JSON.stringify(stderrBuffer)}`,
        ),
      );
    }, 2_000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      clearTimeout(timer);
      resolve(buffer.slice(0, newlineIndex).trim());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!buffer.trim()) {
        clearTimeout(timer);
        reject(
          new Error(
            `child exited before reporting pid code=${code} signal=${signal} stderr=${JSON.stringify(stderrBuffer)}`,
          ),
        );
      }
    });
  });
}

async function readReportedPid(
  child: ChildProcessWithoutNullStreams,
  pidFilePath?: string,
): Promise<number> {
  let stdoutLine = "";
  try {
    stdoutLine = await readFirstStdoutLine(child);
    const stdoutPid = Number(stdoutLine);
    if (Number.isInteger(stdoutPid)) {
      return stdoutPid;
    }
  } catch (error) {
    if (!pidFilePath) {
      throw error;
    }
  }

  if (pidFilePath) {
    const filePid = Number((await readFile(pidFilePath, "utf8")).trim());
    if (Number.isInteger(filePid)) {
      return filePid;
    }
  }

  throw new Error(`child reported invalid pid: ${JSON.stringify(stdoutLine)}`);
}

afterEach(async () => {
  for (const child of activeChildren) {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 测试兜底清理，进程已退出时忽略。 */
      }
    }
    terminateProcessTree(child);
  }
  activeChildren.clear();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("terminateProcessTree", () => {
  it("回收 runtime wrapper 时会一并结束其派生子进程", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-runtime-terminator-"));
    tempDirs.add(dir);
    const grandchildPidPath = join(dir, "grandchild.pid");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));
process.stdout.write(String(child.pid) + "\\n");
setInterval(() => {}, 1000);
`,
      ],
      {
        detached: shouldSpawnInDetachedProcessGroup(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    activeChildren.add(child);

    const grandchildPid = await readReportedPid(child, grandchildPidPath);
    expect(isPidAlive(grandchildPid)).toBe(true);

    // Bugfix: 用户反馈退出 ZCode 后仍残留 bun 版本的 Agent 子进程。
    // 这里用 wrapper -> grandchild 的结构复现，要求关闭 wrapper 时整棵进程树都被回收。
    terminateProcessTree(child);

    expect(await waitForPidExit(child.pid!)).toBe(true);
    expect(await waitForPidExit(grandchildPid)).toBe(true);
    activeChildren.delete(child);
  });

  // Bugfix: Windows 的 taskkill 进程树回收不会向 Node 子进程交付 POSIX SIGTERM。
  // 该用例只验证 POSIX graceful shutdown 窗口，Windows 另由进程树清理用例覆盖。
  it.runIf(process.platform !== "win32")(
    "关闭 runtime wrapper 时先给进程处理 SIGTERM 的窗口",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-runtime-terminator-"));
      tempDirs.add(dir);
      const markerPath = join(dir, "graceful-exit.txt");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(markerPath)}, "sigterm");
  setTimeout(() => process.exit(0), 150);
});
console.log("ready");
setInterval(() => {}, 1000);
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      await readFirstStdoutLine(child);

      // Bugfix: 回收残留进程不能把正常关闭路径变成立即 SIGKILL；
      // runtime 仍需要一点时间 flush 会话状态、关闭 MCP 连接和清理临时资源。
      terminateProcessTree(child);

      await delay(50);
      expect(isPidAlive(child.pid!)).toBe(true);
      expect(await readFile(markerPath, "utf8")).toBe("sigterm");
      expect(await waitForPidExit(child.pid!)).toBe(true);
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "POSIX 下会兜底清理脱离原进程组的后代进程",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-runtime-terminator-"));
      tempDirs.add(dir);
      const grandchildPidPath = join(dir, "detached-grandchild.pid");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));
process.stdout.write(String(child.pid) + "\\n");
setInterval(() => {}, 1000);
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);

      const grandchildPid = await readReportedPid(child, grandchildPidPath);
      expect(isPidAlive(grandchildPid)).toBe(true);

      // Bugfix: 有些 runtime 或插件会把后代进程 detached 到自己的进程组；
      // 只 kill runtime wrapper 的进程组会留下这类后代进程，必须按已发现的进程树兜底清理。
      terminateProcessTree(child);

      expect(await waitForPidExit(child.pid!)).toBe(true);
      expect(await waitForPidExit(grandchildPid)).toBe(true);
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "非等待式回收会强制结束忽略 SIGTERM 的 runtime 进程树",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); process.send?.("ready"); setInterval(() => {}, 1000);'],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
process.on("SIGTERM", () => {});
descendant.once("message", () => process.stdout.write(String(descendant.pid) + "\\n"));
setInterval(() => {}, 1000);
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      const descendantPid = await readReportedPid(child);

      try {
        // 修复原因：公开的非等待式关闭不会注入 force 观察回调；强杀副作用不能
        // 依赖该可选回调，否则忽略 SIGTERM 的 runtime 与 detached MCP 会永久残留。
        terminateProcessTree(child, { forceAfterMs: 20 });

        expect(await waitForPidExit(child.pid!)).toBe(true);
        expect(await waitForPidExit(descendantPid)).toBe(true);
      } finally {
        for (const pid of [child.pid, descendantPid]) {
          if (pid && isPidRunning(pid)) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* 测试兜底清理，进程已退出时忽略。 */
            }
          }
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "查询 root 身份失败时记录 warn 且延迟 force 不沿裸 PID 重新发现",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      await delay(50);

      const warnMessages: string[] = [];
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        terminateProcessTree(child, {
          forceAfterMs: 20,
          log: {
            warn: (_traceId, ...args) => {
              warnMessages.push(args.map(String).join(" "));
            },
          },
        });
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
      }

      expect(
        warnMessages.some((message) =>
          message.includes("查询 runtime 后代进程失败"),
        ),
      ).toBe(true);
      // 修复原因：首次查询失败后即使 PATH 已恢复，force timer 也不能沿裸 PID
      // 重新认领进程树；ChildProcess.kill 同样只是 PID 信号，不是稳定 OS 句柄。
      await delay(100);
      expect(isPidAlive(child.pid!)).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "等待式回收会撑到 SIGKILL 兜底完成",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
process.on("SIGTERM", () => {});
console.log("ready");
setInterval(() => {}, 1000);
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      await readFirstStdoutLine(child);

      // Bugfix: app 关闭时 host 不能只安排一个 unref 的 SIGKILL 兜底就退出；
      // 遇到忽略 SIGTERM 的 zcode-cli/app-server 时，必须等兜底执行完再让 host 结束。
      const result = await terminateProcessTreeAndWait(child, {
        forceAfterMs: 20,
        waitAfterForceMs: 20,
      });

      expect(result).toEqual({ remainingPids: [] });
      expect(await waitForPidExit(child.pid!, 1_000)).toBe(true);
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "根进程先退出时仍等待 detached 后代完成强制回收",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); process.send?.("ready"); setInterval(() => {}, 1000);'],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => process.stdout.write(String(descendant.pid) + "\\n"));
setInterval(() => {}, 1000);
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);

      const descendantPid = await readReportedPid(child);
      expect(isPidAlive(descendantPid)).toBe(true);

      try {
        // 修复原因：runtime 根进程收到 SIGTERM 后可能先于 detached MCP
        // 退出。等待边界必须是整棵已发现进程树，不能只观察根 child。
        await terminateProcessTreeAndWait(child, {
          forceAfterMs: 30,
          waitAfterForceMs: 30,
        });

        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidAlive(descendantPid)) {
          try {
            process.kill(-descendantPid, "SIGKILL");
          } catch {
            /* 测试兜底清理，进程已退出时忽略。 */
          }
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "延迟回收不会终止 PID 相同但创建标识已变化的进程",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
descendant.unref();
process.on("message", (message) => {
  if (message === "exit") process.exit(0);
});
process.stdout.write(String(descendant.pid) + "\\n");
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      const descendantPid = await readReportedPid(child);
      // 修复原因：stdout 已写出 PID 不代表 ps 的父子/进程组视图已经稳定；
      // 由父测试控制 wrapper 退出，并等待包含创建标识的快照，避免固定等待竞态。
      const captured = await waitForProcessTreeSnapshotIdentity(child, descendantPid);
      expect(captured).toBeDefined();
      const { snapshot, identity: descendantIdentity } = captured!;
      child.send("exit");
      expect(await waitForPidExit(child.pid!)).toBe(true);

      try {
        // 修复原因：延迟强杀时裸 PID 可能已被系统复用。用错误创建标识模拟
        // 同 PID 的新进程，回收器必须把原成员视为已退出，不能向当前进程发信号。
        await terminateProcessTreeAndWait(child, {
          forceAfterMs: 20,
          waitAfterForceMs: 20,
          snapshot: {
            ...snapshot,
            identities: snapshot.identities.map((identity) =>
              identity.pid === descendantIdentity.pid
                ? { ...identity, startTime: `${descendantIdentity.startTime}-reused` }
                : identity,
            ),
          },
        });
        expect(isPidRunning(descendantPid)).toBe(true);
      } finally {
        if (isPidRunning(descendantPid)) {
          process.kill(-descendantPid, "SIGKILL");
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "根进程已退出时仍按原进程组回收同组后代",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); process.send?.("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => {
  process.stdout.write(String(descendant.pid) + "\\n", () => setTimeout(() => process.exit(0), 100));
});
`,
        ],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      const descendantPid = await readReportedPid(child);
      const snapshot = captureProcessTreeSnapshot(child);
      expect(
        snapshot?.identities.some((identity) => identity.pid === descendantPid),
      ).toBe(true);
      expect(await waitForPidExit(child.pid!)).toBe(true);
      expect(isPidRunning(descendantPid)).toBe(true);

      try {
        // 修复原因：CLI 根进程异常退出后，同组 MCP 仍可能存活；必须用根进程
        // 生前快照证明该 PGID 内仍有原成员，不能只凭已退出的裸 root PID 发信号。
        await terminateProcessTreeAndWait(child, {
          forceAfterMs: 30,
          waitAfterForceMs: 30,
          snapshot,
        });
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) {
          process.kill(-child.pid!, "SIGKILL");
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "健康 runtime 提前退出时不会固定等待兜底窗口",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          detached: shouldSpawnInDetachedProcessGroup(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      await delay(50);

      const startedAt = Date.now();
      const waitPromise = terminateProcessTreeAndWait(child, {
        forceAfterMs: 1_500,
        waitAfterForceMs: 100,
      });
      setTimeout(() => {
        child.kill();
      }, 100).unref?.();
      // Bugfix: 旧等待式回收固定 sleep graceful + force 窗口；
      // 健康 runtime 在 SIGTERM 后提前退出时，不应继续卡满 2.25 秒。
      await waitPromise;
      const durationMs = Date.now() - startedAt;

      expect(await waitForPidExit(child.pid!, 1_000)).toBe(true);
      expect(durationMs).toBeLessThan(1_200);
      activeChildren.delete(child);
    },
  );
});
