import { beforeEach, describe, expect, it, vi } from "vitest";
import { InternalChannels, PlatformChannels, type RemoteTarget } from "@zcode/shared";
import { isAllowedExternalOpenUrl } from "../src/main/desktopMainIpcRemote.js";

type IpcHandler = (...args: unknown[]) => unknown;
type RemoteIpcOptions = Parameters<
  typeof import("../src/main/desktopMainIpcRemote.js").registerRemoteIpcHandlers
>[0];

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  registerWebRemoteControlIpcHandlers: vi.fn(),
  shellOpenExternal: vi.fn(),
  shellOpenPath: vi.fn(),
  configureRemoteUsageArmsTelemetry: vi.fn(),
  reportRemoteConnectResultToArms: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
  },
  shell: {
    openExternal: h.shellOpenExternal,
    openPath: h.shellOpenPath,
  },
}));

vi.mock("../src/main/desktopNotifications.js", () => ({
  dispatchTaskNotification: vi.fn(),
}));

vi.mock("../src/main/desktopOAuthDeepLink.js", () => ({
  clearOAuthRoutesForWindow: vi.fn(),
  deliverPendingDeepLink: vi.fn(() => false),
  parseOAuthStateRegistration: vi.fn(),
  registerOAuthState: vi.fn(),
}));

vi.mock("../src/main/desktopArmsCustomEvent.js", () => ({
  createFinalArmsCustomEventE2EController: vi.fn(),
  dispatchFinalArmsCustomEvent: vi.fn(),
}));

vi.mock("../src/main/desktopWebRemoteControlIpc.js", () => ({
  registerWebRemoteControlIpcHandlers: h.registerWebRemoteControlIpcHandlers,
}));

vi.mock("../src/main/desktopRemoteUsageArmsTelemetry.js", () => ({
  configureRemoteUsageArmsTelemetry: h.configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms: h.reportRemoteConnectResultToArms,
}));

function createOptions(overrides?: Partial<RemoteIpcOptions>): RemoteIpcOptions {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    appTelemetryRuntime: {
      onRendererReady: vi.fn(),
      syncRendererContext: vi.fn(),
      onOAuthCallbackHandled: vi.fn(),
    },
    appTelemetryCore: {
      reportEvent: vi.fn(async () => {}),
    },
    reportRemoteUsageEvent: vi.fn(),
    armsCustomContext: {
      deviceMid: "device-mid",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "test",
    },
    webRemoteControlManager: {
      authorizeStart: vi.fn(),
      startAuthorized: vi.fn(),
      resetPairingAuthorized: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
    },
    createRemoteWorkspaceSession: vi.fn(async () => "remote-session-1"),
    disposeRemoteWorkspaceSession: vi.fn(),
    cancelPendingRemoteWorkspaceSessionsForWindow: vi.fn(),
    bindRemoteWorkspaceSessionContext: vi.fn(),
    confirmRendererAttachmentReady: vi.fn(),
    getRemoteConnectionStats: vi.fn(() => ({
      activeSessionCount: 0,
      activeTargetCount: 0,
    })),
    isDockerDaemonAvailable: vi.fn(async () => true),
    listAvailableWSLDistros: vi.fn(async () => []),
    listAvailableDockerContainers: vi.fn(async () => []),
    listSSHConfigAliases: vi.fn(async () => []),
    ...overrides,
  };
}

async function registerHarness(overrides?: Partial<RemoteIpcOptions>) {
  const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
  const options = createOptions(overrides);
  registerRemoteIpcHandlers(options);
  const handler = h.handlers.get(PlatformChannels.ConnectRemote);
  expect(handler).toBeDefined();
  return { handler: handler!, options };
}

