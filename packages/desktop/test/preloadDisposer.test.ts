import { InternalChannels, PlatformChannels } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 验证 preload bridge 中 onFocusTab / onNewTab / onOpenBrowserUrl / onNewTask / onOpenWorkspace
 * 返回 disposer，调用 disposer 后 ipcRenderer 监听器被正确移除。
 *
 * 因为 preload/index.ts 在模块加载时就调用 contextBridge.exposeInMainWorld，
 * 我们 mock electron 模块，拦截 exposeInMainWorld 的参数来获取暴露的 API。
 */

// 模拟 ipcRenderer 的 on / removeListener
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

/** installArmsRumBridgeIpcForward 会替换 ipcRenderer.send，断言须用此引用 */
const mockIpcSend = vi.fn();
const mockIpcRenderer = {
  on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(handler);
  }),
  removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
    listeners.get(channel)?.delete(handler);
  }),
  send: mockIpcSend,
  invoke: vi.fn(),
};
const mockWebFrame = {
  getZoomFactor: vi.fn(() => 1),
};

let exposedApi: Record<string, (...args: unknown[]) => unknown> = {};
const originalPlatform = process.platform;

function stubProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

vi.mock("electron", () => ({
  contextBridge: {
    // preload 还会暴露插件 UI 沙箱的 zcodePluginSandbox；这里只截获 window.zcode 本身。
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
      if (name === "zcode") exposedApi = api as Record<string, (...args: unknown[]) => unknown>;
    },
    executeInMainWorld: () => false,
  },
  ipcRenderer: mockIpcRenderer,
  webFrame: mockWebFrame,
}));

// 模拟 document.title（updateRendererProcessTitle 需要）
vi.stubGlobal("document", { title: "test" });
vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  postMessage: vi.fn(),
});

afterEach(() => {
  stubProcessPlatform(originalPlatform);
});

beforeEach(() => {
  listeners.clear();
  mockIpcRenderer.on.mockClear();
  mockIpcRenderer.removeListener.mockClear();
  mockIpcSend.mockClear();
  mockIpcRenderer.invoke.mockClear();
  mockWebFrame.getZoomFactor.mockClear();
  mockWebFrame.getZoomFactor.mockReturnValue(1);
  vi.mocked(window.addEventListener).mockClear();
  exposedApi = {};
});

