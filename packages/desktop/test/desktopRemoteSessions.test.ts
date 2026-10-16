import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  HostMessageTypes,
  HostResponseTypes,
  InternalChannels,
  PlatformChannels,
  type RemoteTarget,
} from "@zcode/shared";
import { createRemoteWorkspaceSessionManager } from "../src/main/desktopRemoteSessions.js";

const { browserWindowMock, channels } = vi.hoisted(() => {
  const windows: Array<unknown> = [];
  return {
    channels: [] as Array<{ port1: { close: ReturnType<typeof vi.fn> }; port2: object }>,
    browserWindowMock: {
      windows,
      fromId: vi.fn(
        (id: number) =>
          windows.find((candidate) => (candidate as { id: number }).id === id) ?? null,
      ),
      getAllWindows: vi.fn(() => windows),
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: browserWindowMock,
  MessageChannelMain: vi.fn(function MessageChannelMainMock() {
    const channel = {
      port1: {
        close: vi.fn(),
        start: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        postMessage: vi.fn(),
      },
      port2: {
        close: vi.fn(),
        start: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        postMessage: vi.fn(),
      },
    };
    channels.push(channel);
    return channel;
  }),
}));

class MockUtilityProcess extends EventEmitter {
  pid: number;
  postMessage: ReturnType<typeof vi.fn>;
  provisioningResult: {
    status: "applied" | "already-applied" | "unsupported" | "failed" | "rollback_failed";
    error?: string;
    errorCode?: string;
  } = { status: "applied" };

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.postMessage = vi.fn((message: unknown) => {
      const candidate = message as {
        type?: string;
        requestId?: string;
        environmentKey?: string;
      };
      if (candidate.type !== HostMessageTypes.ProviderProvisioningExecute) return;
      queueMicrotask(() => {
        this.emit("message", {
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: candidate.requestId,
          environmentKey: candidate.environmentKey,
          ...this.provisioningResult,
        });
      });
    });
  }
}

function createWindow(id: number, webContentsId: number) {
  const win = {
    id,
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isDestroyed: () => false,
      send: vi.fn(),
      postMessage: vi.fn(),
    },
  };
  browserWindowMock.windows.push(win);
  return win;
}

const sshTarget: RemoteTarget = {
  kind: "ssh",
  host: "dev.internal",
  username: "developer",
};

