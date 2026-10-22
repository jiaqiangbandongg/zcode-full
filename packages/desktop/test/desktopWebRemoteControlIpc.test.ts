import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type WebRemoteControlContext } from "@zcode/shared";
import type { WebRemoteControlStartAuthorization } from "../src/main/webRemoteControlManager.js";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
}));

function withStartAuthorization(manager: {
  start(windowId: number, context: WebRemoteControlContext): Promise<unknown>;
  stop(windowId: number): Promise<void>;
  getStatus(windowId: number): unknown;
}) {
  return {
    ...manager,
    notifyAuthStateChanged: vi.fn(async () => {}),
    authorizeStart: vi.fn(
      (windowId: number, context: WebRemoteControlContext): WebRemoteControlStartAuthorization => ({
        token: `ticket-${windowId}`,
        expiresAt: Date.now() + 30_000,
        windowId,
        workspaceKey: context.workspaceIdentity?.trim() || context.workspacePath,
        ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
      }),
    ),
    startAuthorized: vi.fn(
      (
        windowId: number,
        context: WebRemoteControlContext,
        _authorization: WebRemoteControlStartAuthorization,
      ) => manager.start(windowId, context),
    ),
  };
}

vi.mock("electron", () => ({
  app: {
    getLocale: vi.fn(() => "zh-CN"),
    getPreferredSystemLanguages: vi.fn(() => ["zh-CN"]),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    on: vi.fn((channel: string, listener: IpcHandler) => h.listeners.set(channel, listener)),
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
  },
  dialog: {
    showMessageBox: h.showMessageBox,
  },
}));

describe("Web Remote Control IPC telemetry", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.fromWebContents.mockReturnValue({ id: 17 });
    h.showMessageBox.mockReset();
    h.showMessageBox.mockResolvedValue({ response: 1 });
  });

  it("登录通知仅接受真实窗口与严格payload，不接收renderer指定的凭据或窗口", async () => {
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    const manager = withStartAuthorization({ start: vi.fn(), stop: vi.fn(), getStatus: vi.fn() });
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(),
      webRemoteControlManager: manager,
    });
    const notify = h.listeners.get(PlatformChannels.WebRemoteControlAuthStateChanged)!;
    for (const payload of [
      null,
      {},
      { state: "signed-in", jwt: "secret" },
      { state: "signed-out", windowId: 9 },
    ]) {
      notify({ sender: { id: 73 } }, payload);
    }
    expect(manager.notifyAuthStateChanged).not.toHaveBeenCalled();
    notify({ sender: { id: 73 } }, { state: "signed-in" });
    expect(manager.notifyAuthStateChanged).toHaveBeenCalledWith(17, { state: "signed-in" });
    manager.notifyAuthStateChanged.mockClear();
    h.fromWebContents.mockReturnValue(null);
    notify({ sender: { id: 73 } }, { state: "signed-out" });
    expect(manager.notifyAuthStateChanged).not.toHaveBeenCalled();
  });
  it("显式启动成功后上报本地 workspace 终态", async () => {
    const reportRemoteUsageEvent = vi.fn();
    const start = vi.fn(async () => ({ status: "running" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent,
      webRemoteControlManager: withStartAuthorization({
        start,
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });

    const context = { workspacePath: "/workspace/local" };
    const result = await h.handlers.get(PlatformChannels.StartWebRemoteControl)?.(
      { sender: { id: 73 } },
      context,
    );

    expect(result).toEqual({ status: "running" });
    expect(start).toHaveBeenCalledWith(17, context);
    expect(reportRemoteUsageEvent).toHaveBeenCalledWith(73, {
      elementName: "web_remote_control_start_result",
      eventRegion: "web_remote_control",
      eventType: "result",
      eventExtraDetail: {
        result: "success",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "",
      },
    });
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it("只注册start/stop/status，不再暴露刷新配对IPC", async () => {
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(),
      webRemoteControlManager: withStartAuthorization({
        start: vi.fn(),
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });
    expect([...h.handlers.keys()].sort()).toEqual(
      [
        PlatformChannels.StartWebRemoteControl,
        PlatformChannels.StopWebRemoteControl,
        PlatformChannels.GetWebRemoteControlStatus,
      ].sort(),
    );
  });

  it("启动失败时只上报低基数错误分类并保留原错误", async () => {
    const error = Object.assign(new Error("relay websocket closed"), {
      code: "RELAY_CLOSED",
    });
    const reportRemoteUsageEvent = vi.fn();
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent,
      webRemoteControlManager: withStartAuthorization({
        start: vi.fn(async () => {
          throw error;
        }),
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });

    const operation = h.handlers.get(PlatformChannels.StartWebRemoteControl)?.(
      { sender: { id: 75 } },
      { workspacePath: "/workspace/local" },
    );

    await expect(operation).rejects.toBe(error);
    expect(reportRemoteUsageEvent).toHaveBeenCalledWith(75, {
      elementName: "web_remote_control_start_result",
      eventRegion: "web_remote_control",
      eventType: "result",
      eventExtraDetail: {
        result: "failure",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "relay",
      },
    });
  });

  it("埋点 reporter 抛错时不改写已经成功的启动结果", async () => {
    const loggerFailure = new Error("telemetry reporter unavailable");
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(() => {
        throw loggerFailure;
      }),
      webRemoteControlManager: withStartAuthorization({
        start: vi.fn(async () => ({ status: "running" })),
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });

    const operation = h.handlers.get(PlatformChannels.StartWebRemoteControl)?.(
      { sender: { id: 76 } },
      { workspacePath: "/workspace/local" },
    );

    await expect(operation).resolves.toEqual({ status: "running" });
  });

  it("内部票据只在 manager 提供的目标绑定接口中使用一次", async () => {
    const authorization: WebRemoteControlStartAuthorization = {
      token: "ticket-1",
      expiresAt: Date.now() + 30_000,
      windowId: 17,
      workspaceKey: "/workspace/local",
    };
    const authorizeStart = vi.fn(() => authorization);
    const startAuthorized = vi.fn(async () => ({ status: "running" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(),
      webRemoteControlManager: {
        startAuthorized,
        authorizeStart,
        stop: vi.fn(),
        getStatus: vi.fn(),
      },
    });

    const context = { workspacePath: "/workspace/local" };
    await expect(
      h.handlers.get(PlatformChannels.StartWebRemoteControl)?.({ sender: { id: 78 } }, context),
    ).resolves.toEqual({ status: "running" });
    expect(authorizeStart).toHaveBeenCalledWith(17, context);
    expect(startAuthorized).toHaveBeenCalledWith(17, context, authorization);
  });
});
