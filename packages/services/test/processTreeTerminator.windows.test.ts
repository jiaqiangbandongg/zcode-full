import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

import {
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "@zcode/services/process/processTreeTerminator";

const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;

let targetedPowerShellResult: string | undefined;
let targetedPowerShellResultsByPid: Map<number, string>;
let powershellResult: string;
let powershellError: Error | null;
let powershellDelayMs: number;
let targetedPowerShellUsesConfiguredTimeout: boolean;
let onPowerShellQuery: (() => void) | undefined;
let alivePids: Set<number>;
let taskkillRemovesOnGraceful: boolean;

function powershellIdentity(pid: number, parentPid: number): string {
  return powershellIdentityAt(pid, parentPid, Date.UTC(2026, 6, 24, 11, 0, 0));
}

function powershellIdentityAt(pid: number, parentPid: number, utcMilliseconds: number): string {
  const ticks = DOTNET_UNIX_EPOCH_TICKS + BigInt(utcMilliseconds) * 10_000n;
  return `${pid} ${parentPid} ${ticks}\n`;
}

describe("terminateProcessTree Windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 24, 12, 0, 0)));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    alivePids = new Set([4242]);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (alivePids.has(Number(pid))) return true;
      throw Object.assign(new Error("process not found"), { code: "ESRCH" });
    });
    targetedPowerShellResult = undefined;
    targetedPowerShellResultsByPid = new Map();
    powershellResult = powershellIdentity(4242, 1);
    powershellError = null;
    powershellDelayMs = 0;
    targetedPowerShellUsesConfiguredTimeout = false;
    onPowerShellQuery = undefined;
    taskkillRemovesOnGraceful = false;
    execFileMock
      .mockReset()
      .mockImplementation(
        (
          command: string,
          args: string[],
          options: { timeout?: number },
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (command === "powershell.exe") {
            onPowerShellQuery?.();
            const targeted = args.some((arg) => arg.includes("ProcessId ="));
            const targetedPid = Number(
              /ProcessId = (\d+)/u.exec(args.find((arg) => arg.includes("ProcessId =")) ?? "")?.[1],
            );
            const resultAtInvocation = targeted
              ? (targetedPowerShellResultsByPid.get(targetedPid) ??
                targetedPowerShellResult ??
                powershellIdentity(targetedPid, targetedPid === 5000 ? 4242 : 1))
              : powershellResult;
            const reply = () => callback(powershellError, resultAtInvocation, "");
            const delayMs =
              targeted && targetedPowerShellUsesConfiguredTimeout
                ? (options.timeout ?? 0)
                : powershellDelayMs;
            if (delayMs > 0) setTimeout(reply, delayMs);
            else reply();
          } else {
            const pid = Number(args[1]);
            if (taskkillRemovesOnGraceful || args.includes("/F")) {
              alivePids.delete(pid);
            }
            callback(null, "", "");
          }
          return {};
        },
      );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Windows 进程快照直接使用 PowerShell/CIM", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    const snapshot = await captureProcessTreeSnapshotAsync(child);

    expect(snapshot?.rootPid).toBe(4242);
    expect(execFileMock.mock.calls.filter(([command]) => command === "wmic.exe")).toHaveLength(0);
    expect(
      execFileMock.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toHaveLength(1);
  });

  it("非等待式回收到 force deadline 后不使用旧快照强杀 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    // 修复原因：Node exit 回调可能晚于 OS 退出及 PID 复用；deadline 时没有新的
    // CreationDate 复核，就不能根据旧快照向裸 root PID 发送 /F。
    terminateProcessTree(child, { forceAfterMs: 20 });
    await vi.advanceTimersByTimeAsync(20);

    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 前定向复核 CreationDate 匹配才强杀 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 前直接使用 PowerShell 定向复核 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 4242")]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 定向复核为 PowerShell 保留完整预算", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    targetedPowerShellUsesConfiguredTimeout = true;
    powershellResult = powershellIdentity(4242, 1);

    terminateProcessTree(child, { forceAfterMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 4242")]),
      expect.objectContaining({ timeout: 750, windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 定向复核失败时仅对受管 live root 使用句柄兜底", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellError = Object.assign(new Error("simulated targeted CIM timeout"), {
      code: "ETIMEDOUT",
    });
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) => {
      if (force && pid === 4242) {
        alivePids.delete(pid);
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }
      return Promise.resolve({});
    });

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          { parentPid: 1, pid: 4242, startTime: "windows-utc-us:1784890800000000" },
          { parentPid: 4242, pid: 5000, startTime: "windows-utc-us:1784890800000000" },
        ],
      },
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250);

    // 安全契约：受管 ChildProcess 的 live root 句柄是 root-only 所有权证据；CIM
    // 定向复核失败时仍可收口 root，但不得把未复核后代加入显式 /F 目标。
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).not.toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(880);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000] });
  });

  it("graceful 挂起时 force 会强杀本次仍匹配的 root 与已验证后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult = `${powershellIdentity(4242, 1)}${powershellIdentity(5000, 4242)}`;
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) =>
      force
        ? Promise.resolve().then(() => {
            alivePids.delete(pid);
            if (pid === 4242) {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            }
            return {};
          })
        : new Promise<Record<string, never>>(() => {}),
    );

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250);

    // Bug 回归：旧 deadlineSnapshotOnly 分支只保留 root，导致已验证后代永远没有 /F flight。
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });
    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
  });

  it("force 前后代 PID 已复用时跳过该 PID 但继续收口匹配的 root", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult = `${powershellIdentity(4242, 1)}${powershellIdentity(5000, 4242)}`;
    targetedPowerShellResultsByPid.set(5000, powershellIdentity(6000, 1));
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) =>
      force
        ? Promise.resolve().then(() => {
            alivePids.delete(pid);
            if (pid === 4242) {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            }
            return {};
          })
        : new Promise<Record<string, never>>(() => {}),
    );

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).not.toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 5000")]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    // 不匹配可能是 PID 复用，也可能是查询降级。安全边界是不强杀，并继续把旧身份
    // 作为未确认残留报告，禁止把复核失败误判成清理成功。
    await vi.advanceTimersByTimeAsync(880);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000] });
  });

  it("force timer 先于 exit 回调且 PID 已复用时不强杀新 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    targetedPowerShellResult = powershellIdentity(6000, 1);

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("PowerShell 全量快照与身份过滤保持同一进程创建身份", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    const snapshot = await captureProcessTreeSnapshotAsync(child);
    expect(await filterCurrentProcessIdentitiesAsync(snapshot!.identities, {})).toEqual(
      snapshot!.identities,
    );

    const secondSnapshot = await captureProcessTreeSnapshotAsync(child);
    expect(await filterCurrentProcessIdentitiesAsync(secondSnapshot!.identities, {})).toEqual(
      secondSnapshot!.identities,
    );
  });

  it("PowerShell 查询耗尽预算后 force 复用快照且不重复查询", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    const snapshot = await captureProcessTreeSnapshotAsync(child);
    const fullQueryCount = execFileMock.mock.calls.filter(
      ([command, args]) =>
        command === "powershell.exe" &&
        !(args as string[]).some((arg) => arg.includes("ProcessId =")),
    ).length;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot,
      waitAfterForceMs: 30,
      windowsTaskkillTimeoutMs: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(
      execFileMock.mock.calls.filter(
        ([command, args]) =>
          command === "powershell.exe" &&
          !(args as string[]).some((arg) => arg.includes("ProcessId =")),
      ),
    ).toHaveLength(fullQueryCount);
    await vi.advanceTimersByTimeAsync(31);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [4242] });
  });

  it("进程表快照查询本身也受 transport 全链路绝对 deadline 约束", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellDelayMs = 50;
    let settled = false;

    const snapshotPromise = captureProcessTreeSnapshotAsync(child, {
      windowsCleanupDeadlineAtMs: Date.now() + 40,
    });
    void snapshotPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    // 旧实现会继续等待 PowerShell 到 60ms；绝对 deadline 到达后必须立即退化为
    // unavailable，让 transport 继续进入有界的 fail-closed 收口。
    expect(settled).toBe(true);
    await expect(snapshotPromise).resolves.toBeUndefined();
    // 让被 absolute-deadline race 截断的底层 mock 查询完成，避免模块级共享 flight 污染后续用例。
    await vi.advanceTimersByTimeAsync(20);
  });

  it("不为晚于共享查询启动的新 root 复用过期进程表", async () => {
    const firstChild = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    const secondChild = {
      exitCode: null,
      pid: 6000,
      signalCode: null,
    } as ChildProcess;
    powershellDelayMs = 20;

    const firstSnapshotPromise = captureProcessTreeSnapshotAsync(firstChild, {
      ownedProcessStartedAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(1);
    powershellResult = powershellIdentity(6000, 1);
    const secondSnapshotPromise = captureProcessTreeSnapshotAsync(secondChild, {
      ownedProcessStartedAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(firstSnapshotPromise).resolves.toMatchObject({ rootPid: 4242 });
    await expect(secondSnapshotPromise).resolves.toMatchObject({ rootPid: 6000 });
  });

  it("等待 graceful taskkill flight 与稍后投递的 exit 后再判定完成", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    let completeTaskkill: (() => void) | undefined;
    const windowsTaskkillRunner = vi.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          completeTaskkill = () => {
            alivePids.delete(4242);
            resolve({});
          };
        }),
    );
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // Bug 回归：旧 waiter 在 graceful taskkill 尚未 settle 时按固定 force-wait 窗口
    // 报 remaining PID；真实进程可能只晚几个毫秒投递 ChildProcess exit。
    await vi.advanceTimersByTimeAsync(31);
    expect(result).toBeUndefined();

    completeTaskkill?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    setTimeout(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }, 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 4242,
      timeoutMs: 100,
    });
  });

  it("root 查询期间退出并复用 PID 时不认领新进程后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult =
      powershellIdentityAt(4242, 1, Date.UTC(2026, 6, 24, 11, 30, 0)) +
      powershellIdentityAt(5000, 4242, Date.UTC(2026, 6, 24, 11, 30, 0, 100));
    onPowerShellQuery = () => {
      child.exitCode = 0;
    };

    const snapshot = await captureProcessTreeSnapshotAsync(child, {
      ownedProcessStartedAtMs: Date.UTC(2026, 6, 24, 10, 0, 0),
    });
    expect(snapshot).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("root 查询期间退出且有可信 exit 时间时恢复并回收旧后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([5000]);
    taskkillRemovesOnGraceful = true;
    powershellResult = powershellIdentity(5000, 4242);
    const exitedAtMs = Date.UTC(2026, 6, 24, 11, 30, 0);
    onPowerShellQuery = () => {
      child.exitCode = 0;
    };

    const snapshot = await captureProcessTreeSnapshotAsync(child, {
      ownedProcessStartedAtMs: Date.UTC(2026, 6, 24, 10, 0, 0),
      resolveOwnedProcessExitedAtMs: () => exitedAtMs,
    });
    expect(snapshot?.identities.map((identity) => identity.pid)).toEqual([5000]);

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot,
      waitAfterForceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "5000", "/T"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("双后端查询失败时等待未验证 root 并明确报告残留", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;

    powershellResult = "";
    await expect(captureProcessTreeSnapshotAsync(child)).resolves.toBeUndefined();

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 20,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsTaskkillTimeoutMs: 20,
    });
    let result: Awaited<typeof resultPromise> | undefined;
    void resultPromise.then((value) => {
      result = value;
    });

    // 查询失败且没有任何已验证 identity 时，graceful/force targets 都为空；没有实际
    // taskkill 可以等待，因此 deadline 不应无条件预留 taskkill timeout。
    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual({ remainingPids: [4242] });
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("没有 taskkill 目标时使用 transport 剩余预算观察延迟正常退出", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsCleanupDeadlineAtMs: Date.now() + 1_000,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });
    setTimeout(() => {
      alivePids.delete(4242);
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, 600);

    // Bug 回归：没有可安全发送 taskkill 的身份时，旧 waiter 会把 1s 绝对预算
    // 压缩为 waitAfterForceMs=30ms，把随后正常 code=0 的 exit 误报为残留。
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(570);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("纯观察窗口不突破 Local Host 四秒总上界", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsCleanupDeadlineAtMs: Date.now() + 1_000,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // 首次 cleanup 最坏 3.25s；最终重试只能再观察 750ms，必须在 Local Host
    // 的 4s 强制退出点前明确返回真实残留，不能把完整 1.25s retry 预算串行叠加。
    await vi.advanceTimersByTimeAsync(749);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [4242] });
  });

  it("未验证 root 仍有已验证目标时保留 taskkill deadline", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    const windowsTaskkillRunner = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 20,
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          {
            parentPid: 4242,
            pid: 5000,
            startTime: "20260724190000.000000+480",
          },
        ],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 20,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // 即使 root 不可验证，只要存在已验证后代，graceful taskkill 就是真实 flight；
    // 继续保留完整预算，不能在 force + grace 的 50ms 边界提前报告。
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000, 4242] });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 5000,
      timeoutMs: 20,
    });
  });

  it("全链路绝对 deadline 会扣除进入 waiter 前已消耗的快照与 EOF 时间", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    const windowsTaskkillRunner = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [
          {
            parentPid: 1,
            pid: 4242,
            startTime: "20260724190000.000000+480",
          },
        ],
      },
      waitAfterForceMs: 30,
      // 模拟 snapshot + EOF 已经消耗 3,210ms：transport 的 3,250ms 全链路预算只剩 40ms。
      windowsCleanupDeadlineAtMs: Date.now() + 40,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    // 旧实现会在这里仍为 undefined，并把窗口错误延长到 130ms；断言必须快速失败，
    // 不能等待旧 deadline 导致 fake-timer 用例自身超时。
    expect(result).toEqual({ remainingPids: [4242] });
    await expect(resultPromise).resolves.toEqual(result);
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 4242,
      timeoutMs: 100,
    });
  });

  it("CIM 硬不可用时缓存 capability 并跳过后续身份查询", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellError = Object.assign(new Error("powershell unavailable"), { code: "ENOENT" });

    await expect(captureProcessTreeSnapshotAsync(child)).resolves.toBeUndefined();
    const queryCount = execFileMock.mock.calls.filter(
      ([command]) => command === "powershell.exe",
    ).length;

    await expect(
      filterCurrentProcessIdentitiesAsync(
        [{ parentPid: 1, pid: 4242, startTime: "windows-utc-us:1784890800000000" }],
        {},
      ),
    ).resolves.toEqual([]);
    expect(
      execFileMock.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toHaveLength(queryCount);
  });
});