describe("remote workspace connect telemetry IPC", () => {
  it("只允许 Web URL 和 file URL 交给系统浏览器", () => {
    expect(isAllowedExternalOpenUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalOpenUrl("file:///tmp/report.html")).toBe(true);
    expect(isAllowedExternalOpenUrl("file:///tmp/report.txt")).toBe(true);
    expect(isAllowedExternalOpenUrl("file:///etc/passwd")).toBe(true);
    expect(isAllowedExternalOpenUrl("data:text/html,hello")).toBe(false);
  });

  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.fromWebContents.mockReturnValue({ id: 17 });
    h.registerWebRemoteControlIpcHandlers.mockReset();
    h.shellOpenExternal.mockReset().mockResolvedValue(undefined);
    h.shellOpenPath.mockReset().mockResolvedValue("");
    h.configureRemoteUsageArmsTelemetry.mockReset();
    h.reportRemoteConnectResultToArms.mockReset();
  });

  it("注册 IPC 时配置 remote usage ARMS reporter", async () => {
    const getRemoteConnectionStats = vi.fn(() => ({
      activeSessionCount: 2,
      activeTargetCount: 1,
    }));
    const { options } = await registerHarness({ getRemoteConnectionStats });

    expect(h.configureRemoteUsageArmsTelemetry).toHaveBeenCalledOnce();
    expect(h.configureRemoteUsageArmsTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        armsCustomContext: {
          deviceMid: "device-mid",
          platform: "darwin",
          appVersion: "1.0.0",
          armsEnv: "test",
        },
        getRemoteConnectionStats,
        sendCustom: expect.any(Function),
        logger: expect.any(Object),
      }),
    );
    expect(h.registerWebRemoteControlIpcHandlers).toHaveBeenCalledWith({
      reportRemoteUsageEvent: expect.any(Function),
      webRemoteControlManager: options.webRemoteControlManager,
    });
  });

  it("只允许 main 进程打开 http/https/file URL", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    listener?.({}, "https://example.com/docs");
    listener?.({}, "http://localhost:3000/index.html");
    listener?.({}, "file:///tmp/secret");
    listener?.({}, "javascript:alert(1)");
    listener?.({}, "not a url");

    expect(h.shellOpenExternal).toHaveBeenCalledTimes(2);
    expect(h.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(h.shellOpenExternal).toHaveBeenCalledWith("http://localhost:3000/index.html");
    await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledWith("/tmp/secret"));
    expect(options.logger.warn).toHaveBeenCalledTimes(2);
  });

  it("keeps Coding Plan PayPal callback openExternal requests in the sender webview", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    const sender = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/agreements/approve"),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    const returnTo = encodeURIComponent(
      "/coding-plan?provider=zai&embedded=app&lang=cn&theme=zai-dark",
    );
    const callbackUrl = `http://localhost:3000/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}&approval_token_id=setup-1`;
    listener?.({ sender }, callbackUrl);

    expect(sender.loadURL).toHaveBeenCalledWith(callbackUrl);
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("uses Coding Plan bridge sourceUrl when routing openExternal callbacks", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    const sender = {
      getURL: vi.fn(() => "file:///Applications/ZCode/index.html"),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    const returnTo = encodeURIComponent(
      "/coding-plan?provider=zai&embedded=app&lang=cn&theme=zai-dark",
    );
    const callbackUrl = `http://localhost:3000/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}&approval_token_id=setup-1`;
    listener?.(
      {
        sender,
        senderFrame: { url: "https://www.sandbox.paypal.com/agreements/approve" },
      },
      {
        sourceUrl: "file:///stale-host-url.html",
        url: callbackUrl,
      },
    );

    expect(sender.loadURL).toHaveBeenCalledWith(callbackUrl);
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("opens cross-origin Coding Plan callback openExternal requests externally", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    const sender = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/agreements/approve"),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    // returnTo 与回调页不同源即应外部打开；用中性域名表达“不同源”，不依赖测试环境域名
    //（开源导出会把测试域名改写成正式域名，回调与 returnTo 就变成同源）。
    const returnTo = encodeURIComponent(
      "https://other-origin.example/coding-plan?provider=zai&embedded=app",
    );
    const callbackUrl = `https://zcode.z.ai/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}`;
    listener?.({ sender }, callbackUrl);

    expect(sender.loadURL).not.toHaveBeenCalled();
    expect(h.shellOpenExternal).toHaveBeenCalledWith(callbackUrl);
  });

  it("把 renderer attachment-ready ACK 转发给对应窗口 session manager", async () => {
    const confirmRendererAttachmentReady = vi.fn();
    await registerHarness({ confirmRendererAttachmentReady });
    const listener = h.listeners.get(InternalChannels.ScopedServicePortReady);

    listener?.(
      { sender: { id: 73 } },
      { sessionId: "remote-session-1", attachmentId: "attachment-b" },
    );

    expect(confirmRendererAttachmentReady).toHaveBeenCalledWith(73, {
      sessionId: "remote-session-1",
      attachmentId: "attachment-b",
    });
  });

  it.each([
    ["ssh", { kind: "ssh", host: "dev.example.com", username: "root" }],
    ["wsl", { kind: "wsl", distro: "Ubuntu" }],
    ["docker", { kind: "docker", container: "dev-container" }],
    ["server", { kind: "server", url: "https://studio.example.com", serverId: "studio" }],
  ] satisfies Array<[RemoteTarget["kind"], RemoteTarget]>)(
    "上报 %s 新建连接成功终态",
    async (remoteKind, target) => {
      const reportRemoteUsageEvent = vi.fn();
      const { handler, options } = await registerHarness({ reportRemoteUsageEvent });

      const result = await handler(
        { sender: { id: 73 } },
        {
          target,
          requestId: "connect-request-1",
          workspacePath: "/workspace/demo",
          workspaceIdentity: `remote:${remoteKind}:identity:/workspace/demo`,
        },
      );

      expect(result).toEqual({ success: true, sessionId: "remote-session-1" });
      expect(reportRemoteUsageEvent).toHaveBeenCalledWith(73, {
        elementName: "remote_workspace_connect_result",
        eventRegion: "remote_workspace",
        eventType: "result",
        eventExtraDetail: {
          result: "success",
          remote_kind: remoteKind,
          connect_trigger: "new",
          error_category: "",
        },
      });
      expect(options.createRemoteWorkspaceSession).toHaveBeenCalledWith(
        expect.anything(),
        target,
        "connect-request-1",
        {
          workspacePath: "/workspace/demo",
          workspaceIdentity: `remote:${remoteKind}:identity:/workspace/demo`,
        },
        { remoteUsageTelemetryEligible: true },
      );
      expect(h.reportRemoteConnectResultToArms).toHaveBeenCalledWith({
        rendererId: 73,
        result: "success",
        remoteKind,
        connectTrigger: "new",
      });
    },
  );

  it("保留 reconnect 触发来源并分类连接失败", async () => {
    const error = Object.assign(new Error("password rejected"), {
      code: "AUTH_FAILED",
    });
    const reportRemoteUsageEvent = vi.fn();
    const { handler } = await registerHarness({
      reportRemoteUsageEvent,
      createRemoteWorkspaceSession: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await handler(
      { sender: { id: 74 } },
      {
        target: { kind: "ssh", host: "dev.example.com", username: "root" },
        connectTrigger: "reconnect",
      },
    );

    expect(result).toEqual({ success: false, error: "password rejected" });
    expect(reportRemoteUsageEvent).toHaveBeenCalledWith(74, {
      elementName: "remote_workspace_connect_result",
      eventRegion: "remote_workspace",
      eventType: "result",
      eventExtraDetail: {
        result: "failure",
        remote_kind: "ssh",
        connect_trigger: "reconnect",
        error_category: "auth",
      },
    });
    expect(h.reportRemoteConnectResultToArms).toHaveBeenCalledWith({
      rendererId: 74,
      result: "failure",
      remoteKind: "ssh",
      connectTrigger: "reconnect",
      errorCategory: "auth",
    });
  });

  it("埋点 reporter 抛错时不改写已经成功的远程连接结果", async () => {
    const reportRemoteUsageEvent = vi.fn(() => {
      throw new Error("telemetry reporter unavailable");
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { handler } = await registerHarness({ logger, reportRemoteUsageEvent });

    const result = await handler(
      { sender: { id: 75 } },
      {
        target: { kind: "docker", container: "dev-container" },
      },
    );

    expect(result).toEqual({ success: true, sessionId: "remote-session-1" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[remote-usage-telemetry] dispatch failed",
      expect.objectContaining({
        elementName: "remote_workspace_connect_result",
      }),
    );
  });

  it("ARMS connect reporter 抛错时不改写已经成功的远程连接结果", async () => {
    h.reportRemoteConnectResultToArms.mockImplementationOnce(() => {
      throw new Error("ARMS reporter unavailable");
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { handler } = await registerHarness({ logger });

    const result = await handler(
      { sender: { id: 76 } },
      { target: { kind: "docker", container: "dev-container" } },
    );

    expect(result).toEqual({ success: true, sessionId: "remote-session-1" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[remote-usage-arms] connect result reporter failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