function createManager(
  windowHostProcessMap: Map<number, MockUtilityProcess>,
  options?: {
    rendererAttachmentReadyTimeoutMs?: number;
    reportRemoteConnectionStateChanged?: (params: {
      rendererId: number;
      remoteKind: RemoteTarget["kind"];
      transition:
        | "connected"
        | "connection-closed"
        | "disposed"
        | "window-closed"
        | "host-exit"
        | "app-shutdown";
    }) => void;
    reportRemoteDisconnect?: (params: {
      rendererId: number;
      remoteKind: RemoteTarget["kind"];
      disconnectReason:
        | "connection-closed"
        | "disposed"
        | "window-closed"
        | "host-exit"
        | "app-shutdown";
      durationMs: number;
    }) => void;
    monotonicNowMs?: () => number;
    resolveWslTarget?: (
      target: Extract<RemoteTarget, { kind: "wsl" }>,
    ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
    logger?: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  },
) {
  return createRemoteWorkspaceSessionManager({
    logger: options?.logger ?? { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    windowHostProcessMap: windowHostProcessMap as never,
    resolveRemoteAssetDirs: () => ({}),
    resolveWslTarget: options?.resolveWslTarget,
    rendererAttachmentReadyTimeoutMs: options?.rendererAttachmentReadyTimeoutMs,
    reportRemoteConnectionStateChanged: options?.reportRemoteConnectionStateChanged,
    reportRemoteDisconnect: options?.reportRemoteDisconnect,
    monotonicNowMs: options?.monotonicNowMs,
    webRemoteControlManagerRef: { current: null },
  });
}

async function emitConnected(params: {
  child: MockUtilityProcess;
  requestId: string;
  remoteSessionId: string;
  target?: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const target = params.target ?? sshTarget;
  const workspacePath = params.workspacePath ?? "/";
  params.child.emit("message", {
    type: HostResponseTypes.RemoteWorkspaceConnected,
    requestId: params.requestId,
    descriptor: {
      remoteSessionId: params.remoteSessionId,
      target,
      workspacePath,
      workspaceIdentity:
        params.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, target),
      generation: 1,
    },
  });
  // 连接发布前会等待 Environment 首次 Provisioning attempt；测试 Host 在微任务里回包，
  // 这里让完整 Promise 链排空后再检查 renderer attachment。
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function getLatestScopedAttachment(win: ReturnType<typeof createWindow>): {
  attachmentId: string;
  sessionId: string;
} {
  const call = win.webContents.postMessage.mock.calls.findLast(
    ([channel]) => channel === InternalChannels.ScopedServicePort,
  );
  expect(call).toBeDefined();
  return call?.[1] as { attachmentId: string; sessionId: string };
}

function confirmLatestScopedAttachment(
  manager: ReturnType<typeof createManager>,
  win: ReturnType<typeof createWindow>,
): void {
  const payload = getLatestScopedAttachment(win);
  manager.confirmRendererAttachmentReady(win.webContents.id, payload);
}

describe("desktopRemoteSessions R1 window Host forwarding", () => {
  beforeEach(() => {
    browserWindowMock.windows.length = 0;
    channels.length = 0;
    browserWindowMock.fromId.mockClear();
    browserWindowMock.getAllWindows.mockClear();
  });

  it("按 requestId 把窗口 Host 的远程连接进度转发给发起连接的 renderer", () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    void manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    win.webContents.send.mockClear();

    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnectionLog,
      requestId: "connect-1",
      level: "info",
      message: "detecting remote env...",
    });

    expect(win.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.RemoteConnectionLog,
      expect.objectContaining({
        requestId: "connect-1",
        level: "info",
        message: "detecting remote env...",
        timestamp: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/u),
      }),
    );
  });

  it("连接请求发给窗口唯一 Local Host，成功后由同一进程暴露 remote-scoped port", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));

    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: "connect-1",
        target: sshTarget,
      }),
    );

    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });

    let connectionSettled = false;
    void connecting.then(() => {
      connectionSettled = true;
    });
    await Promise.resolve();
    expect(connectionSettled).toBe(false);
    confirmLatestScopedAttachment(manager, win);
    await expect(connecting).resolves.toBe("remote-session-1");
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.AttachServicePort,
        clientMode: "desktop-continuous",
        scope: expect.objectContaining({
          kind: "remote",
          remoteSessionId: "remote-session-1",
          workspaceIdentity: buildRemoteWorkspaceIdentity("/", sshTarget),
        }),
      }),
      expect.any(Array),
    );
    expect(win.webContents.postMessage).toHaveBeenCalledWith(
      InternalChannels.ScopedServicePort,
      expect.objectContaining({
        attachmentId: expect.any(String),
        sessionId: "remote-session-1",
        target: sshTarget,
      }),
      expect.any(Array),
    );
  });

  it.each(["failed", "rollback_failed", "unsupported"] as const)(
    "首次 Provisioning 返回 %s 时拒绝连接且不发布 Renderer port",
    async (status) => {
      const child = new MockUtilityProcess(1001);
      child.provisioningResult = { status, error: "sync unavailable" };
      const win = createWindow(1, 101);
      const manager = createManager(new Map([[101, child]]));

      const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
      await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });

      await expect(connecting).rejects.toThrow(/Provider Provisioning/u);
      expect(win.webContents.postMessage).not.toHaveBeenCalledWith(
        InternalChannels.ScopedServicePort,
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("已连接后的 Provisioning 失败只记录结构化 warning，不拆除 Workspace", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = createManager(new Map([[101, child]]), { logger });
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "connect-1",
      undefined,
      { remoteUsageTelemetryEligible: true },
    );
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    child.provisioningResult = { status: "failed", error: "token=secret-value" };
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningSourceChanged,
      trigger: "personal-config",
    });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "[provider-provisioning] Environment sync did not apply",
      expect.objectContaining({
        environmentKey: expect.any(String),
        trigger: "personal-config",
        status: "failed",
      }),
    );
    expect(logger.warn.mock.calls.at(-1)?.[1]).not.toHaveProperty("errorSummary");
    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 1,
      activeTargetCount: 1,
    });
  });

  it.each([undefined, "source-read-failed"])(
    "首次同步失败把安全错误码 %s 写入日志和连接面板，不泄漏自由文本",
    async (errorCode) => {
      const child = new MockUtilityProcess(1001);
      child.provisioningResult = { status: "failed", error: "token=fixture-secret", errorCode };
      const win = createWindow(1, 101);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const manager = createManager(new Map([[101, child]]), { logger });
      const connecting = manager.createRemoteWorkspaceSession(
        win as never,
        sshTarget,
        "connect-diagnostic",
      );
      const outcome = connecting.catch((error: Error) => error.message);
      await emitConnected({
        child,
        requestId: "connect-diagnostic",
        remoteSessionId: "remote-diagnostic",
      });
      const code = errorCode ?? "target-apply-failed";
      expect(logger.warn).toHaveBeenCalledWith(
        "[provider-provisioning] Environment sync did not apply",
        expect.objectContaining({
          trigger: "environment-online",
          status: "failed",
          errorCode: code,
        }),
      );
      expect(await outcome).toContain(code);
      expect(win.webContents.send).toHaveBeenCalledWith(
        PlatformChannels.RemoteConnectionLog,
        expect.objectContaining({
          requestId: "connect-diagnostic",
          level: "error",
          message: expect.stringContaining(code),
        }),
      );
      expect(
        JSON.stringify([logger.warn.mock.calls, win.webContents.send.mock.calls, await outcome]),
      ).not.toContain("fixture-secret");
      expect(win.webContents.postMessage).not.toHaveBeenCalled();
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: HostMessageTypes.DisposeRemoteWorkspaceSession }),
      );
    },
  );

  it("只在 eligible 连接完成 renderer ACK 后计入并发并上报 connected gauge", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const reportRemoteConnectionStateChanged = vi.fn();
    const reportRemoteDisconnect = vi.fn();
    const manager = createManager(new Map([[101, child]]), {
      reportRemoteConnectionStateChanged,
      reportRemoteDisconnect,
    });

    const eligible = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "connect-eligible",
      undefined,
      { remoteUsageTelemetryEligible: true },
    );
    await emitConnected({
      child,
      requestId: "connect-eligible",
      remoteSessionId: "remote-eligible",
    });
    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 0,
      activeTargetCount: 0,
    });
    confirmLatestScopedAttachment(manager, win);
    await eligible;

    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 1,
      activeTargetCount: 1,
    });
    expect(reportRemoteConnectionStateChanged).toHaveBeenCalledWith({
      rendererId: 101,
      remoteKind: "ssh",
      transition: "connected",
    });

    const internal = manager.createRemoteWorkspaceSession(
      win as never,
      { kind: "docker", container: "internal-only" },
      "connect-internal",
    );
    await emitConnected({
      child,
      requestId: "connect-internal",
      remoteSessionId: "remote-internal",
      target: { kind: "docker", container: "internal-only" },
    });
    confirmLatestScopedAttachment(manager, win);
    await internal;

    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 1,
      activeTargetCount: 1,
    });
    manager.disposeRemoteWorkspaceSession("remote-internal", "internal-finished");
    expect(reportRemoteConnectionStateChanged).toHaveBeenCalledOnce();
    expect(reportRemoteDisconnect).not.toHaveBeenCalled();
  });

  it("连接异常关闭后上报一次 after-state gauge 与时长，随后 dispose 不重复", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    let now = 100;
    const reportRemoteConnectionStateChanged = vi.fn();
    const reportRemoteDisconnect = vi.fn();
    const manager = createManager(new Map([[101, child]]), {
      monotonicNowMs: () => now,
      reportRemoteConnectionStateChanged,
      reportRemoteDisconnect,
    });
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "connect-1",
      undefined,
      { remoteUsageTelemetryEligible: true },
    );
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    now = 600;
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "remote-session-1",
      reason: "connection-closed",
      exitCode: 255,
      signal: null,
    });

    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 0,
      activeTargetCount: 0,
    });
    expect(reportRemoteConnectionStateChanged).toHaveBeenNthCalledWith(2, {
      rendererId: 101,
      remoteKind: "ssh",
      transition: "connection-closed",
    });
    expect(reportRemoteDisconnect).toHaveBeenCalledWith({
      rendererId: 101,
      remoteKind: "ssh",
      disconnectReason: "connection-closed",
      durationMs: 500,
    });

    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
    expect(reportRemoteConnectionStateChanged).toHaveBeenCalledTimes(2);
    expect(reportRemoteDisconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ["window-closed", "window"],
    ["host-exit", "host"],
    ["app-shutdown", "app"],
  ] as const)("%s 退出 eligible route 时上报对应终态", async (reason, owner) => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    let now = 10;
    const reportRemoteConnectionStateChanged = vi.fn();
    const reportRemoteDisconnect = vi.fn();
    const manager = createManager(new Map([[101, child]]), {
      monotonicNowMs: () => now,
      reportRemoteConnectionStateChanged,
      reportRemoteDisconnect,
    });
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "connect-1",
      undefined,
      { remoteUsageTelemetryEligible: true },
    );
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    now = 210;

    if (owner === "window") manager.disposeRemoteWorkspaceSessionsForWindow(101);
    else if (owner === "host") child.emit("exit");
    else await manager.disposeAllAndWaitForAppShutdown("app-quit");

    expect(reportRemoteConnectionStateChanged).toHaveBeenLastCalledWith({
      rendererId: 101,
      remoteKind: "ssh",
      transition: reason,
    });
    expect(reportRemoteDisconnect).toHaveBeenCalledWith({
      rendererId: 101,
      remoteKind: "ssh",
      disconnectReason: reason,
      durationMs: 200,
    });
    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 0,
      activeTargetCount: 0,
    });
  });

  it("按脱敏 target identity 去重诊断计数，但保留每个逻辑 session", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const targets: RemoteTarget[] = [
      sshTarget,
      sshTarget,
      { kind: "server", url: "ws://studio.example.com/ws" },
      { kind: "server", url: "http://studio.example.com" },
      { kind: "server", url: "wss://studio.example.com/ws" },
      { kind: "server", url: "https://studio.example.com" },
    ];

    for (const [index, target] of targets.entries()) {
      const requestId = `connect-${index}`;
      const remoteSessionId = `remote-${index}`;
      const connecting = manager.createRemoteWorkspaceSession(
        win as never,
        target,
        requestId,
        undefined,
        { remoteUsageTelemetryEligible: true },
      );
      await emitConnected({ child, requestId, remoteSessionId, target });
      confirmLatestScopedAttachment(manager, win);
      await connecting;
    }

    expect(manager.getRemoteConnectionStats()).toEqual({
      activeSessionCount: 6,
      activeTargetCount: 3,
    });
  });

  it("telemetry callback 抛错不改变连接成功或 dispose 结果", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const reportRemoteConnectionStateChanged = vi.fn(() => {
      throw new Error("gauge reporter unavailable");
    });
    const reportRemoteDisconnect = vi.fn(() => {
      throw new Error("disconnect reporter unavailable");
    });
    const manager = createManager(new Map([[101, child]]), {
      reportRemoteConnectionStateChanged,
      reportRemoteDisconnect,
    });
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "connect-1",
      undefined,
      { remoteUsageTelemetryEligible: true },
    );
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });

    expect(() => confirmLatestScopedAttachment(manager, win)).not.toThrow();
    await expect(connecting).resolves.toBe("remote-session-1");
    expect(() =>
      manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed"),
    ).not.toThrow();
    expect(reportRemoteConnectionStateChanged).toHaveBeenCalledTimes(2);
    expect(reportRemoteDisconnect).toHaveBeenCalledOnce();
  });

  it("WSL target 解析期间进入 app shutdown 后不发送迟到连接", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    let resolveWslTarget!: (target: Extract<RemoteTarget, { kind: "wsl" }>) => void;
    const manager = createManager(new Map([[101, child]]), {
      resolveWslTarget: () =>
        new Promise((resolve) => {
          resolveWslTarget = resolve;
        }),
    });
    const target = { kind: "wsl", distro: "Ubuntu" } as const;
    const connecting = manager.createRemoteWorkspaceSession(win as never, target, "connect-wsl");
    await vi.waitFor(() => expect(resolveWslTarget).toBeTypeOf("function"));

    await manager.disposeAllAndWaitForAppShutdown("app-quit");
    const settled = connecting.catch((error: unknown) => error);
    resolveWslTarget(target);
    await Promise.resolve();

    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: HostMessageTypes.ConnectRemoteWorkspace }),
    );
    await expect(settled).resolves.toMatchObject({
      message: expect.stringContaining("应用正在退出"),
    });
  });

  it("两个窗口的连接、descriptor 和 attachment 都发往各自 Local Host", async () => {
    const firstChild = new MockUtilityProcess(1001);
    const secondChild = new MockUtilityProcess(1002);
    const firstWindow = createWindow(1, 101);
    const secondWindow = createWindow(2, 202);
    const manager = createManager(
      new Map([
        [101, firstChild],
        [202, secondChild],
      ]),
    );

    const first = manager.createRemoteWorkspaceSession(
      firstWindow as never,
      sshTarget,
      "connect-first",
    );
    const second = manager.createRemoteWorkspaceSession(
      secondWindow as never,
      sshTarget,
      "connect-second",
    );
    await emitConnected({
      child: firstChild,
      requestId: "connect-first",
      remoteSessionId: "remote-first",
    });
    await emitConnected({
      child: secondChild,
      requestId: "connect-second",
      remoteSessionId: "remote-second",
    });
    confirmLatestScopedAttachment(manager, firstWindow);
    confirmLatestScopedAttachment(manager, secondWindow);

    await expect(first).resolves.toBe("remote-first");
    await expect(second).resolves.toBe("remote-second");
    expect(firstChild.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ remoteSessionId: "remote-second" }),
      }),
      expect.anything(),
    );
    expect(secondChild.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ remoteSessionId: "remote-first" }),
      }),
      expect.anything(),
    );
    const provisioningExecutions = [
      ...firstChild.postMessage.mock.calls,
      ...secondChild.postMessage.mock.calls,
    ].filter(
      ([message]) =>
        (message as { type?: string }).type === HostMessageTypes.ProviderProvisioningExecute,
    );
    expect(provisioningExecutions).toHaveLength(1);
  });

  it("取消 pending connection 只发控制消息，不退出窗口 Host", () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    void manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-cancel");

    manager.cancelPendingRemoteWorkspaceSessionsForWindow(101, "user-cancel", "connect-cancel");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.CancelRemoteWorkspaceConnect,
      requestId: "connect-cancel",
    });
  });

  it("绑定 canonical context 后先更新 Host，再重建 identity-validated renderer port", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    const firstAttachmentId = getLatestScopedAttachment(win).attachmentId;
    child.postMessage.mockClear();

    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      {
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
      },
      101,
    );

    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
    });
    expect(child.postMessage.mock.calls[1]?.[0]).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
      },
    });
    expect(child.postMessage).not.toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: firstAttachmentId,
    });
    confirmLatestScopedAttachment(manager, win);
    await binding;
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: firstAttachmentId,
    });
  });

  it("忽略过期 ready ACK，超时只回收且不提升候选 attachment", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockUtilityProcess(1001);
      const win = createWindow(1, 101);
      const manager = createManager(new Map([[101, child]]), {
        rendererAttachmentReadyTimeoutMs: 10,
      });
      const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
      await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
      const firstAttachment = getLatestScopedAttachment(win);
      confirmLatestScopedAttachment(manager, win);
      await connecting;
      child.postMessage.mockClear();

      const binding = manager.bindRemoteWorkspaceSessionContext(
        "remote-session-1",
        { workspacePath: "/work/demo" },
        101,
      );
      const candidateAttachment = getLatestScopedAttachment(win);
      manager.confirmRendererAttachmentReady(101, firstAttachment);
      const bindingRejection = expect(binding).rejects.toThrow("renderer attachment ready 超时");
      await vi.advanceTimersByTimeAsync(10);

      await bindingRejection;
      expect(child.postMessage).toHaveBeenCalledWith({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: candidateAttachment.attachmentId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("手机与 Bot runtime 都 attachment 到同一个窗口 Local Host", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath: "/work/demo",
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    const mobile = manager.attachRemoteWorkspaceSessionHost({
      windowId: 1,
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity,
      workspaceKey: workspaceIdentity,
      clientMode: "web-remote-replayable",
    });
    const botPort = await manager.createBotRemoteWorkspaceRuntimePort(win as never, {
      target: sshTarget,
      workspacePath: "/work/demo",
      workspaceIdentity,
    });

    expect(mobile.process).toBe(child);
    expect(botPort).toBeDefined();
    expect(child.postMessage).toHaveBeenCalledTimes(2);
    for (const [message] of child.postMessage.mock.calls) {
      expect(message).toMatchObject({
        type: HostMessageTypes.AttachServicePort,
        clientMode: "web-remote-replayable",
        scope: { kind: "remote", remoteSessionId: "remote-session-1" },
      });
    }
  });

  it("renderer reload 只重建 attachment，复用 session 与 Host PID", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "renderer-reload");

    expect(child.pid).toBe(1001);
    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      scope: { kind: "remote", remoteSessionId: "remote-session-1" },
    });
    expect(
      child.postMessage.mock.calls.some(
        ([message]) => message.type === HostMessageTypes.ConnectRemoteWorkspace,
      ),
    ).toBe(false);
    confirmLatestScopedAttachment(manager, win);
  });

  it("连接断开后保留离线路由供 tab dispose，但禁止 reload、手机和 Bot 重新 attachment", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const workspacePath = "/work/demo";
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath,
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath,
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "remote-session-1",
      reason: "connection-closed",
      exitCode: 255,
      signal: null,
    });
    manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "renderer-reload");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: expect.any(String),
    });
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: HostMessageTypes.AttachServicePort }),
      expect.anything(),
    );
    expect(() =>
      manager.attachRemoteWorkspaceSessionHost({
        windowId: 1,
        remoteSessionId: "remote-session-1",
        workspacePath,
        workspaceIdentity,
        workspaceKey: workspaceIdentity,
        clientMode: "web-remote-replayable",
      }),
    ).toThrow("远程 workspace source 当前离线");
    await expect(
      manager.createBotRemoteWorkspaceRuntimePort(win as never, {
        target: sshTarget,
        workspacePath,
        workspaceIdentity,
      }),
    ).rejects.toThrow("未找到可供 Bot attachment 的远程 logical session");

    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      }),
    );
  });

  it("新建连接未带 context 时，手机桥接必须等 UI 绑定选中目录后才能通过 identity 校验", async () => {
    // 回归锁定（3.12.0 手机远控连不上 WSL 项目）：新建连接不带 context，Host descriptor 停留在 "/"，
    // identity 由解析后的 target 生成；UI tab 用未解析 target 生成的 identity 与之不同。
    // BindRemoteWorkspaceSessionContext 是唯一能让 descriptor 与 tab 对齐的入口，缺了它桥接必然被拒。
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const resolvedWslTarget = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;
    const manager = createManager(new Map([[101, child]]), {
      resolveWslTarget: async () => resolvedWslTarget,
    });
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      { kind: "wsl" },
      "connect-wsl",
    );
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    await emitConnected({
      child,
      requestId: "connect-wsl",
      remoteSessionId: "remote-session-1",
      target: resolvedWslTarget,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    const tabIdentity = "remote:wsl:default:/home/dev";
    const attachMobile = () =>
      manager.attachRemoteWorkspaceSessionHost({
        windowId: 1,
        remoteSessionId: "remote-session-1",
        workspacePath: "/home/dev",
        workspaceIdentity: tabIdentity,
        workspaceKey: tabIdentity,
        clientMode: "web-remote-replayable",
      });
    expect(attachMobile).toThrow("远程 workspaceKey 与 logical session 不匹配。");

    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      { workspacePath: "/home/dev", workspaceIdentity: tabIdentity },
      101,
    );
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    confirmLatestScopedAttachment(manager, win);
    await binding;
    child.postMessage.mockClear();

    expect(attachMobile().remoteKind).toBe("wsl");
    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/home/dev",
        workspaceIdentity: tabIdentity,
      },
    });
  });
});
