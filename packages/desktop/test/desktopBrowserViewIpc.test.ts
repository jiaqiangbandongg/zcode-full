import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  registerBrowserDataIpcHandlers: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: h.fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
  },
}));

vi.mock("../src/main/desktopBrowserDataIpc.js", () => ({
  registerBrowserDataIpcHandlers: h.registerBrowserDataIpcHandlers,
}));

describe("desktop BrowserView IPC", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
  });

  it("把 renderer 冻结的 workspace/session ownership 与可信 windowId 一起转发", async () => {
    const attachBrowserGuest = vi.fn().mockResolvedValue({ ok: true, guestGeneration: 1 });
    const sender = { id: "renderer-web-contents" };
    h.fromWebContents.mockReturnValue({ id: 17, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(attachBrowserGuest);

    const handler = h.handlers.get(PlatformChannels.BrowserViewAttachGuest);
    expect(handler).toBeDefined();
    await handler?.(
      { sender },
      {
        key: "browser:owner-tab",
        webContentsId: 42,
        active: true,
        workspaceKey: "remote:ssh:dev:/repo",
        sessionId: "sess-owner",
      },
    );

    expect(attachBrowserGuest).toHaveBeenCalledWith("browser:owner-tab", 42, {
      active: true,
      windowId: 17,
      workspaceKey: "remote:ssh:dev:/repo",
      sessionId: "sess-owner",
    });
  });

  it("把 main 的 scope mismatch 作为结构化 attach 结果返回给 renderer", async () => {
    const attachBrowserGuest = vi.fn().mockResolvedValue({
      ok: false,
      reason: "workspace-mismatch",
    });
    const sender = { id: "renderer-web-contents" };
    h.fromWebContents.mockReturnValue({ id: 18, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(attachBrowserGuest);

    const handler = h.handlers.get(PlatformChannels.BrowserViewAttachGuest);
    const result = await handler?.(
      { sender },
      {
        key: "browser:scope-drift",
        webContentsId: 43,
        active: true,
        workspaceKey: "workspace-b",
        sessionId: "session-b",
      },
    );

    expect(result).toEqual({ ok: false, reason: "workspace-mismatch" });
  });

  it.each([
    ["空 key", { key: "", webContentsId: 43 }],
    ["非正 safe integer webContentsId", { key: "browser:invalid", webContentsId: 0 }],
    ["非整数 webContentsId", { key: "browser:invalid", webContentsId: 1.5 }],
    ["空 workspace scope", { key: "browser:invalid", webContentsId: 43, workspaceKey: " " }],
    ["空 remote scope", { key: "browser:invalid", webContentsId: 43, remoteSessionId: "" }],
    ["空 session scope", { key: "browser:invalid", webContentsId: 43, sessionId: "" }],
  ] as const)("拒绝 attach IPC 的%j", async (_label, payload) => {
    const attachBrowserGuest = vi.fn();
    const sender = { id: "renderer-web-contents" };
    h.fromWebContents.mockReturnValue({ id: 20, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(attachBrowserGuest);

    const handler = h.handlers.get(PlatformChannels.BrowserViewAttachGuest);
    await expect(handler?.({ sender }, payload)).rejects.toThrow();
    expect(attachBrowserGuest).not.toHaveBeenCalled();
  });

  it("guest 重建前只把 sender 绑定的可信 windowId 交给主动 detach", async () => {
    const detachBrowserGuest = vi.fn(() => true);
    const sender = { id: "renderer-web-contents" };
    h.fromWebContents.mockReturnValue({ id: 19, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(undefined, undefined, undefined, {
      detachBrowserGuest,
    });

    const handler = h.handlers.get(PlatformChannels.BrowserViewDetachGuest);
    const detached = await handler?.({ sender }, { key: "browser:owner-tab", webContentsId: 43 });

    expect(detachBrowserGuest).toHaveBeenCalledWith("browser:owner-tab", 43, 19);
    expect(detached).toBe(true);
  });

  it("校验自由尺寸并只允许 renderer 修改自己窗口内的 tab", async () => {
    const updateBrowserGuestViewport = vi.fn();
    const sender = { id: "renderer-web-contents" };
    h.fromWebContents.mockReturnValue({
      id: 23,
      isDestroyed: () => false,
      webContents: { getZoomFactor: () => 1.21 },
    });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(undefined, updateBrowserGuestViewport);

    const handler = h.handlers.get(PlatformChannels.BrowserViewUpdateViewport);
    await handler?.(
      { sender },
      { tabId: "browser:owner-tab", viewport: { width: 375, height: 667 } },
    );
    expect(updateBrowserGuestViewport).toHaveBeenCalledWith(
      "browser:owner-tab",
      { width: 375, height: 667 },
      23,
      1.21,
    );

    await expect(
      handler?.({ sender }, { tabId: "browser:owner-tab", viewport: { width: 319, height: 667 } }),
    ).rejects.toThrow();
  });

  it("只把可信 sender window 的 screenshot surface ready 交给协调器", async () => {
    const reportReady = vi.fn();
    const sender = { id: 700 };
    h.fromWebContents.mockReturnValue({ id: 17, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(undefined, undefined, reportReady);
    const handler = h.listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceReady);
    const payload = {
      requestId: "shot-1",
      workspaceKey: "workspace-1",
      sessionId: "sess-1",
      browserId: "browser-1",
      browserGeneration: 2,
      tabId: "tab-1",
      webContentsId: 42,
      viewport: { width: 1274, height: 720 },
      surfaceScale: 0.625,
    };

    handler?.({ sender }, payload);

    expect(reportReady).toHaveBeenCalledWith(17, 700, payload);
  });

  it("BTL11: 用户关闭只转发可信 sender window 与完整 tab scope", async () => {
    const closeBrowserTab = vi.fn(async () => undefined);
    const sender = { id: 701 };
    h.fromWebContents.mockReturnValue({ id: 31, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(undefined, undefined, undefined, {
      closeBrowserTab,
    });

    const handler = h.handlers.get(PlatformChannels.BrowserViewCloseTabFromRenderer);
    await handler?.(
      { sender },
      {
        tabId: "browser:owner-tab",
        workspaceKey: "remote:ssh:dev:/repo",
        sessionId: "sess-owner",
        remoteSessionId: "remote-1",
      },
    );

    expect(closeBrowserTab).toHaveBeenCalledWith({
      tabId: "browser:owner-tab",
      windowId: 31,
      workspaceKey: "remote:ssh:dev:/repo",
      sessionId: "sess-owner",
      remoteSessionId: "remote-1",
    });
  });

  it("residency、suspend ack 与 restore 查询都绑定可信 sender window", async () => {
    const reportBrowserTabResidency = vi.fn();
    const acknowledgeBrowserTabSuspend = vi.fn();
    const restoreBrowserTabs = vi.fn(async () => [{ tabId: "browser:restored" }]);
    const sender = { id: 702 };
    h.fromWebContents.mockReturnValue({ id: 32, isDestroyed: () => false });
    const { registerBrowserViewIpcHandlers } = await import("../src/main/desktopBrowserViewIpc.js");
    registerBrowserViewIpcHandlers(undefined, undefined, undefined, {
      reportBrowserTabResidency,
      acknowledgeBrowserTabSuspend,
      restoreBrowserTabs,
    });

    const residencyPayload = {
      tabId: "browser:owner-tab",
      workspaceKey: "workspace-a",
      sessionId: "session-a",
      selected: true,
      visible: false,
      currentTask: true,
      loading: false,
    };
    await h.handlers.get(PlatformChannels.BrowserViewReportResidency)?.(
      { sender },
      residencyPayload,
    );
    await h.handlers.get(PlatformChannels.BrowserViewSuspendReady)?.(
      { sender },
      { tabId: "browser:owner-tab", generation: 4 },
    );
    const restored = await h.handlers.get(PlatformChannels.BrowserViewRestoreTabs)?.(
      { sender },
      { workspaceKey: "workspace-a", sessionId: "session-a" },
    );

    expect(reportBrowserTabResidency).toHaveBeenCalledWith({
      ...residencyPayload,
      windowId: 32,
    });
    expect(acknowledgeBrowserTabSuspend).toHaveBeenCalledWith({
      tabId: "browser:owner-tab",
      generation: 4,
      windowId: 32,
    });
    expect(restoreBrowserTabs).toHaveBeenCalledWith({
      workspaceKey: "workspace-a",
      sessionId: "session-a",
      windowId: 32,
    });
    expect(restored).toEqual([{ tabId: "browser:restored" }]);
  });
});