describe("preload IPC disposer", () => {
  // 每个测试动态 import 以触发模块初始化
  async function loadPreload() {
    // 清除缓存以重新执行模块
    vi.resetModules();
    await import("../src/preload/index.js");
    return exposedApi;
  }

  it("onFocusTab 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onFocusTab(callback) as () => void;
    expect(typeof dispose).toBe("function");

    // 验证注册了监听
    expect(mockIpcRenderer.on).toHaveBeenCalled();

    // 调用 dispose
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("preload 初始化时会上报当前窗口控制区 zoom 信息", async () => {
    stubProcessPlatform("darwin");
    mockWebFrame.getZoomFactor.mockReturnValue(1.21);

    await loadPreload();

    expect(mockIpcSend).toHaveBeenCalledWith("zcode:window-controls-overlay-ready", {
      zoomLevel: 2,
      metrics: { leftPaddingPx: 79 },
    });
  });

  it("Windows preload 初始化时会上报反向补偿后的右侧安全区", async () => {
    stubProcessPlatform("win32");
    mockWebFrame.getZoomFactor.mockReturnValue(1.21);

    await loadPreload();

    expect(mockIpcSend).toHaveBeenCalledWith("zcode:window-controls-overlay-ready", {
      zoomLevel: 2,
      metrics: { rightPaddingPx: 112, titleBarHeightPx: 58 },
    });
  });

  it("把 renderer 的 scoped attachment ready ACK 转发给 Main", async () => {
    await loadPreload();
    const messageHandler = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === "message")?.[1] as EventListener | undefined;
    expect(messageHandler).toBeDefined();

    messageHandler?.({
      source: window,
      data: {
        type: InternalChannels.ScopedServicePortReady,
        sessionId: "remote-session-1",
        attachmentId: "attachment-b",
      },
    } as unknown as Event);

    expect(mockIpcSend).toHaveBeenCalledWith(InternalChannels.ScopedServicePortReady, {
      sessionId: "remote-session-1",
      attachmentId: "attachment-b",
    });
  });
  it("onNewTab 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onNewTab(callback) as () => void;
    expect(typeof dispose).toBe("function");
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("onOpenBrowserUrl 返回 disposer 并转发 webview 新页面请求", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onOpenBrowserUrl(callback) as () => void;
    expect(typeof dispose).toBe("function");

    const handlers = Array.from(listeners.get(PlatformChannels.OpenBrowserUrl) ?? []);
    expect(handlers.length).toBe(1);
    handlers[0]?.({}, { disposition: "new-window", url: "https://example.com" });

    expect(callback).toHaveBeenCalledWith({
      disposition: "new-window",
      url: "https://example.com",
    });

    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      handlers[0],
    );
  });

  it("browser screenshot surface bridge 转发 prepare/release，并用 send 上报 ready", async () => {
    const api = await loadPreload();
    const prepare = vi.fn();
    const release = vi.fn();
    const disposePrepare = api.onBrowserViewScreenshotSurfacePrepare(prepare) as () => void;
    const prepareHandler = Array.from(
      listeners.get(PlatformChannels.BrowserViewScreenshotSurfacePrepare) ?? [],
    ).at(-1);
    expect(prepareHandler).toBeDefined();
    const disposeRelease = api.onBrowserViewScreenshotSurfaceRelease(release) as () => void;
    const releaseHandler = Array.from(
      listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceRelease) ?? [],
    ).at(-1);
    expect(releaseHandler).toBeDefined();
    const payload = {
      requestId: "shot-1",
      workspaceKey: "remote:ssh:dev:/repo",
      sessionId: "sess-1",
      browserId: "browser-1",
      browserGeneration: 3,
      tabId: "tab-1",
      webContentsId: 42,
      viewport: { width: 1274, height: 720 },
    };

    prepareHandler?.({}, payload);
    const { viewport: _viewport, ...releasePayload } = payload;
    releaseHandler?.({}, releasePayload);
    const readyPayload = { ...payload, surfaceScale: 0.625 };
    api.browserViewScreenshotSurfaceReady(readyPayload);

    expect(prepare).toHaveBeenCalledWith(payload);
    expect(release).toHaveBeenCalledWith(releasePayload);
    expect(mockIpcSend).toHaveBeenCalledWith(
      PlatformChannels.BrowserViewScreenshotSurfaceReady,
      readyPayload,
    );

    disposePrepare();
    disposeRelease();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      PlatformChannels.BrowserViewScreenshotSurfacePrepare,
      prepareHandler,
    );
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      PlatformChannels.BrowserViewScreenshotSurfaceRelease,
      releaseHandler,
    );

    for (const handler of listeners.get(PlatformChannels.BrowserViewScreenshotSurfacePrepare) ?? []) {
      handler({}, payload);
    }
    for (const handler of listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceRelease) ?? []) {
      handler({}, releasePayload);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("onNewTask 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onNewTask(callback) as () => void;
    expect(typeof dispose).toBe("function");
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("onOpenWorkspace 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onOpenWorkspace(callback) as () => void;
    expect(typeof dispose).toBe("function");
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("onOpenWorkspacePath 晚注册时会回放冷启动目录路径", async () => {
    const api = await loadPreload();
    const handlers = Array.from(listeners.get(PlatformChannels.OpenWorkspacePath) ?? []);
    expect(handlers.length).toBe(1);

    handlers[0]?.({}, "C:\\Users\\demo\\Project A");

    const callback = vi.fn();
    const dispose = api.onOpenWorkspacePath(callback) as () => void;
    expect(callback).toHaveBeenCalledWith("C:\\Users\\demo\\Project A");

    callback.mockClear();
    handlers[0]?.({}, "C:\\Users\\demo\\Project B");
    expect(callback).toHaveBeenCalledWith("C:\\Users\\demo\\Project B");

    callback.mockClear();
    dispose();
    handlers[0]?.({}, "C:\\Users\\demo\\Project C");
    expect(callback).not.toHaveBeenCalled();
  });

  it("syncWindowUnreadCount 会通过对应 IPC 频道上报当前窗口未读数", async () => {
    const api = await loadPreload();

    api.syncWindowUnreadCount(3);

    expect(mockIpcSend).toHaveBeenCalledWith(PlatformChannels.SyncWindowUnreadCount, 3);
  });

  it("onUpdateReady 会在 dispose 后停止接收后续更新", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onUpdateReady(callback) as () => void;
    expect(typeof dispose).toBe("function");

    const handlers = Array.from(listeners.get(PlatformChannels.UpdateReady) ?? []);
    expect(handlers.length).toBeGreaterThan(0);

    for (const handler of handlers) {
      handler({}, "0.1.25");
    }
    expect(callback).toHaveBeenCalledWith("0.1.25");

    callback.mockClear();
    dispose();

    for (const handler of handlers) {
      handler({}, "0.1.26");
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("onUpdateReady 晚注册时会立即回放最近一次版本", async () => {
    const api = await loadPreload();
    const handlers = Array.from(listeners.get(PlatformChannels.UpdateReady) ?? []);
    expect(handlers.length).toBeGreaterThan(0);

    for (const handler of handlers) {
      handler({}, "0.1.25");
    }

    const callback = vi.fn();
    const dispose = api.onUpdateReady(callback) as () => void;
    expect(callback).toHaveBeenCalledWith("0.1.25");
    dispose();
  });

  it("onUpdateReady 缓存会在更新状态变回 idle 后清除", async () => {
    const api = await loadPreload();
    const readyHandlers = Array.from(listeners.get(PlatformChannels.UpdateReady) ?? []);
    const stateHandlers = Array.from(listeners.get(PlatformChannels.UpdateStateChanged) ?? []);
    expect(readyHandlers.length).toBeGreaterThan(0);
    expect(stateHandlers.length).toBeGreaterThan(0);

    for (const handler of readyHandlers) {
      handler({}, "0.1.25");
    }
    const replayBeforeClear = vi.fn();
    const disposeBeforeClear = api.onUpdateReady(replayBeforeClear) as () => void;
    expect(replayBeforeClear).toHaveBeenCalledWith("0.1.25");
    disposeBeforeClear();

    // 修复原因：main 在 staging error 后会广播 idle 清掉 ready；preload 如果继续
    // 缓存旧 UpdateReady，新订阅的 renderer 仍会展示不可安装的“重启以更新”。
    for (const handler of stateHandlers) {
      handler({}, { kind: "idle", enabled: true });
    }

    const replayAfterClear = vi.fn();
    const disposeAfterClear = api.onUpdateReady(replayAfterClear) as () => void;
    expect(replayAfterClear).not.toHaveBeenCalled();
    disposeAfterClear();
  });

  it("onUpdateStateChanged 晚注册时会立即回放最近一次状态", async () => {
    const api = await loadPreload();
    const handlers = Array.from(listeners.get(PlatformChannels.UpdateStateChanged) ?? []);
    expect(handlers.length).toBeGreaterThan(0);

    const payload = {
      kind: "download-progress",
      enabled: false,
      progress: "42",
    };
    for (const handler of handlers) {
      handler({}, payload);
    }

    const callback = vi.fn();
    const dispose = api.onUpdateStateChanged(callback) as () => void;
    expect(callback).toHaveBeenCalledWith(payload);
    dispose();
  });

  it("onPostUpdateReleaseNotes 晚注册时会立即回放最近一次 payload", async () => {
    const api = await loadPreload();
    const handlers = Array.from(listeners.get(PlatformChannels.PostUpdateReleaseNotes) ?? []);
    expect(handlers.length).toBeGreaterThan(0);

    for (const handler of handlers) {
      handler(
        {},
        {
          version: "0.1.25",
          title: "Release v0.1.25",
          markdown: "# Release v0.1.25\n\n- add popup",
        },
      );
    }

    const callback = vi.fn();
    const dispose = api.onPostUpdateReleaseNotes(callback) as () => void;
    expect(callback).toHaveBeenCalledWith({
      version: "0.1.25",
      title: "Release v0.1.25",
      markdown: "# Release v0.1.25\n\n- add popup",
    });
    dispose();
  });

  it("getUpdateState invokes update-state IPC", async () => {
    const api = await loadPreload();

    await api.getUpdateState();

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(PlatformChannels.GetUpdateState);
  });

  it("acknowledgePostUpdateReleaseNotes 会通过对应 IPC 频道回传版本号", async () => {
    const api = await loadPreload();

    await api.acknowledgePostUpdateReleaseNotes("0.1.25");

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      PlatformChannels.AcknowledgePostUpdateReleaseNotes,
      "0.1.25",
    );
  });

  it("dispose 后回调不再被触发", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onFocusTab(callback) as () => void;

    // 获取注册的 handler
    const channel = mockIpcRenderer.on.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("focus"),
    );
    expect(channel).toBeDefined();

    // dispose 后，从 listeners set 中移除
    dispose();
    const handlersAfterDispose = listeners.get(channel![0] as string);
    // handler 应该已经被移除
    expect(handlersAfterDispose?.size ?? 0).toBe(0);
  });
});
