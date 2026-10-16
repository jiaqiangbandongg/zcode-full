import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { terminateProcessTreeAndWaitMock } = vi.hoisted(() => ({
  terminateProcessTreeAndWaitMock: vi.fn(async () => ({ remainingPids: [] as number[] })),
}));

vi.mock("#src/process/processTreeTerminator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/process/processTreeTerminator.js")>()),
  captureProcessTreeSnapshotAsync: vi.fn(async (child: { pid?: number }) => ({
    rootPid: child.pid!,
    descendantPids: [],
    identities: [],
  })),
  terminateProcessTreeAndWait: terminateProcessTreeAndWaitMock,
}));

import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";

const activeChildren = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  terminateProcessTreeAndWaitMock.mockClear();
  vi.restoreAllMocks();
  await Promise.all(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  activeChildren.clear();
});

describe("ZCodeStdioTransport process tree result", () => {
  it("等待器确认 OS 进程树已退出时不被滞后的 ChildProcess 状态改判为残留", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    const startedAt = performance.now();

    // Bug 回归：Windows taskkill 已完成且 waiter 根据 OS 存活事实返回成功时，
    // Node 的 exit 事件仍可能晚一轮投递，child.exitCode 此刻合法地保持 null。
    await expect(transport.disposeAndWait()).resolves.toBeUndefined();
    // stderr drain 只能使用 250ms，不能重新借到整个 Windows 进程树窗口。
    expect(performance.now() - startedAt).toBeLessThan(3_500);
    expect(terminateProcessTreeAndWaitMock).toHaveBeenCalledOnce();
    expect(terminateProcessTreeAndWaitMock).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ windowsCleanupDeadlineAtMs: 13_250 }),
    );
    expect(child.exitCode).toBeNull();
  });
});
