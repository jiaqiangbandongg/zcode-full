import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserScreenshotSurfaceCoordinator } from "../src/main/browserView/browserScreenshotSurfaceCoordinator.js";
import type { BrowserGuestExecutionContext } from "../src/main/browserView/browserGuestManager.js";
import type { BrowserWebmRecorderFactory } from "../src/main/browserView/browserVideoRecorder.js";
import type {
  BrowserTabPageStateRecord,
  BrowserTabShellRecord,
} from "../src/main/browserView/browserTabRecoveryStore.js";

type ScreenshotSurfacePrepareInput = Parameters<BrowserScreenshotSurfaceCoordinator["prepare"]>[0];

/**
 * stub guest（普通对象）：仅实现 BrowserGuestManager / executor 用到的成员。
 * 通过 mock electron 的 webContents.fromId(id) 按 id 返回对应 stub。
 */
interface GuestSpy {
  zoomFactor: number;
  destroyed: boolean;
  attached: boolean;
  url: string;
  title: string;
  loadedUrl: string | null;
  loadUrlError: Error | null;
  reloaded: boolean;
  lastScript: string | null;
  cdpCalls: Array<{ method: string; params?: unknown }>;
  capturePageCalls: number;
  capturePageData: Buffer;
  detachCalls: number;
  closeCalls: number;
  stopCalls: number;
  audible: boolean;
  beingCaptured: boolean;
  historyEntries: Array<{ url: string; title?: string; pageState?: string }>;
  historyActiveIndex: number;
  historyRestoreCalls: Array<{
    entries: Array<{ url: string; title?: string; pageState?: string }>;
    index: number;
  }>;
  historyRestoreErrorBeforeApply: Error | null;
  historyRestoreErrorAfterApply: Error | null;
  sessionRemoveAfterDestroyCalls: number;
  throwOnSessionRemove: boolean;
  /** debugger.detach() 抛出的错误；模拟 guest 已销毁/已被 DevTools 抢占的情形。 */
  throwOnDebuggerDetach: Error | null;
  /** guest 销毁后仍调用 debugger.removeListener 的次数。 */
  debuggerRemoveAfterDestroyCalls: number;
  /** 让 debugger.removeListener 抛错；模拟最坏情况下摘监听也失败。 */
  throwOnDebuggerRemove: boolean;
  viewport: { width: number; height: number };
}

const SNAPSHOT_RESULT = {
  url: "https://x",
  title: "X",
  truncated: false,
  elements: [
    {
      ref: "e1",
      tag: "button",
      selector: "button",
      xpath: "/button",
      rect: { x: 0, y: 0, width: 10, height: 10 },
      inViewport: true,
    },
  ],
};

function pngHeaderBase64(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

function makeGuest(id: number, spy: GuestSpy) {
  const destroyedListeners: Array<() => void> = [];
  const webContentsListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const messageListeners: Array<(event: unknown, method: string, params: unknown) => void> = [];
  const downloadListeners: Array<(event: unknown, item: unknown, contents: unknown) => void> = [];
  const guest = {
    id,
    getZoomFactor: () => spy.zoomFactor,
    setZoomFactor: (factor: number) => {
      spy.zoomFactor = factor;
    },
    getType: () => "webview",
    isDestroyed: () => spy.destroyed,
    loadURL: async (url: string) => {
      spy.loadedUrl = url;
      if (spy.loadUrlError) throw spy.loadUrlError;
    },
    getURL: () => spy.url,
    getTitle: () => spy.title,
    reload: () => {
      spy.reloaded = true;
    },
    stop: () => {
      spy.stopCalls += 1;
    },
    executeJavaScript: async (script: string) => {
      spy.lastScript = script;
      if (script === "({ width: window.innerWidth, height: window.innerHeight })") {
        return { ...spy.viewport };
      }
      return SNAPSHOT_RESULT;
    },
    capturePage: async () => {
      spy.capturePageCalls += 1;
      return {
        toPNG: () => spy.capturePageData,
      };
    },
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
      getAllEntries: () => spy.historyEntries.map((entry) => ({ ...entry })),
      getActiveIndex: () => spy.historyActiveIndex,
      restore: async (input: {
        entries: Array<{ url: string; title?: string; pageState?: string }>;
        index: number;
      }) => {
        if (spy.historyRestoreErrorBeforeApply) throw spy.historyRestoreErrorBeforeApply;
        spy.historyRestoreCalls.push({
          entries: input.entries.map((entry) => ({ ...entry })),
          index: input.index,
        });
        spy.historyEntries = input.entries.map((entry) => ({ ...entry }));
        spy.historyActiveIndex = input.index;
        spy.url = input.entries[input.index]?.url ?? spy.url;
        if (spy.historyRestoreErrorAfterApply) throw spy.historyRestoreErrorAfterApply;
      },
    },
    isCurrentlyAudible: () => spy.audible,
    isBeingCaptured: () => spy.beingCaptured,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const listeners = webContentsListeners.get(event) ?? [];
      listeners.push(listener);
      webContentsListeners.set(event, listeners);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      const listeners = webContentsListeners.get(event);
      if (!listeners) return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    close: () => {
      spy.closeCalls += 1;
      spy.destroyed = true;
      for (const listener of destroyedListeners) listener();
    },
    debugger: {
      isAttached: () => spy.attached,
      attach: () => {
        spy.attached = true;
      },
      detach: () => {
        spy.detachCalls += 1;
        if (spy.throwOnDebuggerDetach) throw spy.throwOnDebuggerDetach;
        spy.attached = false;
      },
      sendCommand: async (method: string, params?: unknown) => {
        // 真实 Electron 里未 attach 就 sendCommand 会抛 "must be called after debugger is
        // attached"；模拟该行为以覆盖 turnEnded 释放 CDP 后的 lazy re-attach 路径。
        if (!spy.attached) throw new Error("This method must be called after debugger is attached");
        spy.cdpCalls.push({ method, params });
        if (method === "Emulation.setDeviceMetricsOverride") {
          const metrics = params as { width: number; height: number };
          spy.viewport = { width: metrics.width, height: metrics.height };
        } else if (method === "Emulation.clearDeviceMetricsOverride") {
          spy.viewport = { width: 800, height: 600 };
        } else if (method === "Page.getLayoutMetrics") {
          return {
            visualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: spy.viewport.width * 2,
              clientHeight: spy.viewport.height * 2,
            },
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: spy.viewport.width,
              clientHeight: spy.viewport.height,
            },
          };
        }
        return { data: "PNGDATA" };
      },
      on: (_event: string, listener: (event: unknown, method: string, params: unknown) => void) => {
        messageListeners.push(listener);
      },
      removeListener: (
        _event: string,
        listener: (event: unknown, method: string, params: unknown) => void,
      ) => {
        // 真实 Electron 里 debugger 是 EventEmitter，removeListener 是纯 JS 操作，guest 销毁后
        // 依然可用（不像 detach/sendCommand 会抛 "Object has been destroyed"）。这正是
        // 「销毁后也必须摘监听」得以成立的前提，所以默认不抛。
        if (spy.destroyed) spy.debuggerRemoveAfterDestroyCalls += 1;
        if (spy.throwOnDebuggerRemove) throw new TypeError("Object has been destroyed");
        const index = messageListeners.indexOf(listener);
        if (index >= 0) messageListeners.splice(index, 1);
      },
    },
    session: {
      on: (
        _event: string,
        listener: (event: unknown, item: unknown, contents: unknown) => void,
      ) => {
        downloadListeners.push(listener);
      },
      removeListener: (
        _event: string,
        listener: (event: unknown, item: unknown, contents: unknown) => void,
      ) => {
        if (spy.destroyed) {
          spy.sessionRemoveAfterDestroyCalls += 1;
          throw new TypeError("Object has been destroyed");
        }
        if (spy.throwOnSessionRemove) throw new TypeError("Object has been destroyed");
        const index = downloadListeners.indexOf(listener);
        if (index >= 0) downloadListeners.splice(index, 1);
      },
    },
    once: (_event: string, listener: () => void) => {
      destroyedListeners.push(listener);
    },
    /** 测试辅助：模拟 guest 销毁，触发 destroyed 监听。 */
    __emitDestroyed: () => {
      spy.destroyed = true;
      for (const l of destroyedListeners) l();
    },
    /** 测试辅助：模拟一条 CDP 事件消息，触发 debugger.on("message") 监听。 */
    __emitCdpMessage: (method: string, params: unknown) => {
      for (const l of messageListeners) l({}, method, params);
    },
    /** 测试辅助：当前仍挂在 debugger 上的 "message" 监听数量。 */
    __cdpMessageListenerCount: () => messageListeners.length,
    __emitDownload: (path: string, state = "completed") => {
      const doneListeners: Array<(event: unknown, state: string) => void> = [];
      const item = {
        getSavePath: () => path,
        once: (_event: string, listener: (event: unknown, state: string) => void) => {
          doneListeners.push(listener);
        },
      };
      for (const listener of downloadListeners) listener({}, item, guest);
      for (const listener of doneListeners) listener({}, state);
    },
    __emitWebContentsEvent: (event: string, ...args: unknown[]) => {
      for (const listener of webContentsListeners.get(event) ?? []) listener(...args);
    },
    /** 测试辅助：某个 webContents 事件上仍挂着的监听数量。 */
    __webContentsListenerCount: (event: string) => webContentsListeners.get(event)?.length ?? 0,
  };
  return guest;
}

// id → stub guest 的注册表（mock 的 fromId 从这里取）。
const guestRegistry = new Map<number, ReturnType<typeof makeGuest>>();

function registerGuest(id: number): {
  guest: ReturnType<typeof makeGuest>;
  spy: GuestSpy;
} {
  const spy: GuestSpy = {
    zoomFactor: 1,
    destroyed: false,
    attached: false,
    url: "about:blank",
    title: "",
    loadedUrl: null,
    loadUrlError: null,
    reloaded: false,
    lastScript: null,
    cdpCalls: [],
    capturePageCalls: 0,
    capturePageData: Buffer.from("SURFACE"),
    detachCalls: 0,
    closeCalls: 0,
    stopCalls: 0,
    audible: false,
    beingCaptured: false,
    historyEntries: [],
    historyActiveIndex: 0,
    historyRestoreCalls: [],
    historyRestoreErrorBeforeApply: null,
    historyRestoreErrorAfterApply: null,
    sessionRemoveAfterDestroyCalls: 0,
    throwOnSessionRemove: false,
    throwOnDebuggerDetach: null,
    debuggerRemoveAfterDestroyCalls: 0,
    throwOnDebuggerRemove: false,
    viewport: { width: 800, height: 600 },
  };
  const guest = makeGuest(id, spy);
  guestRegistry.set(id, guest);
  return { guest, spy };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function restoredShellRecord(
  tabId: string,
  restoreUrl: string | null = `https://example.com/${tabId}`,
): BrowserTabShellRecord {
  return {
    schemaVersion: 1,
    tabId,
    windowBindingId: null,
    workspaceKey: "/repo",
    sessionId: "session-a",
    browserId: "unclaimed-iab",
    browserGeneration: 0,
    origin: "user",
    lifecycle: "active",
    restoreUrl,
    title: tabId,
    faviconUrl: null,
    viewport: null,
    openedAt: 1,
    lastSelectedAt: null,
    updatedAt: 1,
  };
}

function restoredPageState(tabId: string): BrowserTabPageStateRecord {
  return {
    schemaVersion: 1,
    tabId,
    entries: [
      { url: `https://example.com/${tabId}/first`, pageState: "first-state" },
      { url: `https://example.com/${tabId}`, pageState: "active-state" },
    ],
    activeIndex: 1,
    updatedAt: 1,
  };
}

vi.mock("electron", () => ({
  webContents: {
    fromId: (id: number) => guestRegistry.get(id),
  },
}));

// 动态 import 以确保 mock 生效。
const { BrowserGuestManager, sanitizeBrowserMetaUrl } =
  await import("../src/main/browserView/browserGuestManager.js");

type BrowserGuestManagerInstance = InstanceType<typeof BrowserGuestManager>;

beforeEach(() => {
  guestRegistry.clear();
});

function createReadyScreenshotSurfaceCoordinator() {
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const coordinator = {
    prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => {
      const release = vi.fn();
      releases.push(release);
      return {
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      };
    }),
  } satisfies BrowserScreenshotSurfaceCoordinator;
  return { coordinator, releases };
}

describe("BrowserGuestManager", () => {
  it("response meta URL removes credentials, query, and hash", () => {
    expect(sanitizeBrowserMetaUrl("https://user:secret@example.com/private?q=token#fragment")).toBe(
      "https://example.com/private",
    );
    expect(sanitizeBrowserMetaUrl("https://example.com/?q=token#fragment")).toBe(
      "https://example.com",
    );
    expect(sanitizeBrowserMetaUrl("not a URL")).toBeUndefined();
  });

  it("attachGuest 后 execute getState → ok:true state.url 来自 stub guest", async () => {
    const { spy } = registerGuest(1);
    spy.url = "https://example.com";
    spy.title = "Example";
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("k1", 1);
    const r = await mgr.execute("k1", { method: "getState" });
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://example.com");
    expect(r.state?.title).toBe("Example");
    // attach 时调 debugger.attach。
    expect(spy.attached).toBe(true);
  });

  it("BVR01: 同一 WebView 异步录制动作并在 status 返回 WebM 元数据", async () => {
    registerGuest(401);
    const { coordinator, releases } = createReadyScreenshotSurfaceCoordinator();
    const onViewportChanged = vi.fn();
    const createRecorder = vi.fn(async ({ outputPath }) => ({
      stop: vi.fn(async () => {
        await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, "webm"));
      }),
      cancel: vi.fn(async () => undefined),
    }));
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onViewportChanged,
      undefined,
      coordinator,
      { recording: { createRecorder } },
    );
    mgr.attachGuest("recording-tab", 401, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    const context = {
      requestId: "recording-start",
      browserId: "unclaimed-iab",
      browserGeneration: 0,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      clientMode: "desktop-continuous" as const,
    };

    const started = await mgr.execute(context, {
      method: "recordingStart",
      options: {
        viewport: { width: 800, height: 600 },
        settleMs: 100,
        maxDurationMs: 5_000,
        showCursor: false,
        actions: [{ type: "move", x: 200, y: 160, durationMs: 0 }],
      },
      tabId: "recording-tab",
    });
    expect(started.recording).toMatchObject({ status: "running", phase: "preparing" });
    const recordingId = started.recording!.id;

    await vi.waitFor(() => {
      expect(createRecorder).toHaveBeenCalledOnce();
    });
    expect(onViewportChanged).toHaveBeenCalledWith(
      { width: 800, height: 600 },
      expect.objectContaining({ sessionId: "session-a" }),
      "recording-tab",
    );
    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        surfaceScaleMode: "unscaled",
        viewport: { width: 800, height: 600 },
      }),
    );

    await vi.waitFor(async () => {
      const status = await mgr.execute(
        { ...context, requestId: "recording-status" },
        { method: "recordingStatus", recordingId, tabId: "recording-tab" },
      );
      expect(status.recording).toMatchObject({
        id: recordingId,
        status: "completed",
        phase: "completed",
        artifact: { mimeType: "video/webm", width: 800, height: 600 },
      });
    });
    expect(createRecorder).toHaveBeenCalledOnce();
    expect(releases[0]).toHaveBeenCalled();
  });

  describe("录制作业的 scope 隔离与生命周期", () => {
    const RECORDING_CONTEXT: BrowserGuestExecutionContext = {
      requestId: "recording-start",
      browserId: "unclaimed-iab",
      browserGeneration: 0,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      clientMode: "desktop-continuous",
    };

    /**
     * 默认 recorder 的 stop 永不返回，配合长 settleMs 让作业停在 capturing，
     * 这样 scope 隔离与生命周期取消都能观察到真实的 running → cancelled 迁移。
     */
    function createRecordingHarness(
      guestId: number,
      options: {
        createRecorder?: BrowserWebmRecorderFactory;
        surface?: { invalidated?: AbortSignal; webContentsIdOffset?: number };
      } = {},
    ) {
      registerGuest(guestId);
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      const coordinator = {
        prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => {
          const release = vi.fn();
          releases.push(release);
          return {
            surfaceScale: 1,
            webContentsId: input.webContentsId + (options.surface?.webContentsIdOffset ?? 0),
            viewport: input.viewport,
            ...(options.surface?.invalidated ? { invalidated: options.surface.invalidated } : {}),
            release,
          };
        }),
      } satisfies BrowserScreenshotSurfaceCoordinator;
      const cancels: Array<ReturnType<typeof vi.fn>> = [];
      const createRecorder = vi.fn(
        options.createRecorder ??
          (async () => {
            const cancel = vi.fn(async () => undefined);
            cancels.push(cancel);
            return {
              stop: vi.fn(() => new Promise<void>(() => undefined)),
              cancel,
            };
          }),
      );
      const mgr = new BrowserGuestManager(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        coordinator,
        { recording: { createRecorder } },
      );
      mgr.attachGuest("record-tab", guestId, {
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      });
      return { mgr, createRecorder, coordinator, releases, cancels };
    }

    function startRecording(
      mgr: BrowserGuestManagerInstance,
      context: Partial<BrowserGuestExecutionContext> = {},
    ) {
      return mgr.execute(
        { ...RECORDING_CONTEXT, ...context },
        {
          method: "recordingStart",
          options: { settleMs: 30_000, maxDurationMs: 60_000, showCursor: false },
          tabId: "record-tab",
        },
      );
    }

    function readStatus(
      mgr: BrowserGuestManagerInstance,
      recordingId: string,
      context: Partial<BrowserGuestExecutionContext> = {},
      tabId: string | undefined = "record-tab",
    ) {
      return mgr.execute(
        { ...RECORDING_CONTEXT, requestId: `status:${recordingId}`, ...context },
        { method: "recordingStatus", recordingId, ...(tabId ? { tabId } : {}) },
      );
    }

    it("BVR03: 其它 session 查不到别人的录制状态，也拿不到 artifact", async () => {
      const { mgr } = createRecordingHarness(430);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;

      const foreign = await readStatus(mgr, recordingId, {
        sessionId: "session-b",
      });

      expect(foreign.ok).toBe(false);
      expect(foreign.error).toMatchObject({
        code: "backend_unavailable",
        sideEffect: "none",
      });
      expect(foreign.recording).toBeUndefined();
    });

    it("BVR03: 其它 session 取消不了别人的录制，原作业继续运行", async () => {
      const { mgr } = createRecordingHarness(431);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;

      const foreignCancel = await mgr.execute(
        { ...RECORDING_CONTEXT, requestId: "foreign-cancel", sessionId: "session-b" },
        { method: "recordingCancel", recordingId, tabId: "record-tab" },
      );

      expect(foreignCancel.ok).toBe(false);
      expect(foreignCancel.recording).toBeUndefined();
      const owner = await readStatus(mgr, recordingId);
      expect(owner.recording).toMatchObject({ id: recordingId, status: "running" });
    });

    it("BVR03: 同一 session 用错 tabId 查询同样 fail closed", async () => {
      const { mgr } = createRecordingHarness(432);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;

      const wrongTab = await readStatus(mgr, recordingId, {}, "other-tab");

      expect(wrongTab.ok).toBe(false);
      expect(wrongTab.error?.message).toContain("does not belong to tab 'other-tab'");
      expect(wrongTab.recording).toBeUndefined();
    });

    it("BVR05: 同一 tab 重复 start 返回 execution_error，第一个作业不受影响", async () => {
      const { mgr, createRecorder } = createRecordingHarness(433);
      const first = await startRecording(mgr);
      const firstId = first.recording!.id;
      await vi.waitFor(() => {
        expect(createRecorder).toHaveBeenCalledOnce();
      });

      const second = await startRecording(mgr, { requestId: "recording-start-2" });

      expect(second.ok).toBe(false);
      expect(second.error).toMatchObject({ code: "execution_error", sideEffect: "none" });
      expect(second.error?.message).toContain(firstId);
      expect(second.recording).toBeUndefined();
      // 第二次请求不得再起一个 recorder，也不得把第一个作业挤掉。
      expect(createRecorder).toHaveBeenCalledOnce();
      const owner = await readStatus(mgr, firstId);
      expect(owner.recording).toMatchObject({ id: firstId, status: "running" });
    });

    it("BVR04: turn 结束取消进行中的录制并释放 surface lease", async () => {
      const { mgr, createRecorder, releases, cancels } = createRecordingHarness(434);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;
      await vi.waitFor(() => {
        expect(createRecorder).toHaveBeenCalledOnce();
      });

      mgr.endTurn(RECORDING_CONTEXT);

      const status = await readStatus(mgr, recordingId);
      expect(status.recording).toMatchObject({
        id: recordingId,
        status: "cancelled",
        phase: "cancelled",
      });
      expect(status.recording?.artifact).toBeUndefined();
      await vi.waitFor(() => {
        expect(cancels[0]).toHaveBeenCalled();
        expect(releases[0]).toHaveBeenCalled();
      });
    });

    it("BVR04: session 关闭取消进行中的录制", async () => {
      const { mgr, createRecorder, releases } = createRecordingHarness(435);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;
      await vi.waitFor(() => {
        expect(createRecorder).toHaveBeenCalledOnce();
      });

      mgr.closeSession(RECORDING_CONTEXT);

      const status = await readStatus(mgr, recordingId);
      expect(status.recording).toMatchObject({ status: "cancelled" });
      await vi.waitFor(() => {
        expect(releases[0]).toHaveBeenCalled();
      });
    });

    it("BVR04: window 关闭取消该窗口下的录制", async () => {
      const { mgr, createRecorder, releases } = createRecordingHarness(436);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;
      await vi.waitFor(() => {
        expect(createRecorder).toHaveBeenCalledOnce();
      });

      mgr.closeWindow(1);

      const status = await readStatus(mgr, recordingId);
      expect(status.recording).toMatchObject({ status: "cancelled" });
      await vi.waitFor(() => {
        expect(releases[0]).toHaveBeenCalled();
      });
    });

    it("BVR07: recorder 不可用时作业转 failed 并带出原因，不伪造 artifact", async () => {
      const { mgr, releases } = createRecordingHarness(437, {
        createRecorder: async () => {
          throw new Error("Electron WebM recorder failed: Chromium does not support VP8 WebM");
        },
      });
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;

      await vi.waitFor(async () => {
        const status = await readStatus(mgr, recordingId);
        expect(status.recording).toMatchObject({ status: "failed", phase: "failed" });
      });
      const status = await readStatus(mgr, recordingId);
      expect(status.recording?.error).toContain("Chromium does not support VP8 WebM");
      expect(status.recording?.artifact).toBeUndefined();
      await vi.waitFor(() => {
        expect(releases[0]).toHaveBeenCalled();
      });
    });

    it("BVR09: 录制结束后把 tab viewport 恢复成录制前的值", async () => {
      registerGuest(438);
      const { coordinator } = createReadyScreenshotSurfaceCoordinator();
      const onViewportChanged = vi.fn();
      const createRecorder = vi.fn(async ({ outputPath }) => ({
        stop: vi.fn(async () => {
          await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, "webm"));
        }),
        cancel: vi.fn(async () => undefined),
      }));
      const mgr = new BrowserGuestManager(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onViewportChanged,
        undefined,
        coordinator,
        { recording: { createRecorder } },
      );
      mgr.attachGuest("record-tab", 438, {
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      });
      // 录制前 agent 已经把 tab 固定为 1280×720。
      await mgr.execute(
        { ...RECORDING_CONTEXT, requestId: "viewport-set" },
        { method: "browserViewportSet", width: 1280, height: 720, tabId: "record-tab" },
      );
      onViewportChanged.mockClear();

      const started = await mgr.execute(
        { ...RECORDING_CONTEXT, requestId: "recording-start" },
        {
          method: "recordingStart",
          options: { viewport: { width: 800, height: 600 }, settleMs: 0, showCursor: false },
          tabId: "record-tab",
        },
      );
      const recordingId = started.recording!.id;
      await vi.waitFor(async () => {
        const status = await readStatus(mgr, recordingId);
        expect(status.recording).toMatchObject({ status: "completed" });
      });

      // 录制只是临时借用 viewport，收尾后必须把 tab 交还给录制前的尺寸。
      expect(onViewportChanged).toHaveBeenLastCalledWith(
        { width: 1280, height: 720 },
        expect.objectContaining({ sessionId: "session-a" }),
        "record-tab",
      );
    });

    it("BVR02: surface 在 prepare 返回时已失效，录制直接 failed 且不启动 recorder", async () => {
      const { mgr, createRecorder, releases } = createRecordingHarness(439, {
        surface: { invalidated: AbortSignal.abort(new Error("browser side pane was hidden")) },
      });
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;

      await vi.waitFor(async () => {
        const status = await readStatus(mgr, recordingId);
        expect(status.recording).toMatchObject({ status: "failed" });
      });
      const status = await readStatus(mgr, recordingId);
      expect(status.recording?.error).toContain("browser side pane was hidden");
      expect(status.recording?.artifact).toBeUndefined();
      // 失效的 surface 不能进入编码阶段，也必须把 lease 交回去。
      expect(createRecorder).not.toHaveBeenCalled();
      expect(releases[0]).toHaveBeenCalled();
    });

    it("BVR02: 录制中 surface 失效时中止作业并释放 lease", async () => {
      const surfaceInvalidation = new AbortController();
      const { mgr, createRecorder, releases, cancels } = createRecordingHarness(440, {
        surface: { invalidated: surfaceInvalidation.signal },
      });
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;
      await vi.waitFor(() => {
        expect(createRecorder).toHaveBeenCalledOnce();
      });

      surfaceInvalidation.abort(new Error("browser side pane was hidden"));

      await vi.waitFor(async () => {
        const status = await readStatus(mgr, recordingId);
        expect(status.recording).toMatchObject({ status: "cancelled" });
      });
      await vi.waitFor(() => {
        expect(cancels[0]).toHaveBeenCalled();
        expect(releases[0]).toHaveBeenCalled();
      });
    });

    it("BVR02: surface 指向另一个 webContents 时拒绝录制，不对错误的 guest 取帧", async () => {
      const { mgr, createRecorder, releases } = createRecordingHarness(441, {
        surface: { webContentsIdOffset: 1 },
      });
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;

      await vi.waitFor(async () => {
        const status = await readStatus(mgr, recordingId);
        expect(status.recording).toMatchObject({ status: "failed" });
      });
      const status = await readStatus(mgr, recordingId);
      expect(status.recording?.error).toContain(
        "browser guest changed while preparing recording surface",
      );
      expect(createRecorder).not.toHaveBeenCalled();
      expect(releases[0]).toHaveBeenCalled();
    });

    it("BVR08: clientMode 也是录制作业的隔离维度，web 远程客户端查不到桌面会话的作业", async () => {
      const { mgr, createRecorder } = createRecordingHarness(442);
      const started = await startRecording(mgr);
      const recordingId = started.recording!.id;
      await vi.waitFor(() => {
        expect(createRecorder).toHaveBeenCalledOnce();
      });

      const remote = await readStatus(mgr, recordingId, {
        clientMode: "web-remote-replayable",
      });

      expect(remote.ok).toBe(false);
      expect(remote.recording).toBeUndefined();
      const owner = await readStatus(mgr, recordingId);
      expect(owner.recording).toMatchObject({ id: recordingId, status: "running" });
    });
  });

  it("attachGuest 拒绝主 renderer WebContents，防止 browser 输入写入 composer", async () => {
    const { guest, spy } = registerGuest(206);
    vi.spyOn(guest, "getType").mockReturnValue("window");
    const logs: string[] = [];
    const mgr = new BrowserGuestManager((message) => logs.push(message));

    mgr.attachGuest("renderer-id", 206);
    const result = await mgr.execute("renderer-id", { method: "getState" });

    expect(spy.attached).toBe(false);
    expect(result.ok).toBe(false);
    expect(logs).toContainEqual(expect.stringContaining("reason=not-webview type=window"));
  });

  it("execute navigate 调 guest.loadURL；snapshot 调 guest.executeJavaScript", async () => {
    const { spy } = registerGuest(2);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("k2", 2);

    const nav = await mgr.execute("k2", {
      method: "navigate",
      url: "https://foo.com",
    });
    expect(nav.ok).toBe(true);
    expect(spy.loadedUrl).toBe("https://foo.com");

    const snap = await mgr.execute("k2", { method: "snapshot" });
    expect(snap.ok).toBe(true);
    expect(spy.lastScript).toContain("__zcodeRefs");
    expect(snap.snapshot?.elements[0]?.ref).toBe("e1");
  });

  it("缩放只在 guest CDP 边界换算鼠标坐标，重置后不得残留倍率", async () => {
    const { guest, spy } = registerGuest(601);
    const other = registerGuest(602);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("zoom-tab", 601);
    mgr.attachGuest("other-tab", 602);
    for (const zoom of [1, 1.1, 1.61, 1, 0.826446]) {
      spy.zoomFactor = zoom;
      await mgr.updateViewportFromRenderer("zoom-tab", { width: 1280, height: 720 }, 0, zoom);
      expect(guest.getZoomFactor()).toBe(1);
      spy.cdpCalls.length = 0;
      const result = await mgr.execute("zoom-tab", {
        method: "click",
        tabId: "zoom-tab",
        x: 600,
        y: 400,
      });
      expect(result.ok).toBe(true);
      const scale = Math.max(1, zoom);
      expect(spy.cdpCalls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toEqual([
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseMoved", x: 600 * scale, y: 400 * scale },
        },
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mousePressed",
            x: 600 * scale,
            y: 400 * scale,
            button: "left",
            clickCount: 1,
          },
        },
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseReleased",
            x: 600 * scale,
            y: 400 * scale,
            button: "left",
            clickCount: 1,
          },
        },
      ]);
      spy.cdpCalls.length = 0;
      await mgr.execute("zoom-tab", {
        method: "cuaScroll",
        tabId: "zoom-tab",
        x: 600,
        y: 400,
        scrollX: 30,
        scrollY: -80,
        modifiers: ["Shift"],
      });
      expect(spy.cdpCalls).toContainEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: 600 * scale,
          y: 400 * scale,
          deltaX: 30 * scale,
          deltaY: -80 * scale,
          modifiers: 8,
        },
      });
      spy.cdpCalls.length = 0;
      const path = [
        { x: 100, y: 100 },
        { x: 160, y: 230 },
        { x: 300, y: 200 },
      ];
      await mgr.execute("zoom-tab", { method: "cuaDrag", tabId: "zoom-tab", path });
      const dragMoves = spy.cdpCalls.filter(
        ({ method, params }) =>
          method === "Input.dispatchMouseEvent" &&
          (params as { type: string }).type === "mouseMoved",
      );
      expect(
        dragMoves.map(({ params }) => {
          const event = params as { x: number; y: number };
          return [event.x, event.y];
        }),
      ).toEqual(path.map(({ x, y }) => [x * scale, y * scale]));
    }
    await mgr.execute("other-tab", { method: "click", tabId: "other-tab", x: 600, y: 400 });
    expect(other.spy.cdpCalls).toContainEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 600, y: 400 },
    });
    mgr.closeWindow(0);
  });

  it("idle 后首条截图在 viewport 临界区内恢复 metrics 和 guest zoom，再读取图片尺寸", async () => {
    const { guest, spy } = registerGuest(603);
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("zoom-shot", 603);
    await mgr.updateViewportFromRenderer("zoom-shot", { width: 1280, height: 720 }, 0, 0.9);
    // Chromium detach 会清空 per-session metrics；Electron page zoom 也可能晚于 renderer 回调到达。
    guest.debugger.detach();
    spy.viewport = { width: 1408, height: 792 };
    spy.zoomFactor = 1.1;
    spy.cdpCalls.length = 0;
    const result = await mgr.execute("zoom-shot", { method: "screenshot" });
    expect(result.ok).toBe(true);
    expect(guest.getZoomFactor()).toBe(1);
    const methods = spy.cdpCalls.map(({ method }) => method);
    expect(methods.indexOf("Emulation.setDeviceMetricsOverride")).toBeGreaterThan(-1);
    expect(methods.indexOf("Page.getLayoutMetrics")).toBeGreaterThan(
      methods.indexOf("Emulation.setDeviceMetricsOverride"),
    );
    expect(spy.cdpCalls).toContainEqual({
      method: "Page.captureScreenshot",
      params: {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
      },
    });
    mgr.closeWindow(0);
  });

  it.each([0.5, 1])(
    "桌面放大时 surfaceScale=%s 的 native 截图先恢复 metrics，避免 CDP 平铺缩小的 raster",
    async (surfaceScale) => {
      const { guest, spy } = registerGuest(604);
      const { coordinator } = createReadyScreenshotSurfaceCoordinator();
      coordinator.prepare.mockImplementation(async (input) => {
        return {
          surfaceScale,
          webContentsId: input.webContentsId,
          viewport: input.viewport,
          release: vi.fn(),
        };
      });
      const mgr = new BrowserGuestManager(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => "FIT_PNG",
        coordinator,
      );
      mgr.attachGuest("fit-shot", 604);
      await mgr.updateViewportFromRenderer("fit-shot", { width: 1280, height: 720 }, 0, 1.1);
      guest.debugger.detach();
      spy.viewport = { width: 1408, height: 792 };
      spy.zoomFactor = 1.1;
      spy.cdpCalls.length = 0;
      const capture = guest.capturePage;
      guest.capturePage = async () => {
        expect(spy.viewport).toEqual({ width: 1280, height: 720 });
        return capture();
      };
      const result = await mgr.execute("fit-shot", { method: "screenshot" });
      expect(result).toMatchObject({ ok: true, image: { base64: "FIT_PNG" } });
      expect(
        spy.cdpCalls.some(({ method }) => method === "Emulation.setDeviceMetricsOverride"),
      ).toBe(true);
      expect(spy.cdpCalls.some(({ method }) => method === "Page.captureScreenshot")).toBe(false);
      mgr.closeWindow(0);
    },
  );

  it("自然截图不安装 metrics，并向 renderer 区分自然和显式 viewport", async () => {
    const { guest, spy } = registerGuest(606);
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const prepare = vi.spyOn(coordinator, "prepare");
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("natural-shot", guest.id);
    await expect(mgr.execute("natural-shot", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ viewportMode: "natural" }));
    expect(spy.cdpCalls.some(({ method }) => method === "Emulation.setDeviceMetricsOverride")).toBe(
      false,
    );
    await mgr.updateViewportFromRenderer("natural-shot", { width: 1280, height: 720 }, 0, 1 / 1.21);
    await expect(mgr.execute("natural-shot", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ viewportMode: "emulated" }));
    mgr.closeWindow(0);
  });

  it.each(["replacement", "destroyed"] as const)(
    "%s 后自然 guest 不继承旧 fallback 的 metrics 倍率",
    async (mode) => {
      const old = registerGuest(607);
      const next = registerGuest(608);
      Object.defineProperty(old.guest, "hostWebContents", {
        value: { getZoomFactor: () => 1.1 },
      });
      const { coordinator } = createReadyScreenshotSurfaceCoordinator();
      const mgr = new BrowserGuestManager(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => "FALLBACK_PNG",
        coordinator,
      );
      try {
        old.spy.viewport = { width: 0, height: 0 };
        mgr.attachGuest("replacement-scale", old.guest.id, { active: false });
        await expect(
          mgr.execute("replacement-scale", { method: "screenshot" }),
        ).resolves.toMatchObject({ ok: true });
        expect(old.spy.cdpCalls).toContainEqual({
          method: "Emulation.setDeviceMetricsOverride",
          params: expect.objectContaining({ scale: 1.1 }),
        });
        if (mode === "destroyed") old.guest.__emitDestroyed();
        expect(mgr.attachGuest("replacement-scale", next.guest.id, { active: true }).ok).toBe(true);
        // 自然模式的新 guest 没有 metrics；再次 idle 重连也不能继承旧倍率。
        next.guest.debugger.detach();
        await expect(
          mgr.execute("replacement-scale", { method: "click", x: 300, y: 200 }),
        ).resolves.toMatchObject({ ok: true });
        expect(next.spy.cdpCalls.filter(({ method }) => method.startsWith("Emulation."))).toEqual(
          [],
        );
        expect(
          next.spy.cdpCalls.find(({ method }) => method === "Input.dispatchMouseEvent")?.params,
        ).toEqual({ type: "mouseMoved", x: 300, y: 200 });
      } finally {
        mgr.closeWindow(0);
      }
    },
  );

  it("普通 fallback 在应用放大、热截图和 idle 重连后共用 raster 与输入补偿", async () => {
    const { guest, spy } = registerGuest(605);
    let desktopZoom = 1.1;
    Object.defineProperty(guest, "hostWebContents", {
      value: { getZoomFactor: () => desktopZoom },
    });
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const prepare = vi.spyOn(coordinator, "prepare");
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => "FALLBACK_PNG",
      coordinator,
    );
    spy.viewport = { width: 1280, height: 720 };
    mgr.attachGuest("fallback-zoom", guest.id, { active: false });
    await expect(mgr.execute("fallback-zoom", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });
    spy.viewport = { width: 0, height: 0 };
    for (const phase of ["initial", "hot", "reattach", "reset", "shrink"] as const) {
      if (phase === "hot") desktopZoom = 1.21;
      if (phase === "reattach") guest.debugger.detach();
      if (phase === "reset") desktopZoom = 1;
      if (phase === "shrink") desktopZoom = 1 / 1.21;
      const metricsScale = Math.max(1, desktopZoom);
      spy.zoomFactor = desktopZoom;
      spy.cdpCalls.length = 0;
      const result = await mgr.execute("fallback-zoom", { method: "screenshot" });
      expect(result).toMatchObject({
        ok: true,
        image: { base64: metricsScale > 1 ? "FALLBACK_PNG" : "PNGDATA" },
      });
      expect(prepare).toHaveBeenLastCalledWith(
        expect.objectContaining({ viewportMode: "emulated" }),
      );
      if (phase !== "shrink") {
        const metrics = spy.cdpCalls
          .filter(({ method }) => method === "Emulation.setDeviceMetricsOverride")
          .at(-1);
        expect(metrics?.params).toMatchObject({ width: 1280, height: 720 });
        expect((metrics?.params as { scale?: number } | undefined)?.scale).toBe(
          metricsScale > 1 ? metricsScale : undefined,
        );
      }
      expect(spy.zoomFactor).toBe(1);
      expect(spy.cdpCalls.some(({ method }) => method === "Page.captureScreenshot")).toBe(
        metricsScale === 1,
      );
      await expect(
        mgr.execute("fallback-zoom", { method: "click", x: 1000, y: 600 }),
      ).resolves.toMatchObject({ ok: true });
      expect(spy.cdpCalls).toContainEqual({
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 1000 * metricsScale, y: 600 * metricsScale },
      });
    }
    mgr.closeWindow(0);
  });

  it("显式 screenshot 只返回 image，不生成工具面板 preview meta", async () => {
    registerGuest(205);
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("screenshot-tab", 205);
    const result = await mgr.execute("screenshot-tab", {
      method: "screenshot",
    });
    expect(result.image?.base64).toBe("PNGDATA");
    expect(result.meta).not.toHaveProperty("previewImage");
  });

  it("background screenshot 必须 prepare ready 后才进入 CDP，并在 settle 后 release", async () => {
    const { guest } = registerGuest(209);
    const order: string[] = [];
    const release = vi.fn(() => order.push("release"));
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => {
        order.push("prepare");
        expect(input).toEqual(
          expect.objectContaining({
            requestId: expect.stringMatching(/^legacy:/),
            windowId: 0,
            tabId: "tab-209",
            webContentsId: 209,
            viewport: { width: 800, height: 600 },
            signal: expect.any(AbortSignal),
          }),
        );
        return {
          surfaceScale: 1,
          webContentsId: 209,
          viewport: { width: 800, height: 600 },
          release,
        };
      }),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const sendCommand = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") order.push("capture");
      return sendCommand(method, params);
    };
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-209", 209);

    await expect(mgr.execute("tab-209", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
      image: { base64: "PNGDATA" },
    });
    expect(order).toEqual(["prepare", "capture", "release"]);
  });

  it("Fit surface 截图使用 main guest capturePage，并按逻辑 viewport 归一化", async () => {
    const { spy } = registerGuest(218);
    const order: string[] = [];
    const release = vi.fn(() => order.push("release"));
    const resizeScreenshotToCssPixels = vi.fn(() => {
      order.push("resize");
      return "SURFACE_RESIZED";
    });
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => {
        order.push("prepare");
        return {
          surfaceScale: 0.625,
          webContentsId: input.webContentsId,
          viewport: input.viewport,
          release,
        };
      }),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resizeScreenshotToCssPixels,
      coordinator,
    );
    mgr.attachGuest("tab-218", 218);
    await mgr.updateViewportFromRenderer(
      "tab-218",
      { width: 1280, height: 720 },
      0,
      Math.pow(1.1, -2),
    );
    spy.cdpCalls.length = 0;

    await expect(mgr.execute("tab-218", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
      image: { base64: "SURFACE_RESIZED" },
    });
    expect(spy.capturePageCalls).toBe(1);
    expect(resizeScreenshotToCssPixels).toHaveBeenCalledWith(
      Buffer.from("SURFACE").toString("base64"),
      { width: 1280, height: 720 },
    );
    expect(spy.cdpCalls.some(({ method }) => method === "Page.captureScreenshot")).toBe(false);
    expect(spy.cdpCalls.some(({ method }) => method === "Emulation.setDeviceMetricsOverride")).toBe(
      false,
    );
    expect(order).toEqual(["prepare", "resize", "release"]);
  });

  it("Fit surface 的 main capturePage 失败时仍释放 surface lease", async () => {
    const { guest } = registerGuest(219);
    const release = vi.fn();
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 0.625,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      vi.fn(() => "UNUSED"),
      coordinator,
    );
    mgr.attachGuest("tab-219", 219);
    await mgr.updateViewportFromRenderer(
      "tab-219",
      { width: 1280, height: 720 },
      0,
      Math.pow(1.1, -2),
    );

    guest.capturePage = async () => {
      throw new Error("capturePage failed");
    };

    await expect(mgr.execute("tab-219", { method: "screenshot" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: expect.stringContaining("capturePage failed"),
      },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("第七位 resize 兼容保留，coordinator 从第八位开始门禁 screenshot", async () => {
    registerGuest(212);
    const resizeScreenshotToCssPixels = vi.fn();
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release: vi.fn(),
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resizeScreenshotToCssPixels,
      coordinator,
    );
    mgr.attachGuest("tab-212", 212);

    await expect(mgr.execute("tab-212", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });
    expect(coordinator.prepare).toHaveBeenCalledOnce();
  });

  it("CSS 像素修正完成前保留 lease，完成后才 release", async () => {
    const { guest } = registerGuest(216);
    const release = vi.fn();
    let resolveResize!: (data: string) => void;
    const resizeScreenshotToCssPixels = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveResize = resolve;
        }),
    );
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resizeScreenshotToCssPixels,
      coordinator,
    );
    mgr.attachGuest("tab-216", 216);
    await expect(
      mgr.execute("tab-216", {
        method: "browserViewportSet",
        tabId: "tab-216",
        width: 800,
        height: 600,
      }),
    ).resolves.toMatchObject({ ok: true });

    const sendCommand = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") return { data: pngHeaderBase64(1600, 1200) };
      return sendCommand(method, params);
    };
    const pending = mgr.execute("tab-216", {
      method: "screenshot",
      tabId: "tab-216",
    });
    await vi.waitFor(() => expect(resizeScreenshotToCssPixels).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();

    resolveResize(pngHeaderBase64(800, 600));
    await expect(pending).resolves.toMatchObject({
      ok: true,
      image: { base64: pngHeaderBase64(800, 600) },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("CSS 像素修正 reject 时回退原始截图，并在 settle 后 release", async () => {
    const { guest } = registerGuest(217);
    const release = vi.fn();
    let rejectResize!: (error: Error) => void;
    const resizeScreenshotToCssPixels = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectResize = reject;
        }),
    );
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resizeScreenshotToCssPixels,
      coordinator,
    );
    mgr.attachGuest("tab-217", 217);
    await expect(
      mgr.execute("tab-217", {
        method: "browserViewportSet",
        tabId: "tab-217",
        width: 800,
        height: 600,
      }),
    ).resolves.toMatchObject({ ok: true });

    const originalScreenshot = pngHeaderBase64(1600, 1200);
    const sendCommand = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") return { data: originalScreenshot };
      return sendCommand(method, params);
    };
    const pending = mgr.execute("tab-217", {
      method: "screenshot",
      tabId: "tab-217",
    });
    await vi.waitFor(() => expect(resizeScreenshotToCssPixels).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();

    rejectResize(new Error("resize failed"));
    await expect(pending).resolves.toMatchObject({
      ok: true,
      image: { base64: originalScreenshot },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("CDP 截图错误后仍会 release 已准备的 surface", async () => {
    const { guest } = registerGuest(215);
    const release = vi.fn();
    const resizeScreenshotToCssPixels = vi.fn();
    guest.debugger.sendCommand = async (method: string, params?: unknown) => {
      if (method === "Page.captureScreenshot") throw new Error("capture failed");
      return { data: "PNGDATA", params };
    };
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resizeScreenshotToCssPixels,
      coordinator,
    );
    mgr.attachGuest("tab-215", 215);

    await expect(mgr.execute("tab-215", { method: "screenshot" })).resolves.toMatchObject({
      ok: false,
      error: { code: "execution_error" },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(resizeScreenshotToCssPixels).not.toHaveBeenCalled();
  });

  function createHiddenOwnerWindowHarness(): {
    calls: string[];
    win: {
      isDestroyed(): boolean;
      isVisible(): boolean;
      isMinimized(): boolean;
      isFocused(): boolean;
      getOpacity(): number;
      setOpacity(opacity: number): void;
      setSkipTaskbar(skip: boolean): void;
      showInactive(): void;
      hide(): void;
      on(event: "focus", listener: () => void): void;
      removeListener(event: "focus", listener: () => void): void;
    };
  } {
    let opacity = 0.72;
    let visible = false;
    const calls: string[] = [];
    const focusListeners: Array<() => void> = [];
    return {
      calls,
      win: {
        isDestroyed: () => false,
        isVisible: () => visible,
        isMinimized: () => false,
        isFocused: () => false,
        getOpacity: () => opacity,
        setOpacity: (next: number) => {
          calls.push(`opacity:${next}`);
          opacity = next;
        },
        setSkipTaskbar: (skip: boolean) => {
          calls.push(`skipTaskbar:${skip}`);
        },
        showInactive: () => {
          calls.push("showInactive");
          visible = true;
        },
        hide: () => {
          calls.push("hide");
          visible = false;
        },
        on: (event: "focus", listener: () => void) => {
          if (event === "focus") focusListeners.push(listener);
        },
        removeListener: (event: "focus", listener: () => void) => {
          if (event !== "focus") return;
          const index = focusListeners.indexOf(listener);
          if (index >= 0) focusListeners.splice(index, 1);
        },
      },
    };
  }

  function createHiddenWindowScreenshotManager(
    tabWebContentsId: number,
    owner: ReturnType<typeof createHiddenOwnerWindowHarness>,
    guest?: ReturnType<typeof makeGuest>,
  ) {
    const release = vi.fn();
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
      undefined,
      () => owner.win,
    );
    mgr.attachGuest(`tab-${tabWebContentsId}`, tabWebContentsId);
    return { mgr, release, guest };
  }

  it("隐藏窗口截图期间持有透明 presentation，capture 落定后恢复隐藏", async () => {
    registerGuest(230);
    const owner = createHiddenOwnerWindowHarness();
    const { mgr } = createHiddenWindowScreenshotManager(230, owner);

    await expect(mgr.execute("tab-230", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });

    const calls = owner.calls.filter((call) => !call.startsWith("skipTaskbar"));
    expect(calls[0]).toBe("opacity:0");
    expect(calls[1]).toBe("showInactive");
    expect(calls[calls.length - 2]).toBe("hide");
    expect(calls[calls.length - 1]).toBe("opacity:0.72");
    expect(owner.win.isVisible()).toBe(false);
  });

  it("透明 presentation 下整幅 capture 超过 deadline 快速失败并恢复窗口", async () => {
    vi.useFakeTimers();
    const { guest } = registerGuest(231);
    const owner = createHiddenOwnerWindowHarness();
    const originalSendCommand = guest.debugger.sendCommand;
    guest.debugger.sendCommand = ((method: string, params?: unknown) => {
      if (method === "Page.captureScreenshot") {
        return new Promise<never>(() => undefined);
      }
      return originalSendCommand(method, params);
    }) as typeof guest.debugger.sendCommand;
    const { mgr } = createHiddenWindowScreenshotManager(231, owner, guest);

    const pending = mgr.execute("tab-231", { method: "screenshot" });
    // grace(100ms) + deadline(5s) 都要覆盖
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        code: "timeout",
        message: expect.stringContaining("window was hidden"),
      },
    });

    const calls = owner.calls.filter((call) => !call.startsWith("skipTaskbar"));
    expect(calls).toEqual(["opacity:0", "showInactive", "hide", "opacity:0.72"]);
    expect(owner.win.isVisible()).toBe(false);
    vi.useRealTimers();
  });

  it("透明 presentation 后先等 compositor grace 再发起 capture", async () => {
    vi.useFakeTimers();
    const { spy } = registerGuest(233);
    const owner = createHiddenOwnerWindowHarness();
    const { mgr } = createHiddenWindowScreenshotManager(233, owner);

    const pending = mgr.execute("tab-233", { method: "screenshot" });
    // 推进到 presentation 已建立、grace 未满
    for (let index = 0; index < 99 && !owner.calls.includes("showInactive"); index += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(owner.calls).toContain("showInactive");
    expect(spy.cdpCalls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);

    // grace 到期后才允许发起 capture
    await vi.advanceTimersByTimeAsync(120);
    expect(spy.cdpCalls.some((call) => call.method === "Page.captureScreenshot")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    vi.useRealTimers();
  });

  it("capture 挂起时 abort 让 mutation 落定，后续截图不被 in-flight/队列毒化", async () => {
    const { guest, spy } = registerGuest(232);
    const release = vi.fn();
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-232", 232);
    const originalSendCommand = guest.debugger.sendCommand;
    let captureDispatched = false;
    guest.debugger.sendCommand = ((method: string, params?: unknown) => {
      if (method === "Page.captureScreenshot") {
        captureDispatched = true;
        return new Promise<never>(() => undefined);
      }
      return originalSendCommand(method, params);
    }) as typeof guest.debugger.sendCommand;

    const controller = new AbortController();
    const first = mgr.execute("tab-232", { method: "screenshot" }, controller.signal);
    await vi.waitFor(() => expect(captureDispatched).toBe(true));
    controller.abort();
    await expect(first).resolves.toMatchObject({ ok: false });
    expect(release).toHaveBeenCalledOnce();

    guest.debugger.sendCommand = originalSendCommand;
    await expect(mgr.execute("tab-232", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(spy.capturePageCalls).toBe(0);
  });

  it("连续挂死的 capture 达到硬上限后快速拒绝，旧 capture 落定后自动恢复", async () => {
    const registered = registerGuest(234);
    const logs: string[] = [];
    const lateCaptures: Array<(data: string) => void> = [];
    let captureMode: "hang" | "ok" = "hang";
    let screenshotDispatches = 0;
    registered.guest.debugger.sendCommand = (async (method: string, params?: unknown) => {
      registered.spy.cdpCalls.push({ method, params });
      if (method !== "Page.captureScreenshot") return { data: "PNGDATA" };
      screenshotDispatches += 1;
      if (captureMode === "ok") return { data: "RECOVERED" };
      return new Promise<{ data: string }>((resolve) => {
        lateCaptures.push(resolve);
      });
    }) as typeof registered.guest.debugger.sendCommand;
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const mgr = new BrowserGuestManager(
      (message) => logs.push(message),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-234", 234);

    // 三次截图全部挂死并 abort：重试被允许（自排空语义），abandoned 计数递增到上限
    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const pending = mgr.execute("tab-234", { method: "screenshot" }, controller.signal);
      await vi.waitFor(() => expect(screenshotDispatches).toBe(index + 1));
      controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false });
    }

    // 达到硬上限：不再叠加新的 pending CDP capture，快速失败并提示重开 tab
    await expect(mgr.execute("tab-234", { method: "screenshot" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "timeout",
        message: expect.stringContaining("Reopen the tab"),
      },
    });
    expect(screenshotDispatches).toBe(3);
    expect(logs).toContainEqual(expect.stringContaining("abandonedCaptures=3"));

    // 旧的挂死 capture 真实落定后名额自动回收，无需重开 tab 即可恢复
    captureMode = "ok";
    for (const resolveLateCapture of lateCaptures.splice(0)) resolveLateCapture("LATE");
    await vi.waitFor(() =>
      expect(mgr.execute("tab-234", { method: "screenshot" })).resolves.toMatchObject({
        ok: true,
      }),
    );
    expect(screenshotDispatches).toBeGreaterThan(3);
  });

  it("closeWindow 清理 per-tab 截图状态，复用 tabId 的新 tab 不继承 abandoned 计数", async () => {
    const registered = registerGuest(235);
    const lateCaptures: Array<() => void> = [];
    registered.guest.debugger.sendCommand = (async (method: string, params?: unknown) => {
      registered.spy.cdpCalls.push({ method, params });
      if (method !== "Page.captureScreenshot") return { data: "PNGDATA" };
      return new Promise<never>((_resolve, _reject) => {
        lateCaptures.push(() => {});
      });
    }) as typeof registered.guest.debugger.sendCommand;
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    // attachGuest 未传 windowId 时 owner.windowId 为 0，closeWindow(0) 即可命中
    mgr.attachGuest("tab-235", 235);

    // 三次挂死 + abort 把 abandoned 计数推到上限
    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const pending = mgr.execute("tab-235", { method: "screenshot" }, controller.signal);
      await vi.waitFor(() => expect(lateCaptures.length).toBe(index + 1));
      controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false });
    }

    mgr.closeWindow(0);

    // 同 tabId 重新建 tab（新 guest webContents）：不继承旧计数，截图立即可用；
    // 旧 capture 迟到落定也无副作用
    const reused = registerGuest(236);
    mgr.attachGuest("tab-235", 236);
    reused.guest.debugger.sendCommand = (async (method: string, params?: unknown) => {
      reused.spy.cdpCalls.push({ method, params });
      return { data: "PNGDATA" };
    }) as typeof reused.guest.debugger.sendCommand;
    await expect(mgr.execute("tab-235", { method: "screenshot" })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("prepare 失败时返回 backend_unavailable 且不调用 Page.captureScreenshot", async () => {
    const { spy } = registerGuest(210);
    const coordinator = {
      prepare: vi.fn(async () => {
        throw new Error("surface unavailable");
      }),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-210", 210);

    await expect(mgr.execute("tab-210", { method: "screenshot" })).resolves.toMatchObject({
      ok: false,
      error: { code: "backend_unavailable", sideEffect: "none" },
    });
    expect(spy.cdpCalls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
  });

  it("截图 surface prepare 在既有 viewport mutation 完成后才获取 activity", async () => {
    const { guest } = registerGuest(220);
    let resolveViewportMutation!: () => void;
    const originalSendCommand = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") {
        await new Promise<void>((resolve) => {
          resolveViewportMutation = resolve;
        });
      }
      return originalSendCommand(method, params);
    };
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-220", 220);
    const viewportMutation = mgr.updateViewportFromRenderer(
      "tab-220",
      { width: 1280, height: 720 },
      0,
    );
    await vi.waitFor(() => expect(resolveViewportMutation).toBeDefined());

    const screenshot = mgr.execute("tab-220", { method: "screenshot" });
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.prepare).not.toHaveBeenCalled();

    resolveViewportMutation();
    await viewportMutation;
    await expect(screenshot).resolves.toMatchObject({ ok: true });
    expect(coordinator.prepare).toHaveBeenCalledOnce();
  });

  it("activity 在 Ready 后失效时不返回迟到的成功截图", async () => {
    const { guest } = registerGuest(221);
    let resolveScreenshot!: () => void;
    const originalSendCommand = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") {
        await new Promise<void>((resolve) => {
          resolveScreenshot = resolve;
        });
        return { data: "LATE_PNG" };
      }
      return originalSendCommand(method, params);
    };
    const activityController = new AbortController();
    const release = vi.fn();
    const coordinator = {
      prepare: vi.fn(async (input: ScreenshotSurfacePrepareInput) => ({
        invalidated: activityController.signal,
        surfaceScale: 1,
        webContentsId: input.webContentsId,
        viewport: input.viewport,
        release,
      })),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-221", 221);
    const pending = mgr.execute("tab-221", { method: "screenshot" });
    await vi.waitFor(() => expect(resolveScreenshot).toBeDefined());

    activityController.abort(new Error("browser screenshot activity capture failed"));
    resolveScreenshot();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        code: "backend_unavailable",
        message: expect.stringContaining("activity capture failed"),
        sideEffect: "none",
      },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("prepare 期间 abort 返回 cancelled，协调器收到同一 signal", async () => {
    registerGuest(211);
    let observedSignal: AbortSignal | undefined;
    const coordinator = {
      prepare: vi.fn(
        ({ signal }: ScreenshotSurfacePrepareInput) =>
          new Promise<never>((_resolve, reject) => {
            observedSignal = signal;
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      ),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-211", 211);
    const controller = new AbortController();
    const pending = mgr.execute("tab-211", { method: "screenshot" }, controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("guest replacement during prepare releases old lease and captures neither guest", async () => {
    const first = registerGuest(213);
    const second = registerGuest(214);
    let resolvePrepare!: (lease: {
      surfaceScale: number;
      webContentsId: number;
      viewport: { width: number; height: number };
      release(): void;
    }) => void;
    const release = vi.fn();
    const coordinator = {
      prepare: vi.fn(
        () =>
          new Promise<{
            surfaceScale: number;
            webContentsId: number;
            viewport: { width: number; height: number };
            release(): void;
          }>((resolve) => {
            resolvePrepare = resolve;
          }),
      ),
    } satisfies BrowserScreenshotSurfaceCoordinator;
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("tab-213", 213);
    const pending = mgr.execute("tab-213", { method: "screenshot" });
    await vi.waitFor(() => expect(coordinator.prepare).toHaveBeenCalledOnce());
    mgr.attachGuest("tab-213", 214);
    resolvePrepare({
      surfaceScale: 1,
      webContentsId: 213,
      viewport: { width: 800, height: 600 },
      release,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "backend_unavailable", sideEffect: "none" },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(first.spy.cdpCalls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
    expect(second.spy.cdpCalls.some((call) => call.method === "Page.captureScreenshot")).toBe(
      false,
    );
  });

  it("截图 abort 后立即释放 surface 与 in-flight，同 tab 重入不再被毒化", async () => {
    const registered = registerGuest(207);
    const logs: string[] = [];
    let resolveFirstScreenshot!: () => void;
    let screenshotDispatches = 0;
    registered.guest.debugger.sendCommand = async (method: string, params?: unknown) => {
      registered.spy.cdpCalls.push({ method, params });
      if (method !== "Page.captureScreenshot") return { data: "PNGDATA" };
      screenshotDispatches += 1;
      if (screenshotDispatches === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstScreenshot = resolve;
        });
        return { data: "FIRST" };
      }
      return { data: "RECOVERED" };
    };
    const { coordinator, releases } = createReadyScreenshotSurfaceCoordinator();
    const mgr = new BrowserGuestManager(
      (message) => logs.push(message),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    mgr.attachGuest("screenshot-backpressure", 207);

    const controller = new AbortController();
    const first = mgr.execute(
      "screenshot-backpressure",
      { method: "screenshot" },
      controller.signal,
    );
    await vi.waitFor(() => expect(screenshotDispatches).toBe(1));
    controller.abort();
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
    });
    // Bug 原因（2026-09-06 隐藏窗口挂死）：旧契约把 in-flight 保留到“迟到 settle”，
    // 隐藏窗口下 capture 永不落定就会把该 tab 的截图焊死。abort 现在必须同步解开
    // viewport mutation 队列、surface lease 与 in-flight 槽位。
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledOnce());

    await expect(
      mgr.execute("screenshot-backpressure", { method: "screenshot" }),
    ).resolves.toMatchObject({ ok: true, image: { base64: "RECOVERED" } });
    expect(screenshotDispatches).toBe(2);

    // 迟到的第一份 capture 落定不影响后续截图
    resolveFirstScreenshot();
    await expect(
      mgr.execute("screenshot-backpressure", { method: "screenshot" }),
    ).resolves.toMatchObject({ ok: true });
    expect(screenshotDispatches).toBe(3);
  });

  it("Playwright download event/path 绑定当前 tab，并在完成后返回保存路径", async () => {
    const { guest } = registerGuest(202);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("download-tab", 202);
    const pending = mgr.execute("download-tab", {
      method: "playwright",
      action: { name: "waitForEvent", event: "download", timeoutMs: 1000 },
    });
    await Promise.resolve();
    guest.__emitDownload("/tmp/report.pdf");
    const event = await pending;
    expect(event).toMatchObject({
      ok: true,
      value: { id: expect.stringContaining("iab-download:") },
    });
    const downloadId = (event.value as { id: string }).id;
    await expect(
      mgr.execute("download-tab", {
        method: "playwright",
        action: { name: "downloadPath", downloadId, timeoutMs: 1000 },
      }),
    ).resolves.toMatchObject({ ok: true, value: "/tmp/report.pdf" });
  });

  it("cancelled download does not return a stale save path", async () => {
    const { guest } = registerGuest(204);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("cancelled-download", 204);
    const pending = mgr.execute("cancelled-download", {
      method: "playwright",
      action: { name: "waitForEvent", event: "download", timeoutMs: 1000 },
    });
    await Promise.resolve();
    guest.__emitDownload("/tmp/partial.pdf", "cancelled");
    const event = await pending;
    const downloadId = (event.value as { id: string }).id;
    await expect(
      mgr.execute("cancelled-download", {
        method: "playwright",
        action: { name: "downloadPath", downloadId, timeoutMs: 1000 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "execution_error", message: "download cancelled" },
    });
  });

  it("IAB 明确拒绝 Playwright filechooser", async () => {
    registerGuest(203);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("upload-tab", 203);
    await expect(
      mgr.execute("upload-tab", {
        method: "playwright",
        action: { name: "waitForEvent", event: "filechooser", timeoutMs: 100 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "capability_unsupported" },
    });
  });

  it("握手：先 execute（未 attach）不立即 resolve，随后 attachGuest 使其 resolve ok:true", async () => {
    const { spy } = registerGuest(3);
    spy.url = "https://handshake.com";
    const mgr = new BrowserGuestManager(undefined, 5_000);

    let settled = false;
    const pending = mgr.execute("k3", { method: "getState" }).then((r) => {
      settled = true;
      return r;
    });
    // 微任务队列 flush 一次，确认未立即 settle（在等待 attach）。
    await Promise.resolve();
    expect(settled).toBe(false);

    // attach 后 pending 应 resolve。
    mgr.attachGuest("k3", 3);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://handshake.com");
  });

  it("超时：未 attach 且不 attach → 小超时返回 backend_unavailable", async () => {
    const mgr = new BrowserGuestManager(undefined, 50);
    const r = await mgr.execute("nope", { method: "getState" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("backend_unavailable");
  });

  it("list：attach 两个 key → execute(any, list) 返回两条 tabs 摘要", async () => {
    const a = registerGuest(10);
    a.spy.url = "https://a.com";
    a.spy.title = "A";
    const b = registerGuest(11);
    b.spy.url = "https://b.com";
    b.spy.title = "B";
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("ka", 10);
    mgr.attachGuest("kb", 11);
    mgr.attachGuest("ka", 10, { active: true });

    const r = await mgr.execute("whatever", { method: "list" });
    expect(r.ok).toBe(true);
    expect(r.tabs).toEqual([
      {
        tabId: "ka",
        url: "https://a.com",
        title: "A",
        active: true,
        viewport: { width: 800, height: 600 },
      },
      {
        tabId: "kb",
        url: "https://b.com",
        title: "B",
        viewport: { width: 800, height: 600 },
      },
    ]);
  });

  it("无 tabId 命令优先路由到 active guest，用于读取用户当前可见页面", async () => {
    const session = registerGuest(60);
    session.spy.url = "https://session-default.example";
    const active = registerGuest(61);
    active.spy.url = "https://manual-current.example";
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("session-key", 60);
    mgr.attachGuest("browser:manual", 61, { active: true });

    const r = await mgr.execute("session-key", { method: "getState" });
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://manual-current.example");

    const explicit = await mgr.execute("session-key", {
      method: "getState",
      tabId: "session-key",
    });
    expect(explicit.state?.url).toBe("https://session-default.example");
  });

  it("detach 后 execute → 走握手 pending（guest 没了），小超时返回 backend_unavailable", async () => {
    registerGuest(4);
    const mgr = new BrowserGuestManager(undefined, 50);
    mgr.attachGuest("k4", 4);
    expect(mgr.hasGuest("k4")).toBe(true);

    mgr.detach("k4");
    expect(mgr.hasGuest("k4")).toBe(false);

    const r = await mgr.execute("k4", { method: "getState" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("backend_unavailable");
  });

  it("attachGuest 对不存在的 id 记日志返回，不抛错、不建表", () => {
    const logs: string[] = [];
    const mgr = new BrowserGuestManager((m) => logs.push(m));
    mgr.attachGuest("ghost", 999); // 未注册的 id → fromId 返回 undefined
    expect(mgr.hasGuest("ghost")).toBe(false);
    expect(logs.some((l) => l.includes("attachGuest skip"))).toBe(true);
  });

  it("scope mismatch 返回结构化结果、清理被拒绝 guest，并请求按 owner scope 重绑", () => {
    registerGuest(230);
    const rejected = registerGuest(231);
    const rebinds: string[] = [];
    const mgr = new BrowserGuestManager(undefined, 50, undefined, (tabId) => {
      rebinds.push(tabId);
    });

    expect(
      mgr.attachGuest("scope-tab", 230, {
        windowId: 1,
        workspaceKey: "/workspace-a",
        sessionId: "session-a",
      }),
    ).toMatchObject({ ok: true });

    expect(
      mgr.attachGuest("scope-tab", 231, {
        windowId: 1,
        workspaceKey: "/workspace-b",
        sessionId: "session-a",
      }),
    ).toMatchObject({
      ok: false,
      reason: "workspace-mismatch",
    });
    expect(rejected.spy.closeCalls).toBe(1);
    expect(rebinds).toEqual(["scope-tab"]);
  });

  it("newTab 在首次 guest scope 绑定失败后自动重放 Ready 并自愈", async () => {
    const wrongGuest = registerGuest(232);
    const recoveredGuest = registerGuest(233);
    let manager!: BrowserGuestManager;
    let readyCount = 0;
    manager = new BrowserGuestManager(undefined, 50, undefined, (tabId, owner) => {
      readyCount += 1;
      manager.attachGuest(tabId, readyCount === 1 ? wrongGuest.guest.id : recoveredGuest.guest.id, {
        windowId: owner.windowId,
        workspaceKey: readyCount === 1 ? "/wrong-workspace" : owner.workspaceKey,
        sessionId: owner.sessionId,
      });
    });

    const result = await manager.execute(
      {
        requestId: "scope-recovery-new-tab",
        browserId: "iab-1",
        browserGeneration: 1,
        windowId: 1,
        workspaceKey: "/workspace-a",
        sessionId: "session-a",
        clientMode: "desktop-continuous",
      },
      { method: "newTab" },
    );

    expect(result).toMatchObject({ ok: true });
    expect(readyCount).toBe(2);
    expect(wrongGuest.spy.closeCalls).toBe(1);
    expect(manager.hasGuest(result.tab?.tabId ?? "")).toBe(true);
  });

  it("同 key 换 guest：先 detach 旧的再 attach 新的", () => {
    const old = registerGuest(20);
    const fresh = registerGuest(21);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("kswap", 20);
    expect(old.spy.attached).toBe(true);
    mgr.attachGuest("kswap", 21);
    // 旧 guest 被 detach。
    expect(old.spy.detachCalls).toBe(1);
    expect(fresh.spy.attached).toBe(true);
    expect(mgr.hasGuest("kswap")).toBe(true);
  });

  it("旧 guest 崩溃后下载监听清理失败，仍能绑定替代 guest", () => {
    const old = registerGuest(208);
    const fresh = registerGuest(209);
    const logs: string[] = [];
    const mgr = new BrowserGuestManager((message) => logs.push(message));
    mgr.attachGuest("browser:recover-after-crash", 208);
    old.spy.throwOnSessionRemove = true;

    expect(() => mgr.attachGuest("browser:recover-after-crash", 209)).not.toThrow();
    expect(fresh.spy.attached).toBe(true);
    expect(mgr.hasGuest("browser:recover-after-crash")).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining("download cleanup failed"));
  });

  it("guest destroyed 事件触发自动 detach（从表删除）", () => {
    const g = registerGuest(30);
    const logs: string[] = [];
    const mgr = new BrowserGuestManager((message) => logs.push(message));
    mgr.attachGuest("kdie", 30);
    expect(mgr.hasGuest("kdie")).toBe(true);
    g.guest.__emitDestroyed();
    expect(mgr.hasGuest("kdie")).toBe(false);
    expect(logs).not.toContainEqual(expect.stringContaining("download cleanup failed"));
  });

  it("guest destroyed 重绑后恢复 logical URL，避免替代 guest 永久停在 about:blank", async () => {
    const old = registerGuest(31);
    const replacement = registerGuest(32);
    const restoreUrl = "https://example.com/payment";
    old.spy.url = restoreUrl;
    let mgr!: InstanceType<typeof BrowserGuestManager>;
    let rebindRequests = 0;
    mgr = new BrowserGuestManager(undefined, 50, undefined, (tabId, owner) => {
      rebindRequests += 1;
      queueMicrotask(() =>
        mgr.attachGuest(tabId, replacement.guest.id, {
          windowId: owner.windowId,
          workspaceKey: owner.workspaceKey,
          sessionId: owner.sessionId,
        }),
      );
    });
    mgr.attachGuest("browser:rebind-restore", old.guest.id, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    await mgr.reportResidency({
      tabId: "browser:rebind-restore",
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      selected: true,
      visible: true,
      currentTask: true,
      loading: false,
      restoreUrl,
      title: "Payment",
    });

    old.guest.__emitDestroyed();

    await vi.waitFor(() => expect(replacement.spy.loadedUrl).toBe(restoreUrl));
    expect(rebindRequests).toBe(1);
    expect(mgr.hasGuest("browser:rebind-restore")).toBe(true);
  });

  it("guest rebind 恢复期间 tabs.list 不会把 cachedUrl 污染成 about:blank", async () => {
    const old = registerGuest(33);
    const replacement = registerGuest(34);
    const restoreUrl = "https://example.com/rebind-list";
    const load = createDeferred<void>();
    old.spy.url = restoreUrl;
    replacement.guest.loadURL = async (url: string) => {
      replacement.spy.loadedUrl = url;
      await load.promise;
      replacement.spy.url = url;
    };

    let mgr!: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(undefined, 50, undefined, (tabId) => {
      queueMicrotask(() => mgr.attachGuest(tabId, replacement.guest.id));
    });
    mgr.attachGuest("browser:rebind-list", old.guest.id);

    old.guest.__emitDestroyed();

    await vi.waitFor(() => expect(replacement.spy.loadedUrl).toBe(restoreUrl));
    replacement.guest.__emitWebContentsEvent("did-stop-loading");
    await expect(mgr.execute("browser:rebind-list", { method: "list" })).resolves.toMatchObject({
      ok: true,
      tabs: [{ tabId: "browser:rebind-list", url: restoreUrl }],
    });

    load.resolve();
    await vi.waitFor(() => expect(replacement.spy.url).toBe(restoreUrl));
  });

  // 工单 ZCT-2096525247130722304：后台 tab 截图会经 applyBackgroundViewportFallback 对 guest
  // 施加 CDP setDeviceMetricsOverride（本窗口最近自然尺寸）。旧实现里该 override 的唯一清除
  // 路径是 attachGuest({active:true})，但 guest 存活期间用户切回前台（renderer residency 上报 /
  // activateTab）不会重新 attach，页面就永久钉在 fallback 尺寸（实测 innerWidth/innerHeight 停在
  // 1280×720，窗口 resize/全屏都不跟随）。以下用例锁定两条自愈路径：
  //   1) renderer 前台上报（reportResidency selected=true）触发自然视口恢复；
  //   2) readTabViewport 在前台 tab 命中 fallback 时不再自锁，主动触发恢复。
  describe("后台 fallback viewport 的前台恢复", () => {
    const VIEWPORT_TAB = "tab-viewport-restore";

    function createManagerForViewportRestore() {
      const registered = registerGuest(230);
      const { coordinator } = createReadyScreenshotSurfaceCoordinator();
      const mgr = new BrowserGuestManager(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        coordinator,
      );
      // 纯 legacy scope：execute(tabId) 与 reportResidency 都按 tabId 对齐 owner。
      mgr.attachGuest(VIEWPORT_TAB, registered.guest.id);
      return { guest: registered.guest, spy: registered.spy, mgr };
    }

    /** 先用自然布局 1280×720 建立窗口记忆，再模拟后台 0×0 触发 fallback(1280×720)。 */
    async function seedNaturalViewportThenBackgroundFallback(
      spy: ReturnType<typeof registerGuest>["spy"],
      mgr: InstanceType<typeof BrowserGuestManager>,
    ): Promise<void> {
      spy.viewport = { width: 1280, height: 720 };
      await expect(mgr.execute(VIEWPORT_TAB, { method: "screenshot" })).resolves.toMatchObject({
        ok: true,
      });
      spy.viewport = { width: 0, height: 0 };
      await expect(mgr.execute(VIEWPORT_TAB, { method: "screenshot" })).resolves.toMatchObject({
        ok: true,
      });
      expect(
        spy.cdpCalls.some(
          (call) =>
            call.method === "Emulation.setDeviceMetricsOverride" &&
            (call.params as { width: number }).width === 1280 &&
            (call.params as { height: number }).height === 720,
        ),
      ).toBe(true);
    }

    it("reportResidency(selected=true) 后清除后台 fallback viewport", async () => {
      const { spy, mgr } = createManagerForViewportRestore();
      await seedNaturalViewportThenBackgroundFallback(spy, mgr);

      await mgr.reportResidency({
        tabId: VIEWPORT_TAB,
        workspaceKey: VIEWPORT_TAB,
        sessionId: VIEWPORT_TAB,
        windowId: 0,
        selected: true,
        visible: true,
        currentTask: false,
        loading: false,
      });

      await vi.waitFor(() => {
        expect(
          spy.cdpCalls.some((call) => call.method === "Emulation.clearDeviceMetricsOverride"),
        ).toBe(true);
      });
    });

    it("readTabViewport 在前台 tab 命中 fallback 时主动恢复自然视口", async () => {
      const registered = registerGuest(231);
      const { coordinator } = createReadyScreenshotSurfaceCoordinator();
      const mgr = new BrowserGuestManager(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        coordinator,
      );
      // attach 时带 active=true：tab 处于前台，且后续不再有 attachGuest({active:true})
      // 的机会——正是工单里 override 残留的触发形态。
      mgr.attachGuest(VIEWPORT_TAB, registered.guest.id, { active: true });

      registered.spy.viewport = { width: 1280, height: 720 };
      await expect(mgr.execute(VIEWPORT_TAB, { method: "screenshot" })).resolves.toMatchObject({
        ok: true,
      });
      // 后台期落入 fallback 后（setDeviceMetricsOverride 已生效），前台的下一次
      // viewport 读取必须自愈，而不是「fallback 存在即短路」地自我强化。
      registered.spy.viewport = { width: 0, height: 0 };
      await expect(mgr.execute(VIEWPORT_TAB, { method: "screenshot" })).resolves.toMatchObject({
        ok: true,
      });
      // 第三次读取命中的才是「fallback 已残留」分支：restore 会先 clear override
      // （guest mock 随之回到自然布局 800×600），再读回自然尺寸完成恢复。
      await expect(mgr.execute(VIEWPORT_TAB, { method: "screenshot" })).resolves.toMatchObject({
        ok: true,
      });

      await vi.waitFor(() => {
        expect(
          registered.spy.cdpCalls.some(
            (call) => call.method === "Emulation.clearDeviceMetricsOverride",
          ),
        ).toBe(true);
      });
    });
  });

  // 3.7.3 主进程崩溃（= 整个 app 退出，不是 renderer 白屏）经 minidump 符号化确证落在
  // content::DevToolsSession::DispatchProtocolNotification，client_ 的 vptr 已为 0 —— CDP
  // client 被析构后仍收到在途通知。以下用例锁定 detachGuest 的收口契约：
  //   1) guest 存活 → 必须主动 detach()，这是唯一能断开 native CDP 通路的操作；
  //   2) guest 已销毁 → detach() 已不可能，必须留下打点，否则这条路径在日志里不可见；
  //   3) 任一步失败都不得静默，也不得阻断替代 guest 接管。
  describe("detachGuest CDP 通路收口", () => {
    it("guest 存活时 detach：摘掉 debugger message 监听并主动 detach", () => {
      const g = registerGuest(300);
      const mgr = new BrowserGuestManager();
      mgr.attachGuest("kcdp-alive", 300);
      // attach 时装了 dialog 监听。
      expect(g.guest.__cdpMessageListenerCount()).toBe(1);

      mgr.detach("kcdp-alive");

      expect(g.guest.__cdpMessageListenerCount()).toBe(0);
      expect(g.spy.detachCalls).toBe(1);
      expect(g.spy.attached).toBe(false);
    });

    it("guest 已销毁时 detach：不调 detach() 但仍摘监听，并记录 CDP 未断开", () => {
      const g = registerGuest(301);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcdp-dead", 301);
      expect(g.guest.__cdpMessageListenerCount()).toBe(1);

      // renderer 卸载 webview / guest 崩溃：destroyed 先于 detach 到达。
      g.guest.__emitDestroyed();

      // 已销毁的 guest 上调 detach() 必抛且无意义，所以不调。
      expect(g.spy.detachCalls).toBe(0);
      // 但监听必须摘掉 —— 这是本修复的核心，销毁不等于监听自动失效。
      expect(g.guest.__cdpMessageListenerCount()).toBe(0);
      expect(g.spy.debuggerRemoveAfterDestroyCalls).toBe(1);
      // 打点：带着未断开的 CDP 进入隐式析构，是崩溃前置条件，必须在日志里可见。
      expect(logs).toContainEqual(
        expect.stringContaining("cdp still attached on destroyed guest tabId=kcdp-dead"),
      );
    });

    it("摘监听本身失败时不阻断收口，失败落日志且替代 guest 仍能绑定", () => {
      const old = registerGuest(302);
      const fresh = registerGuest(303);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcdp-removefail", 302);
      old.spy.throwOnDebuggerRemove = true;

      expect(() => mgr.attachGuest("kcdp-removefail", 303)).not.toThrow();
      expect(logs).toContainEqual(expect.stringContaining("cdp message cleanup failed"));
      expect(fresh.spy.attached).toBe(true);
      expect(mgr.hasGuest("kcdp-removefail")).toBe(true);
    });

    it("detach() 抛错不再被静默吞掉：落 warn 日志，状态仍收口", () => {
      const old = registerGuest(304);
      const fresh = registerGuest(305);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcdp-detachfail", 304);
      old.spy.throwOnDebuggerDetach = new Error("debugger detach rejected");

      expect(() => mgr.attachGuest("kcdp-detachfail", 305)).not.toThrow();
      expect(logs).toContainEqual(
        expect.stringContaining("cdp detach failed tabId=kcdp-detachfail"),
      );
      expect(logs).toContainEqual(expect.stringContaining("debugger detach rejected"));
      // 失败也要摘监听，且替代 guest 正常接管。
      expect(old.guest.__cdpMessageListenerCount()).toBe(0);
      expect(fresh.spy.attached).toBe(true);
    });

    // 注意：这条在修复前也是绿的 —— JS 层的 current.guest !== guest 守卫本就拦得住状态污染。
    // 它锁的是「摘监听不能破坏原有守卫语义」，属于防回归，不是修复的证明。
    // native 层的崩溃（DevToolsSession 向已析构 client 派发）JS 侧完全无从观测，单测覆盖不到。
    it("detach 后旧 guest 再发 CDP 弹窗事件，不污染 pendingDialog", async () => {
      const g = registerGuest(306);
      const mgr = new BrowserGuestManager();
      mgr.attachGuest("kcdp-stale", 306);
      mgr.detach("kcdp-stale");

      // 监听已摘除，事件不应再落到任何监听上。
      g.guest.__emitCdpMessage("Page.javascriptDialogOpening", {
        type: "alert",
        message: "幽灵弹窗",
      });

      // 重新绑定新 guest 后，状态必须干净。
      const fresh = registerGuest(307);
      mgr.attachGuest("kcdp-stale", 307);
      const r = await mgr.execute("kcdp-stale", { method: "getDialog" });
      expect(r.ok).toBe(true);
      expect(r.dialog).toBeNull();
      expect(fresh.spy.attached).toBe(true);
    });

    it("guest teardown 等待在途 CDP 完成，并对新命令 fail closed", async () => {
      const g = registerGuest(315);
      const mgr = new BrowserGuestManager();
      mgr.attachGuest("kcdp-lease", 315);

      const pendingEvaluate = createDeferred<void>();
      const originalSendCommand = g.guest.debugger.sendCommand;
      g.guest.debugger.sendCommand = async (method: string, params?: unknown) => {
        if (method === "Runtime.evaluate") {
          g.spy.cdpCalls.push({ method, params });
          await pendingEvaluate.promise;
          return { data: "EVALUATED" };
        }
        return originalSendCommand(method, params);
      };

      const running = mgr.execute("kcdp-lease", {
        method: "playwright",
        tabId: "kcdp-lease",
        action: {
          name: "evaluate",
          expression: "1",
          expressionKind: "string",
          timeoutMs: 5_000,
        },
      });
      await Promise.resolve();
      await vi.waitFor(() => {
        expect(g.spy.cdpCalls.some((call) => call.method === "Runtime.evaluate")).toBe(true);
      });

      const firstTeardown = mgr.detachGuestBeforeReplacement("kcdp-lease", 315, 0);
      const secondTeardown = mgr.detachGuestBeforeReplacement("kcdp-lease", 315, 0);

      // 在途 CDP 未完成前不能释放 debugger，也不能让 renderer 替换 guest。
      expect(g.spy.detachCalls).toBe(0);
      const rejected = await mgr.execute("kcdp-lease", {
        method: "playwright",
        tabId: "kcdp-lease",
        action: {
          name: "evaluate",
          expression: "2",
          expressionKind: "string",
          timeoutMs: 5_000,
        },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.message).toContain("detaching");

      pendingEvaluate.resolve(undefined);
      await expect(Promise.all([firstTeardown, secondTeardown])).resolves.toEqual([true, true]);
      await running;
      expect(g.spy.detachCalls).toBe(1);
      expect(g.spy.attached).toBe(false);
      expect(mgr.hasGuest("kcdp-lease")).toBe(false);
    });
  });

  // 崩溃链条的真正入口。实测（Electron 41.0.3 / forcefullyCrashRenderer）证实三件事：
  //   1. render-process-gone 时 WebContents 还活着：isDestroyed()=false、isAttached()=true，
  //      detach() 能成功执行 —— 这是唯一能主动断开 native CDP 通路的时间窗口；
  //   2. destroyed 时一切都抛 "Object has been destroyed"，那里 detach 已不可能；
  //   3. 崩溃后只要 renderer 不卸载 <webview>，WebContents 就无限期停在 crashed 态并一直
  //      挂着 attached 的 CDP（实测 10s destroyed 未到）；一旦 renderer 递增 generation
  //      卸载 <webview>，destroyed 在 ~5ms 内到达 —— 销毁时机由 renderer 决定。此时
  //      api::Debugger 走隐式析构，
  //      DevToolsSession 仍持 client_ 派发在途通知，即 minidump 里 vptr=0 的 UAF。
  // 所以优先在 main render-process-gone 时 detach，并以 renderer 重建前 ACK 覆盖事件缺失；
  // 两条路径都不能等 destroyed 兜底。
  describe("guest renderer 崩溃时主动断开 CDP", () => {
    it("renderer 重建前只释放同窗口同代 guest，并确认 CDP 已断开", async () => {
      const g = registerGuest(309);
      const mgr = new BrowserGuestManager();
      mgr.attachGuest("kcrash-replace", 309, { windowId: 17 });

      await expect(mgr.detachGuestBeforeReplacement("kcrash-replace", 309, 18)).resolves.toBe(
        false,
      );
      await expect(mgr.detachGuestBeforeReplacement("kcrash-replace", 999, 17)).resolves.toBe(
        false,
      );
      expect(g.spy.detachCalls).toBe(0);
      expect(mgr.hasGuest("kcrash-replace")).toBe(true);

      await expect(mgr.detachGuestBeforeReplacement("kcrash-replace", 309, 17)).resolves.toBe(true);
      expect(g.spy.detachCalls).toBe(1);
      expect(g.spy.attached).toBe(false);
      expect(mgr.hasGuest("kcrash-replace")).toBe(false);
    });

    it("renderer 重建前 CDP detach 失败时 fail closed 并保留旧 guest", async () => {
      const g = registerGuest(308);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcrash-replace-failed", 308, { windowId: 17 });
      g.spy.throwOnDebuggerDetach = new Error("native detach failed");

      await expect(
        mgr.detachGuestBeforeReplacement("kcrash-replace-failed", 308, 17),
      ).resolves.toBe(false);
      expect(mgr.hasGuest("kcrash-replace-failed")).toBe(true);
      expect(logs).toContainEqual(
        expect.stringContaining("replacement cdp detach failed tabId=kcrash-replace-failed"),
      );
    });

    it("render-process-gone 时立即 detach，不等 destroyed", () => {
      const g = registerGuest(310);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcrash-detach", 310);
      expect(g.spy.attached).toBe(true);

      // Chromium 杀掉 guest renderer：WebContents 仍在（destroyed 尚未到达）。
      g.guest.__emitWebContentsEvent("render-process-gone", {}, { reason: "oom" });

      expect(g.spy.detachCalls).toBe(1);
      expect(g.spy.attached).toBe(false);
      expect(logs).toContainEqual(
        expect.stringContaining("cdp detached on render-process-gone tabId=kcrash-detach"),
      );
    });

    it("崩溃已 detach 后，随后到达的 destroyed 不再报「CDP 未断开」", () => {
      const g = registerGuest(311);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcrash-then-destroy", 311);

      g.guest.__emitWebContentsEvent("render-process-gone", {}, { reason: "crashed" });
      // 真实时序：renderer 递增 generation 卸载 <webview>，此刻才销毁。
      g.guest.__emitDestroyed();

      expect(g.spy.detachCalls).toBe(1);
      // CDP 已在崩溃窗口里断开，隐式析构的前置条件不再成立，不该再留这条痕。
      expect(logs).not.toContainEqual(
        expect.stringContaining("cdp still attached on destroyed guest"),
      );
    });

    it("detachGuest 摘掉 render-process-gone 监听，不随 guest 代际累积", () => {
      const old = registerGuest(312);
      const fresh = registerGuest(313);
      const mgr = new BrowserGuestManager();
      mgr.attachGuest("kcrash-gen", 312);
      expect(old.guest.__webContentsListenerCount("render-process-gone")).toBe(1);

      mgr.attachGuest("kcrash-gen", 313);

      expect(old.guest.__webContentsListenerCount("render-process-gone")).toBe(0);
      expect(fresh.guest.__webContentsListenerCount("render-process-gone")).toBe(1);
    });

    it("崩溃窗口里 detach() 抛错不阻断收口，失败落日志", () => {
      const g = registerGuest(314);
      const logs: string[] = [];
      const mgr = new BrowserGuestManager((message) => logs.push(message));
      mgr.attachGuest("kcrash-detachfail", 314);
      g.spy.throwOnDebuggerDetach = new Error("detach rejected during crash");

      expect(() =>
        g.guest.__emitWebContentsEvent("render-process-gone", {}, { reason: "oom" }),
      ).not.toThrow();
      expect(logs).toContainEqual(
        expect.stringContaining("cdp detach on render-process-gone failed"),
      );
      expect(logs).toContainEqual(expect.stringContaining("detach rejected during crash"));
    });
  });

  it("command.tabId 寻址：execute(key, {tabId}) 路由到 tabId 的 guest", async () => {
    const t = registerGuest(40);
    t.spy.url = "https://tab.com";
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("realTab", 40);
    const r = await mgr.execute("sessionKey", {
      method: "getState",
      tabId: "realTab",
    });
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://tab.com");
  });

  it("getDialog：无 pending 时返回 dialog:null；弹窗打开后返回该弹窗信息", async () => {
    const g = registerGuest(50);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("kdlg", 50);

    // 无弹窗 → dialog:null。
    const empty = await mgr.execute("kdlg", { method: "getDialog" });
    expect(empty.ok).toBe(true);
    expect(empty.dialog).toBeNull();

    // attach 时应开启 Page.enable。
    expect(g.spy.cdpCalls.some((c) => c.method === "Page.enable")).toBe(true);

    // 模拟 CDP 弹窗打开事件。
    g.guest.__emitCdpMessage("Page.javascriptDialogOpening", {
      type: "prompt",
      message: "输入名字",
      defaultPrompt: "默认值",
    });
    const opened = await mgr.execute("kdlg", { method: "getDialog" });
    expect(opened.ok).toBe(true);
    expect(opened.dialog).toEqual({
      type: "prompt",
      message: "输入名字",
      defaultPrompt: "默认值",
    });

    // 弹窗关闭事件 → 清除 pending。
    g.guest.__emitCdpMessage("Page.javascriptDialogClosed", { result: true });
    const closed = await mgr.execute("kdlg", { method: "getDialog" });
    expect(closed.dialog).toBeNull();
  });

  it("handleDialog：调用 Page.handleJavaScriptDialog 并清 pending", async () => {
    const g = registerGuest(51);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("khandle", 51);
    g.guest.__emitCdpMessage("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "确认？",
    });

    const r = await mgr.execute("khandle", {
      method: "handleDialog",
      accept: true,
      promptText: "yes",
    });
    expect(r.ok).toBe(true);
    const call = g.spy.cdpCalls.find((c) => c.method === "Page.handleJavaScriptDialog");
    expect(call).toBeDefined();
    expect(call?.params).toEqual({ accept: true, promptText: "yes" });

    // handleDialog 后 pending 应被清除。
    const after = await mgr.execute("khandle", { method: "getDialog" });
    expect(after.dialog).toBeNull();
  });

  it("close：detach guest 且触发 onCloseTabRequested 回调", async () => {
    const g = registerGuest(52);
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(undefined, undefined, (key) => closed.push(key));
    mgr.attachGuest("kclose", 52);
    expect(mgr.hasGuest("kclose")).toBe(true);

    const r = await mgr.execute("kclose", { method: "close" });
    expect(r.ok).toBe(true);
    // detach：从表删除 + CDP detach。
    expect(mgr.hasGuest("kclose")).toBe(false);
    expect(g.spy.detachCalls).toBe(1);
    // 回调收到受控 key。
    expect(closed).toEqual(["kclose"]);
  });

  it("close：tabId 寻址时 detach 并回调的是 effectiveKey（tabId）", async () => {
    registerGuest(53);
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(undefined, undefined, (key) => closed.push(key));
    mgr.attachGuest("realClose", 53);

    const r = await mgr.execute("sessionKey", {
      method: "close",
      tabId: "realClose",
    });
    expect(r.ok).toBe(true);
    expect(mgr.hasGuest("realClose")).toBe(false);
    expect(closed).toEqual(["realClose"]);
  });

  it("按 window/workspace/session scope 隔离 list、active 与显式 tabId", async () => {
    const opened: Array<{ tabId: string; windowId: number }> = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId, owner) =>
      opened.push({ tabId, windowId: owner.windowId }),
    );
    const context = (windowId: number, requestId: string) => ({
      requestId,
      browserId: "iab-1",
      browserGeneration: 7,
      windowId,
      workspaceKey: `/workspace-${windowId}`,
      sessionId: "same-session",
      clientMode: "desktop-continuous" as const,
    });

    const firstPending = mgr.execute(context(1, "req-1"), { method: "newTab" });
    await Promise.resolve();
    const firstTabId = opened.find((entry) => entry.windowId === 1)!.tabId;
    const first = registerGuest(71);
    first.spy.url = "https://one.example";
    mgr.attachGuest(firstTabId, 71, { active: true, windowId: 1 });
    await expect(firstPending).resolves.toMatchObject({
      ok: true,
      tab: { tabId: firstTabId },
    });

    const secondPending = mgr.execute(context(2, "req-2"), {
      method: "newTab",
    });
    await Promise.resolve();
    const secondTabId = opened.find((entry) => entry.windowId === 2)!.tabId;
    const second = registerGuest(72);
    second.spy.url = "https://two.example";
    mgr.attachGuest(secondTabId, 72, { active: true, windowId: 2 });
    await secondPending;

    const firstList = await mgr.execute(context(1, "req-list-1"), {
      method: "list",
    });
    expect(firstList.tabs?.map((tab) => tab.tabId)).toEqual([firstTabId]);
    expect(firstList.meta).toMatchObject({
      browserId: "iab-1",
      browserGeneration: 7,
      openTabIds: [firstTabId],
    });
    const crossScope = await mgr.execute(context(1, "req-cross"), {
      method: "getState",
      tabId: secondTabId,
    });
    expect(crossScope).toMatchObject({
      ok: false,
      error: {
        code: "backend_unavailable",
        message: expect.stringContaining("browser.tabs.get(info.id)"),
      },
    });
    expect(crossScope.error?.message).toContain("browser.user.claimTab(info)");
  });

  it("后台挂载的 scope 仍在 list 暴露唯一可寻址 active tab，与无 tabId 命令落点一致", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId) => opened.push(tabId));
    const context = {
      requestId: "bg-1",
      browserId: "iab-1",
      browserGeneration: 7,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-bg",
      clientMode: "desktop-continuous" as const,
    };
    const newBackgroundTab = async (requestId: string, webContentsId: number, url: string) => {
      const pending = mgr.execute({ ...context, requestId }, { method: "newTab" });
      await Promise.resolve();
      const tabId = opened.at(-1)!;
      const { spy } = registerGuest(webContentsId);
      spy.url = url;
      // 会话在后台跑：renderer 的 isVisible 恒为 false，只会上报 active:false。
      mgr.attachGuest(tabId, webContentsId, { active: false, windowId: 1 });
      await pending;
      return tabId;
    };

    const firstTabId = await newBackgroundTab("bg-new-1", 95, "https://bg-one.example");
    const list = await mgr.execute({ ...context, requestId: "bg-list" }, { method: "list" });
    expect(list.tabs?.filter((tab) => tab.active).map((tab) => tab.tabId)).toEqual([firstTabId]);

    // active 的含义必须与 resolveTab 一致：不带 tabId 的命令要打到同一个 tab 上。
    const routed = await mgr.execute(
      { ...context, requestId: "bg-getstate" },
      { method: "getState" },
    );
    expect(routed).toMatchObject({ ok: true, meta: { tabId: firstTabId } });

    // 再开一个后台 tab 后仍只能有一个 active=true，且回退跟随最近创建的 tab。
    const secondTabId = await newBackgroundTab("bg-new-2", 96, "https://bg-two.example");
    const multi = await mgr.execute({ ...context, requestId: "bg-list-2" }, { method: "list" });
    expect(multi.tabs?.map((tab) => tab.tabId)).toEqual([firstTabId, secondTabId]);
    expect(multi.tabs?.filter((tab) => tab.active).map((tab) => tab.tabId)).toEqual([secondTabId]);
    await expect(
      mgr.execute({ ...context, requestId: "bg-getstate-2" }, { method: "getState" }),
    ).resolves.toMatchObject({ ok: true, meta: { tabId: secondTabId } });

    // 回退不得凭空建 tab：两次无 tabId 命令后 scope 内仍只有这两个 tab。
    const settled = await mgr.execute({ ...context, requestId: "bg-list-3" }, { method: "list" });
    expect(settled.tabs?.map((tab) => tab.tabId)).toEqual([firstTabId, secondTabId]);
  });

  it("activateTab 只激活目标 tab、清除同 scope 旧 active 并通知 origin renderer", async () => {
    const opened: string[] = [];
    const visibility: Array<{
      visible: boolean;
      sessionId: string;
      tabId?: string;
    }> = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      undefined,
      (tabId) => opened.push(tabId),
      (visible, owner, tabId) =>
        visibility.push({
          visible,
          sessionId: owner.sessionId,
          ...(tabId ? { tabId } : {}),
        }),
    );
    const context = {
      requestId: "activate-tab",
      browserId: "iab-1",
      browserGeneration: 7,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      clientMode: "desktop-continuous" as const,
    };
    const newAttachedTab = async (requestId: string, webContentsId: number) => {
      const pending = mgr.execute({ ...context, requestId }, { method: "newTab" });
      await Promise.resolve();
      const tabId = opened.at(-1)!;
      registerGuest(webContentsId);
      mgr.attachGuest(tabId, webContentsId, { active: true, windowId: 1 });
      await pending;
      return tabId;
    };

    const firstTabId = await newAttachedTab("new-first", 90);
    const secondTabId = await newAttachedTab("new-second", 91);
    const before = await mgr.execute({ ...context, requestId: "list-before" }, { method: "list" });
    expect(before.tabs?.filter((tab) => tab.active).map((tab) => tab.tabId)).toEqual([secondTabId]);

    const activated = await mgr.execute(
      { ...context, requestId: "activate-first" },
      { method: "activateTab", tabId: firstTabId },
    );
    expect(activated).toMatchObject({
      ok: true,
      tab: { tabId: firstTabId, active: true },
      meta: { tabId: firstTabId },
    });
    expect(visibility).toEqual([{ visible: true, sessionId: "session-1", tabId: firstTabId }]);
    await expect(
      mgr.execute(
        { ...context, requestId: "visibility-after" },
        { method: "browserVisibilityGet" },
      ),
    ).resolves.toMatchObject({ ok: true, value: true });
    const after = await mgr.execute({ ...context, requestId: "list-after" }, { method: "list" });
    expect(after.tabs?.filter((tab) => tab.active).map((tab) => tab.tabId)).toEqual([firstTabId]);

    const crossScope = await mgr.execute(
      { ...context, requestId: "activate-cross", sessionId: "session-2" },
      { method: "activateTab", tabId: firstTabId },
    );
    expect(crossScope).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(crossScope.error?.message).toContain(
      "This is pre-action stale-binding recovery, not post-action popup observation.",
    );
    expect(visibility).toHaveLength(1);
  });

  it("visibility 按 scope 生效，viewport 只修改目标 tab 并返回实际尺寸", async () => {
    const opened: string[] = [];
    const { coordinator } = createReadyScreenshotSurfaceCoordinator();
    const visibility: Array<{ visible: boolean; tabId?: string }> = [];
    const viewportChanges: Array<{
      tabId: string;
      viewport: { width: number; height: number } | null;
    }> = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      undefined,
      (tabId) => opened.push(tabId),
      (visible, _owner, tabId) => visibility.push({ visible, ...(tabId ? { tabId } : {}) }),
      (viewport, _owner, tabId) => viewportChanges.push({ tabId, viewport }),
      undefined,
      coordinator,
    );
    const context = {
      requestId: "visibility-set",
      browserId: "iab-1",
      browserGeneration: 7,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      clientMode: "desktop-continuous" as const,
    };

    await expect(
      mgr.execute(context, { method: "browserVisibilitySet", visible: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      mgr.execute({ ...context, requestId: "visibility-get" }, { method: "browserVisibilityGet" }),
    ).resolves.toMatchObject({ ok: true, value: true });
    expect(visibility).toEqual([{ visible: true }]);

    const pending = mgr.execute({ ...context, requestId: "new-visible-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened[0]!;
    const guest = registerGuest(86);
    mgr.attachGuest(tabId, 86, { windowId: 1, workspaceKey: "/repo" });
    await pending;

    const secondPending = mgr.execute(
      { ...context, requestId: "new-second-tab" },
      { method: "newTab" },
    );
    await Promise.resolve();
    const secondTabId = opened[1]!;
    const secondGuest = registerGuest(87);
    mgr.attachGuest(secondTabId, 87, { windowId: 1, workspaceKey: "/repo" });
    await secondPending;

    expect(visibility.at(-1)).toEqual({ visible: true, tabId: secondTabId });
    visibility.length = 0;
    mgr.attachGuest(tabId, 86, {
      active: false,
      windowId: 1,
      workspaceKey: "/repo",
    });
    expect(visibility).toEqual([]);
    const secondViewportCallCount = secondGuest.spy.cdpCalls.filter(
      (call) => call.method === "Emulation.setDeviceMetricsOverride",
    ).length;
    expect(secondViewportCallCount).toBe(1);
    await mgr.execute(
      { ...context, requestId: "viewport-set" },
      { method: "browserViewportSet", tabId, width: 1440, height: 900 },
    );
    expect(guest.spy.cdpCalls).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
        dontSetVisibleSize: true,
      },
    });
    expect(
      secondGuest.spy.cdpCalls.filter(
        (call) => call.method === "Emulation.setDeviceMetricsOverride",
      ),
    ).toHaveLength(secondViewportCallCount);
    await mgr.execute(
      { ...context, requestId: "viewport-screenshot" },
      { method: "screenshot", tabId },
    );
    expect(guest.spy.cdpCalls).toContainEqual({
      method: "Page.captureScreenshot",
      params: {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
      },
    });
    expect(viewportChanges.at(-1)).toEqual({
      tabId,
      viewport: { width: 1440, height: 900 },
    });
    await expect(
      mgr.execute({ ...context, requestId: "viewport-list" }, { method: "list" }),
    ).resolves.toMatchObject({
      ok: true,
      tabs: [
        { tabId, viewport: { width: 1440, height: 900 }, active: true },
        { tabId: secondTabId, viewport: { width: 1280, height: 720 } },
      ],
    });
    await mgr.execute(
      { ...context, requestId: "viewport-reset" },
      { method: "browserViewportReset", tabId },
    );
    expect(guest.spy.cdpCalls).toContainEqual({
      method: "Emulation.clearDeviceMetricsOverride",
      params: undefined,
    });
    expect(viewportChanges.at(-1)).toEqual({ tabId, viewport: null });
    await mgr.updateViewportFromRenderer(tabId, { width: 400, height: 700 }, 1, 1.21);
    expect(guest.spy.cdpCalls.at(-1)).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 400,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
        dontSetVisibleSize: true,
        scale: 1.21,
      },
    });
    await mgr.updateViewportFromRenderer(tabId, { width: 400, height: 700 }, 1, 0.826446);
    expect(guest.spy.cdpCalls.at(-1)).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 400,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
        dontSetVisibleSize: true,
      },
    });
    await expect(
      mgr.execute({ ...context, requestId: "manual-viewport-list" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [
        { tabId, viewport: { width: 400, height: 700 } },
        { tabId: secondTabId, viewport: { width: 1280, height: 720 } },
      ],
    });
    await expect(
      mgr.updateViewportFromRenderer(tabId, { width: 400, height: 700 }, 2),
    ).rejects.toThrow("unavailable for viewport update");
    await mgr.updateViewportFromRenderer(tabId, null, 1);
    await expect(
      mgr.execute({ ...context, requestId: "natural-viewport-list" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [
        { tabId, viewport: { width: 800, height: 600 } },
        { tabId: secondTabId, viewport: { width: 1280, height: 720 } },
      ],
    });
    await mgr.execute(
      { ...context, requestId: "visibility-hide" },
      { method: "browserVisibilitySet", visible: false },
    );
    expect(visibility.at(-1)).toEqual({ visible: false, tabId });
  });

  it("正常尺寸的后台 session 0×0 guest 使用临时 viewport，前台可见后恢复自然尺寸", async () => {
    const opened: Array<{ tabId: string; sessionId: string }> = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId, owner) =>
      opened.push({ tabId, sessionId: owner.sessionId }),
    );
    const context = (sessionId: string, requestId: string) => ({
      requestId,
      browserId: "iab-1",
      browserGeneration: 7,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId,
      clientMode: "desktop-continuous" as const,
    });

    const foregroundPending = mgr.execute(context("session-b", "foreground-new"), {
      method: "newTab",
    });
    await Promise.resolve();
    const foregroundTabId = opened.find((entry) => entry.sessionId === "session-b")!.tabId;
    const foreground = registerGuest(186);
    foreground.spy.viewport = { width: 1024, height: 768 };
    mgr.attachGuest(foregroundTabId, 186, {
      active: true,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-b",
    });
    await expect(foregroundPending).resolves.toMatchObject({
      ok: true,
      tab: { viewport: { width: 1280, height: 720 } },
    });
    await mgr.execute(context("session-b", "foreground-reset"), {
      method: "browserViewportReset",
      tabId: foregroundTabId,
    });
    foreground.spy.viewport = { width: 1024, height: 768 };
    await mgr.execute(context("session-b", "foreground-natural-list"), {
      method: "list",
    });

    const backgroundPending = mgr.execute(context("session-a", "background-new"), {
      method: "newTab",
    });
    await Promise.resolve();
    const backgroundTabId = opened.find((entry) => entry.sessionId === "session-a")!.tabId;
    const background = registerGuest(187);
    background.spy.viewport = { width: 0, height: 0 };
    mgr.attachGuest(backgroundTabId, 187, {
      active: false,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    await expect(backgroundPending).resolves.toMatchObject({
      ok: true,
      tab: { viewport: { width: 1280, height: 720 } },
    });
    await mgr.execute(context("session-a", "background-reset"), {
      method: "browserViewportReset",
      tabId: backgroundTabId,
    });
    background.spy.viewport = { width: 0, height: 0 };
    await expect(
      mgr.execute(context("session-a", "background-list"), { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [{ tabId: backgroundTabId, viewport: { width: 1024, height: 768 } }],
    });
    expect(background.spy.cdpCalls).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
        dontSetVisibleSize: true,
      },
    });
    await expect(
      mgr.execute(context("session-b", "foreground-list"), { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [{ tabId: foregroundTabId, viewport: { width: 1024, height: 768 } }],
    });

    const clearCallCountBeforeRestore = background.spy.cdpCalls.filter(
      (call) => call.method === "Emulation.clearDeviceMetricsOverride",
    ).length;
    mgr.attachGuest(backgroundTabId, 187, {
      active: true,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    await vi.waitFor(() => {
      expect(
        background.spy.cdpCalls.filter(
          (call) => call.method === "Emulation.clearDeviceMetricsOverride",
        ).length,
      ).toBeGreaterThan(clearCallCountBeforeRestore);
    });
    await expect(
      mgr.execute(context("session-a", "restored-list"), { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [
        {
          tabId: backgroundTabId,
          viewport: { width: 800, height: 600 },
          active: true,
        },
      ],
    });
  });

  it("后台 viewport 恢复与显式设置竞态时由显式尺寸胜出", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId) => opened.push(tabId));
    const context = {
      requestId: "background-default-new",
      browserId: "iab-1",
      browserGeneration: 7,
      windowId: 9,
      workspaceKey: "/repo",
      sessionId: "session-a",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute(context, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened[0]!;
    const background = registerGuest(188);
    background.spy.viewport = { width: 0, height: 0 };
    mgr.attachGuest(tabId, 188, {
      active: false,
      windowId: 9,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      tab: { viewport: { width: 1280, height: 720 } },
    });
    await mgr.execute(
      { ...context, requestId: "background-reset" },
      {
        method: "browserViewportReset",
        tabId,
      },
    );
    background.spy.viewport = { width: 0, height: 0 };
    await expect(
      mgr.execute({ ...context, requestId: "background-fallback-list" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [{ tabId, viewport: { width: 800, height: 600 } }],
    });

    const originalSendCommand = background.guest.debugger.sendCommand;
    let signalClearStarted!: () => void;
    let releaseClear!: () => void;
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    background.guest.debugger.sendCommand = async (method, params) => {
      if (method === "Emulation.clearDeviceMetricsOverride") {
        signalClearStarted();
        await clearGate;
      }
      return await originalSendCommand(method, params);
    };

    mgr.attachGuest(tabId, 188, {
      active: true,
      windowId: 9,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    await clearStarted;
    const explicit = mgr.execute(
      { ...context, requestId: "explicit-after-visible" },
      { method: "browserViewportSet", tabId, width: 1280, height: 720 },
    );
    releaseClear();
    await expect(explicit).resolves.toMatchObject({ ok: true });
    await expect(
      mgr.execute({ ...context, requestId: "explicit-list" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [{ tabId, viewport: { width: 1280, height: 720 }, active: true }],
    });
    expect(background.spy.cdpCalls.at(-1)).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
        dontSetVisibleSize: true,
      },
    });
  });

  it("同 window/workspace 的 human tab 只经 BrowserUser 显式发现和 claim", async () => {
    const human = registerGuest(75);
    human.spy.url = "https://human-current.example";
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("browser:human", 75, {
      active: true,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
    });
    const context = (sessionId: string, requestId: string, workspaceKey = "/repo") => ({
      requestId,
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey,
      sessionId,
      clientMode: "desktop-continuous" as const,
    });

    const ownedBeforeClaim = await mgr.execute(context("session-1", "list-owned"), {
      method: "list",
    });
    expect(ownedBeforeClaim.tabs).toEqual([]);
    const visible = await mgr.execute(context("session-1", "list-human"), {
      method: "listUserTabs",
    });
    expect(visible.userTabs).toEqual([
      expect.objectContaining({
        id: "browser:human",
        url: "https://human-current.example",
      }),
    ]);
    const crossSessionGuest = registerGuest(76);
    crossSessionGuest.spy.url = "https://cross-session.example";
    mgr.attachGuest("browser:human", 76, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-2",
    });
    await expect(
      mgr.execute(context("session-1", "list-after-cross-attach"), {
        method: "listUserTabs",
      }),
    ).resolves.toMatchObject({
      userTabs: [expect.objectContaining({ url: "https://human-current.example" })],
    });
    const claimed = await mgr.execute(context("session-1", "claim-human"), {
      method: "claimTab",
      tabId: "browser:human",
    });
    expect(claimed.tab).toEqual(expect.objectContaining({ tabId: "browser:human", active: true }));
    const state = await mgr.execute(context("session-1", "read-human"), {
      method: "getState",
      tabId: "browser:human",
    });
    expect(state.state?.url).toBe("https://human-current.example");
    await mgr.execute(context("session-1", "mark-human-handoff"), {
      method: "markHandoff",
      tabId: "browser:human",
    });
    await mgr.execute(context("session-1", "end-human-turn"), {
      method: "turnEnded",
    });
    await expect(
      mgr.execute(context("session-1", "list-human-handoff"), {
        method: "list",
      }),
    ).resolves.toMatchObject({
      tabs: [
        expect.objectContaining({
          tabId: "browser:human",
          lifecycle: "handoff",
        }),
      ],
    });

    const otherSession = await mgr.execute(context("session-2", "list-other"), {
      method: "list",
    });
    expect(otherSession.tabs).toEqual([]);
    const otherWorkspace = await mgr.execute(
      context("session-3", "list-other-workspace", "/other"),
      { method: "list" },
    );
    expect(otherWorkspace.tabs).toEqual([]);

    const finalized = await mgr.execute(context("session-1", "finalize-human"), {
      method: "finalizeTabs",
      keep: [{ tabId: "browser:human", status: "deliverable" }],
    });
    expect(finalized.meta?.openTabIds).toEqual([]);
    const released = await mgr.execute(context("session-2", "list-released"), {
      method: "listUserTabs",
    });
    expect(released.userTabs).toEqual([]);
    await expect(
      mgr.execute(context("session-1", "list-owner-released"), {
        method: "listUserTabs",
      }),
    ).resolves.toMatchObject({
      userTabs: [expect.objectContaining({ id: "browser:human" })],
    });
  });

  it("claim 未激活的 human tab 会自动激活并通知 renderer 展开视图", async () => {
    const human = registerGuest(77);
    human.spy.url = "https://human-inactive.example";
    const visibilityNotifications: Array<{ visible: boolean; tabId?: string }> = [];
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      (visible, _owner, tabId) => {
        visibilityNotifications.push({ visible, tabId });
      },
    );
    // 不带 active：模拟 human tab 处于后台、webview 未产帧的失败场景
    mgr.attachGuest("browser:human-inactive", 77, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
    });
    const context = {
      requestId: "claim-inactive",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      clientMode: "desktop-continuous" as const,
    };

    const claimed = await mgr.execute(context, {
      method: "claimTab",
      tabId: "browser:human-inactive",
    });
    expect(claimed.tab).toEqual(
      expect.objectContaining({ tabId: "browser:human-inactive", active: true }),
    );
    expect(visibilityNotifications).toContainEqual({
      visible: true,
      tabId: "browser:human-inactive",
    });
  });

  it("模型显式或隐式创建 tab 都默认使用 1280×720 自由尺寸，后续导航保持当前尺寸", async () => {
    const opened: string[] = [];
    const viewportChanges: Array<{
      tabId: string;
      viewport: { width: number; height: number } | null;
    }> = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      undefined,
      (tabId) => opened.push(tabId),
      undefined,
      (viewport, _owner, tabId) => viewportChanges.push({ tabId, viewport }),
    );
    const context = (requestId: string) => ({
      requestId,
      browserId: "iab-default-size",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: requestId.startsWith("implicit") ? "implicit-session" : "explicit-session",
      clientMode: "desktop-continuous" as const,
    });

    const explicitPending = mgr.execute(context("explicit-new"), {
      method: "newTab",
    });
    await Promise.resolve();
    const explicitTabId = opened[0]!;
    const explicitGuest = registerGuest(208);
    mgr.attachGuest(explicitTabId, 208, {
      active: true,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "explicit-session",
    });
    await expect(explicitPending).resolves.toMatchObject({
      tab: { tabId: explicitTabId, viewport: { width: 1280, height: 720 } },
    });

    const implicitPending = mgr.execute(context("implicit-navigate"), {
      method: "navigate",
      url: "https://implicit.example/first",
    });
    await Promise.resolve();
    const implicitTabId = opened[1]!;
    const implicitGuest = registerGuest(209);
    mgr.attachGuest(implicitTabId, 209, {
      active: true,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "implicit-session",
    });
    await expect(implicitPending).resolves.toMatchObject({ ok: true });
    expect(implicitGuest.spy.loadedUrl).toBe("https://implicit.example/first");

    for (const { tabId, spy } of [
      { tabId: explicitTabId, spy: explicitGuest.spy },
      { tabId: implicitTabId, spy: implicitGuest.spy },
    ]) {
      expect(spy.cdpCalls).toContainEqual({
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          mobile: false,
          dontSetVisibleSize: true,
        },
      });
      expect(viewportChanges).toContainEqual({
        tabId,
        viewport: { width: 1280, height: 720 },
      });
    }

    const metricsCallCount = explicitGuest.spy.cdpCalls.filter(
      (call) => call.method === "Emulation.setDeviceMetricsOverride",
    ).length;
    await mgr.execute(context("explicit-navigate-existing"), {
      method: "navigate",
      tabId: explicitTabId,
      url: "https://explicit.example/next",
    });
    expect(
      explicitGuest.spy.cdpCalls.filter(
        (call) => call.method === "Emulation.setDeviceMetricsOverride",
      ),
    ).toHaveLength(metricsCallCount);
    await expect(mgr.execute(context("explicit-list"), { method: "list" })).resolves.toMatchObject({
      tabs: [expect.objectContaining({ viewport: { width: 1280, height: 720 } })],
    });
  });

  it("用户创建的常规尺寸 tab 被模型 claim 或导航时不重设尺寸", async () => {
    const viewportChanges: Array<{ width: number; height: number } | null> = [];
    const user = registerGuest(210);
    user.spy.url = "https://user.example/first";
    user.spy.viewport = { width: 930, height: 640 };
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      undefined,
      undefined,
      undefined,
      (viewport) => viewportChanges.push(viewport),
    );
    mgr.attachGuest("browser:user-size", 210, {
      active: true,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-user",
    });
    const context = (requestId: string) => ({
      requestId,
      browserId: "iab-user-size",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-user",
      clientMode: "desktop-continuous" as const,
    });

    await expect(
      mgr.execute(context("claim-user-size"), {
        method: "claimTab",
        tabId: "browser:user-size",
      }),
    ).resolves.toMatchObject({
      tab: { viewport: { width: 930, height: 640 } },
    });
    expect(viewportChanges).toEqual([]);
    expect(
      user.spy.cdpCalls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride"),
    ).toHaveLength(0);

    await mgr.execute(context("navigate-user-normal"), {
      method: "navigate",
      tabId: "browser:user-size",
      url: "https://user.example/second",
    });
    await expect(
      mgr.execute(context("list-user-normal"), { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [{ tabId: "browser:user-size", viewport: { width: 930, height: 640 } }],
    });

    await mgr.updateViewportFromRenderer("browser:user-size", { width: 393, height: 852 }, 1);
    const metricsCallCount = user.spy.cdpCalls.filter(
      (call) => call.method === "Emulation.setDeviceMetricsOverride",
    ).length;
    await mgr.execute(context("navigate-user-responsive"), {
      method: "navigate",
      tabId: "browser:user-size",
      url: "https://user.example/third",
    });
    expect(
      user.spy.cdpCalls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride"),
    ).toHaveLength(metricsCallCount);
    await expect(
      mgr.execute(context("list-user-responsive"), { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [{ tabId: "browser:user-size", viewport: { width: 393, height: 852 } }],
    });
  });

  it("human tabs 按 session 隔离，并从 openTabs 过滤空 URL 与 about:blank", async () => {
    const blank = registerGuest(90);
    blank.spy.url = "about:blank";
    const unloaded = registerGuest(91);
    unloaded.spy.url = "";
    const ready = registerGuest(92);
    ready.spy.url = "https://owner.example/page";
    const mgr = new BrowserGuestManager();
    for (const [tabId, webContentsId] of [
      ["browser:blank", 90],
      ["browser:unloaded", 91],
      ["browser:ready", 92],
    ] as const) {
      mgr.attachGuest(tabId, webContentsId, {
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-owner",
      });
    }
    const context = (sessionId: string, requestId: string) => ({
      requestId,
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId,
      clientMode: "desktop-continuous" as const,
    });

    await expect(
      mgr.execute(context("session-owner", "list-owner"), {
        method: "listUserTabs",
      }),
    ).resolves.toMatchObject({
      userTabs: [expect.objectContaining({ id: "browser:ready" })],
    });
    await expect(
      mgr.execute(context("session-other", "list-other"), {
        method: "listUserTabs",
      }),
    ).resolves.toMatchObject({ userTabs: [] });

    const legacyReady = registerGuest(93);
    legacyReady.spy.url = "https://legacy.example";
    mgr.attachGuest("browser:legacy-unscoped", 93, {
      windowId: 1,
      workspaceKey: "/repo",
    });
    await expect(
      mgr.execute(context("session-owner", "list-after-legacy"), {
        method: "listUserTabs",
      }),
    ).resolves.toMatchObject({
      userTabs: [expect.objectContaining({ id: "browser:ready" })],
    });
  });

  it("finalize keep subset 只标记列出的 tabs，未列 tab 保持打开", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "finalize-subset",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };
    const newAttachedTab = async (requestId: string, webContentsId: number) => {
      const pending = mgr.execute({ ...context, requestId }, { method: "newTab" });
      await Promise.resolve();
      const tabId = opened.at(-1)!;
      const guest = registerGuest(webContentsId);
      guest.spy.url = `https://session-one.example/${requestId}`;
      mgr.attachGuest(tabId, webContentsId, { windowId: 1 });
      await pending;
      return tabId;
    };

    const handoffTabId = await newAttachedTab("new-handoff", 87);
    const unlistedTabId = await newAttachedTab("new-unlisted", 88);
    const deliverableTabId = await newAttachedTab("new-deliverable", 89);

    await mgr.execute(
      { ...context, requestId: "finalize" },
      {
        method: "finalizeTabs",
        keep: [
          { tabId: handoffTabId, status: "handoff" },
          { tabId: deliverableTabId, status: "deliverable" },
        ],
      },
    );

    expect(closed).toEqual([]);
    await expect(
      mgr.execute({ ...context, requestId: "list-controlled" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: expect.arrayContaining([
        expect.objectContaining({ tabId: handoffTabId, lifecycle: "handoff" }),
        expect.objectContaining({ tabId: unlistedTabId }),
      ]),
    });
    await expect(
      mgr.execute(
        {
          ...context,
          requestId: "list-released-other",
          sessionId: "session-2",
        },
        { method: "listUserTabs" },
      ),
    ).resolves.toMatchObject({ userTabs: [] });
    await expect(
      mgr.execute({ ...context, requestId: "list-released-owner" }, { method: "listUserTabs" }),
    ).resolves.toMatchObject({
      userTabs: [expect.objectContaining({ id: deliverableTabId })],
    });
  });

  it("turnEnded 在模型漏掉 finalize 时保留全部 agent tabs", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "turn-fallback",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const firstPending = mgr.execute({ ...context, requestId: "new-first" }, { method: "newTab" });
    await Promise.resolve();
    const firstTabId = opened.at(-1)!;
    registerGuest(76);
    mgr.attachGuest(firstTabId, 76, { active: false, windowId: 1 });
    await firstPending;

    const finalPending = mgr.execute({ ...context, requestId: "new-final" }, { method: "newTab" });
    await Promise.resolve();
    const finalTabId = opened.at(-1)!;
    registerGuest(77);
    mgr.attachGuest(finalTabId, 77, { active: true, windowId: 1 });
    await finalPending;

    await mgr.execute(
      { ...context, requestId: "turn-ended" },
      { method: "turnEnded", turnId: "turn-1" },
    );

    expect(closed).toEqual([]);
    await expect(
      mgr.execute({ ...context, requestId: "list-controlled" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: expect.arrayContaining([
        expect.objectContaining({ tabId: firstTabId }),
        expect.objectContaining({ tabId: finalTabId }),
      ]),
    });
    await expect(
      mgr.execute(
        { ...context, requestId: "list-visible", sessionId: "session-2" },
        { method: "listUserTabs" },
      ),
    ).resolves.toMatchObject({ userTabs: [] });
    await expect(
      mgr.execute(
        { ...context, requestId: "continue-next-turn", turnId: "turn-2" },
        { method: "getState", tabId: finalTabId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      meta: { tabId: finalTabId, lifecycle: "active" },
    });
    await expect(
      mgr.execute(
        { ...context, requestId: "continue-first-tab", turnId: "turn-2" },
        { method: "getState", tabId: firstTabId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      meta: { tabId: firstTabId, lifecycle: "active" },
    });
  });

  it("turnEnded 释放 guest CDP，guest 之后被销毁不再打开主进程 UAF 窗口", async () => {
    // ZCT-2096194711377596416：guest WebContents 销毁时若 CDP 仍 attached 且未经主动
    // detach，DevToolsSession 隐式析构后在途通知会 UAF 掉主进程（EXC_BAD_ACCESS at 0x10）。
    // 销毁触发路径不可枚举（React 卸载/系统行为均可达），唯一可靠的防御是把 CDP 生命周期
    // 收窄到 turn 内：turnEnded 时主动 detach，命令路径 lazy re-attach。
    const opened: string[] = [];
    const logs: string[] = [];
    const mgr = new BrowserGuestManager(
      (msg) => logs.push(msg),
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "turn-cdp-release",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { guest, spy } = registerGuest(90);
    mgr.attachGuest(tabId, 90, { active: true, windowId: 1 });
    await pending;
    expect(spy.attached).toBe(true);

    await mgr.execute(
      { ...context, requestId: "turn-ended" },
      { method: "turnEnded", turnId: "turn-1" },
    );

    expect(spy.detachCalls).toBe(1);
    expect(spy.attached).toBe(false);

    // 模拟「destroyed 直达」：turn 之外 guest 被任意路径销毁。
    guest.close();
    await Promise.resolve();
    expect(logs.some((msg) => msg.includes("still attached on destroyed guest"))).toBe(false);
  });

  it("turnEnded 后的下一条 CDP 命令 lazy re-attach 并执行成功", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "turn-cdp-relatch",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { spy } = registerGuest(91);
    mgr.attachGuest(tabId, 91, { active: true, windowId: 1 });
    await pending;

    await mgr.execute(
      { ...context, requestId: "turn-ended" },
      { method: "turnEnded", turnId: "turn-1" },
    );
    expect(spy.attached).toBe(false);

    await expect(
      mgr.execute(
        { ...context, requestId: "viewport-next-turn", turnId: "turn-2" },
        { method: "browserViewportSet", tabId, width: 1024, height: 768 },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(spy.attached).toBe(true);
    expect(spy.cdpCalls.some(({ method }) => method === "Emulation.setDeviceMetricsOverride")).toBe(
      true,
    );
  });

  it("closeSession 释放 guest CDP", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "session-cdp-release",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { spy } = registerGuest(92);
    mgr.attachGuest(tabId, 92, { active: true, windowId: 1 });
    await pending;

    await mgr.execute({ ...context, requestId: "close-session" }, { method: "closeSession" });

    expect(spy.detachCalls).toBe(1);
    expect(spy.attached).toBe(false);
  });

  it("turnEnded 在 CDP 命令在途时等待其结束后再释放，不中断在途命令", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "turn-cdp-inflight",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { guest, spy } = registerGuest(93);
    mgr.attachGuest(tabId, 93, { active: true, windowId: 1 });
    await pending;

    const inflight = createDeferred<void>();
    const originalSend = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method: string, params?: unknown) => {
      if (method === "Emulation.setDeviceMetricsOverride") await inflight.promise;
      return originalSend(method, params);
    };

    const commandPending = mgr.execute(
      { ...context, requestId: "viewport-inflight" },
      { method: "browserViewportSet", tabId, width: 1024, height: 768 },
    );
    await Promise.resolve();
    await Promise.resolve();

    await mgr.execute(
      { ...context, requestId: "turn-ended" },
      { method: "turnEnded", turnId: "turn-1" },
    );
    // 在途命令尚未 settle：不得中途拆 CDP。
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(spy.detachCalls).toBe(0);

    inflight.resolve();
    await commandPending;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(spy.detachCalls).toBe(1);
    expect(spy.attached).toBe(false);
  });

  it("CDP 命令流空闲后自动释放，消除 turn 内命令间隙的 UAF 暴露窗口", async () => {
    // ZCT-2096194711377596416 实测：guest renderer 被 Chromium 杀且 render-process-gone
    // 未送达 main 时（Electron 已知缺口），destroyed 直达且 CDP attached → 主进程 UAF。
    // 崩溃全部落在 turn 内命令间隙（0.4~9s），turnEnded 释放覆盖不到，必须命令级 idle 释放。
    const opened: string[] = [];
    const logs: string[] = [];
    const mgr = new BrowserGuestManager(
      (msg) => logs.push(msg),
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      50, // cdpIdleReleaseMs（注入短 idle 便于测试）
    );
    const context = {
      requestId: "cdp-idle-release",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { guest, spy } = registerGuest(94);
    mgr.attachGuest(tabId, 94, { active: true, windowId: 1 });
    await pending;

    // 命令执行期间（密集流）不释放。
    await mgr.execute(
      { ...context, requestId: "viewport-1" },
      { method: "browserViewportSet", tabId, width: 1024, height: 768 },
    );
    expect(spy.attached).toBe(true);

    // 命令流停止超过 idle 阈值后自动 detach。
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(spy.attached).toBe(false);
    expect(logs.some((msg) => msg.includes("cdp released after cdp idle"))).toBe(true);

    // turn 内下一条命令 lazy re-attach，正常执行。
    await expect(
      mgr.execute(
        { ...context, requestId: "viewport-2" },
        { method: "browserViewportSet", tabId, width: 800, height: 600 },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(spy.attached).toBe(true);

    // 此时销毁 guest（模拟 destroyed 直达）：CDP 已再次 idle 释放，不再打开 UAF 窗口。
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    guest.close();
    await Promise.resolve();
    expect(logs.some((msg) => msg.includes("still attached on destroyed guest"))).toBe(false);
  });

  it("idle 释放后 re-attach 重放 Page.enable 与 viewport override（恢复 per-session 会话态）", async () => {
    // ZCT-2096194711377596416 review 实锤：Page 域与设备指标覆盖是 per-session 的，
    // detach 即被 Chromium 清空。re-attach 若不重放：dialog 事件黑洞（getDialog 恒 null、
    // evaluate 遇 dialog 挂到超时）、viewport 仿真与 manager 缓存分叉。重放必须先于
    // 调用方命令下发（同一 CDP session 的命令按序处理，Page.enable 先到达即可生效）。
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      50, // cdpIdleReleaseMs
    );
    const context = {
      requestId: "replay-session-state",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { spy } = registerGuest(95);
    mgr.attachGuest(tabId, 95, { active: true, windowId: 1 });
    await pending;
    await mgr.execute(
      { ...context, requestId: "viewport-set" },
      { method: "browserViewportSet", tabId, width: 1024, height: 768 },
    );

    // 命令流空闲 → CDP 释放。
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(spy.attached).toBe(false);
    spy.cdpCalls.length = 0;

    // turn 内下一条命令触发 re-attach：必须重放 Page.enable 与 viewport override。
    await expect(
      mgr.execute(
        { ...context, requestId: "next-command" },
        { method: "browserViewportSet", tabId, width: 1024, height: 768 },
      ),
    ).resolves.toMatchObject({ ok: true });

    const methods = spy.cdpCalls.map(({ method }) => method);
    const pageEnableIndex = methods.indexOf("Page.enable");
    const overrideIndex = methods.indexOf("Emulation.setDeviceMetricsOverride");
    expect(pageEnableIndex).toBeGreaterThanOrEqual(0);
    expect(overrideIndex).toBeGreaterThan(pageEnableIndex);
    expect(
      spy.cdpCalls.some(
        ({ method, params }) =>
          method === "Emulation.setDeviceMetricsOverride" &&
          (params as { width: number }).width === 1024,
      ),
    ).toBe(true);
  });

  it("re-attach 的 Page.enable 完成前不得派发调用方命令（显式串行屏障）", async () => {
    // MR review：void fire-and-forget 重放没有等待屏障，调用方命令可能先于
    // Page.enable / viewport override 被 Chromium 处理（依赖 sendCommand 入队顺序的
    // 隐式行为）。恢复必须建模为可等待 flight：Page.enable 完成前业务命令不得入队。
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      50, // cdpIdleReleaseMs
    );
    const context = {
      requestId: "replay-barrier",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { guest, spy } = registerGuest(96);
    mgr.attachGuest(tabId, 96, { active: true, windowId: 1 });
    await pending;

    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(spy.attached).toBe(false);

    // Page.enable 的 sendCommand 挂起：恢复未完成期间，业务命令不得派发。
    // arrivals 记录到达序（cdpCalls 在 gate 放行后才由 originalSend 记录）。
    const arrivals: string[] = [];
    const pageEnableGate = createDeferred<void>();
    const originalSend = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method: string, params?: unknown) => {
      arrivals.push(method);
      if (method === "Page.enable") await pageEnableGate.promise;
      return originalSend(method, params);
    };
    spy.cdpCalls.length = 0;

    const commandPending = mgr.execute(
      { ...context, requestId: "blocked-until-restored" },
      { method: "browserViewportSet", tabId, width: 1024, height: 768 },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(arrivals).toEqual(["Page.enable"]);

    pageEnableGate.resolve();
    await commandPending;
    const methods = spy.cdpCalls.map(({ method }) => method);
    expect(methods.indexOf("Emulation.setDeviceMetricsOverride")).toBeGreaterThan(
      methods.indexOf("Page.enable"),
    );
  });

  it("会话恢复失败必须拒绝业务命令，下一次命令重建恢复 flight", async () => {
    // MR review：恢复屏障的契约是「Page.enable 与 viewport 状态恢复完成后才允许业务
    // 命令派发」。吞掉恢复异常会让契约静默失效——Page.enable 丢失后后续命令见
    // attached 即跳过恢复，dialog 事件黑洞延长到整个 attach 期。
    const opened: string[] = [];
    const logs: string[] = [];
    const mgr = new BrowserGuestManager(
      (msg) => logs.push(msg),
      5_000,
      () => {},
      (tabId) => opened.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      50, // cdpIdleReleaseMs
    );
    const context = {
      requestId: "restore-failure",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const pending = mgr.execute({ ...context, requestId: "new-tab" }, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened.at(-1)!;
    const { spy } = registerGuest(97);
    mgr.attachGuest(tabId, 97, { active: true, windowId: 1 });
    await pending;
    await mgr.execute(
      { ...context, requestId: "viewport-prep" },
      { method: "browserViewportSet", tabId, width: 1024, height: 768 },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(spy.attached).toBe(false);

    // 注入 Page.enable 拒绝（模拟 guest renderer 崩溃中的 transient error）。
    spy.cdpCalls.length = 0;
    let failPageEnable = true;
    const guest98 = guestRegistry.get(97)!;
    const realSend = guest98.debugger.sendCommand;
    guest98.debugger.sendCommand = async (method: string, params?: unknown) => {
      if (method === "Page.enable" && failPageEnable) throw new Error("renderer gone");
      return realSend(method, params);
    };

    // 恢复失败 → 业务命令必须失败且携带原始错误（不得派发 override）。
    // manager.execute 以 rejection 上抛原始错误，dispatch 层（index.ts execute threw
    // catch）统一转为失败结果，agent 可感知并重试。
    await expect(
      mgr.execute(
        { ...context, requestId: "command-during-broken-restore" },
        { method: "browserViewportSet", tabId, width: 800, height: 600 },
      ),
    ).rejects.toThrow("renderer gone");
    expect(spy.cdpCalls.some(({ method }) => method === "Emulation.setDeviceMetricsOverride")).toBe(
      false,
    );
    expect(logs.some((msg) => msg.includes("Page.enable replay failed"))).toBe(true);

    // 故障清除后，下一次命令重建恢复 flight 并成功（lazy attach 即重试机制）。
    failPageEnable = false;
    await expect(
      mgr.execute(
        { ...context, requestId: "command-after-recovery" },
        { method: "browserViewportSet", tabId, width: 800, height: 600 },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(logs.some((msg) => msg.includes("cdp session state replayed"))).toBe(true);
  });

  it("turnEnded 已有 handoff 时仍保留后续新建的 active tab", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "turn-handoff",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };

    const handoffPending = mgr.execute(
      { ...context, requestId: "new-handoff" },
      { method: "newTab" },
    );
    await Promise.resolve();
    const handoffTabId = opened.at(-1)!;
    registerGuest(78);
    mgr.attachGuest(handoffTabId, 78, { active: false, windowId: 1 });
    await handoffPending;
    await mgr.execute(
      { ...context, requestId: "mark-handoff" },
      { method: "markHandoff", tabId: handoffTabId },
    );

    const temporaryPending = mgr.execute(
      { ...context, requestId: "new-temporary" },
      { method: "newTab" },
    );
    await Promise.resolve();
    const temporaryTabId = opened.at(-1)!;
    registerGuest(79);
    mgr.attachGuest(temporaryTabId, 79, { active: true, windowId: 1 });
    await temporaryPending;

    await mgr.execute(
      { ...context, requestId: "turn-ended" },
      { method: "turnEnded", turnId: "turn-1" },
    );

    expect(closed).toEqual([]);
    await expect(
      mgr.execute({ ...context, requestId: "list-handoff" }, { method: "list" }),
    ).resolves.toMatchObject({
      tabs: expect.arrayContaining([
        expect.objectContaining({ tabId: handoffTabId, lifecycle: "handoff" }),
        expect.objectContaining({ tabId: temporaryTabId }),
      ]),
    });
  });

  it("显式 close 后拒绝迟到 attach", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "req-new",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      clientMode: "desktop-continuous" as const,
    };
    const pending = mgr.execute(context, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened[0]!;
    registerGuest(73);
    mgr.attachGuest(tabId, 73, { windowId: 1 });
    await pending;

    const close = await mgr.execute(
      { ...context, requestId: "req-close" },
      {
        method: "close",
        tabId,
      },
    );
    expect(close.meta).toMatchObject({
      tabId,
      lifecycle: "closed",
      openTabIds: [],
    });
    expect(closed).toEqual([tabId]);

    registerGuest(74);
    mgr.attachGuest(tabId, 74, { windowId: 1 });
    expect(mgr.hasGuest(tabId)).toBe(false);
    const list = await mgr.execute({ ...context, requestId: "req-list" }, { method: "list" });
    expect(list.tabs).toEqual([]);
  });

  it("cancelRequest 能中断 ready waiter，并区分未下发副作用", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId) => opened.push(tabId));
    const context = {
      requestId: "req-waiting",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };
    const pending = mgr.execute(context, { method: "getState" });
    await Promise.resolve();
    expect(opened).toHaveLength(1);
    const crossScopeCancel = await mgr.execute(
      {
        ...context,
        requestId: "req-cross-scope-cancel",
        sessionId: "session-2",
      },
      { method: "cancelRequest", requestId: context.requestId },
    );
    expect(crossScopeCancel.value).toEqual({ cancelled: false });
    const cancel = await mgr.execute(
      { ...context, requestId: "req-cancel" },
      { method: "cancelRequest", requestId: context.requestId },
    );
    expect(cancel.value).toEqual({ cancelled: true });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
    });
  });

  it("同 scope 的并发重复 requestId 立即失败且不覆盖原请求", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId) => opened.push(tabId));
    const context = {
      requestId: "duplicate-running",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };
    const original = mgr.execute(context, { method: "getState" });
    await Promise.resolve();

    await expect(mgr.execute(context, { method: "snapshot" })).resolves.toMatchObject({
      ok: false,
      error: { code: "duplicate_request_id", sideEffect: "none" },
    });
    expect(opened).toHaveLength(1);

    const cancel = await mgr.execute(
      { ...context, requestId: "cancel-original" },
      { method: "cancelRequest", requestId: context.requestId },
    );
    expect(cancel.value).toEqual({ cancelled: true });
    await expect(original).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
    });
  });

  it("跨 scope 的并发重复 requestId 立即失败且原 scope 仍可取消", async () => {
    const opened: string[] = [];
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId) => opened.push(tabId));
    const context = {
      requestId: "cross-scope-duplicate-running",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      turnId: "turn-1",
      clientMode: "desktop-continuous" as const,
    };
    const original = mgr.execute(context, { method: "getState" });
    await Promise.resolve();

    await expect(
      mgr.execute({ ...context, sessionId: "session-2" }, { method: "snapshot" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "duplicate_request_id", sideEffect: "none" },
    });
    expect(opened).toHaveLength(1);

    const crossScopeCancel = await mgr.execute(
      {
        ...context,
        requestId: "cancel-from-other-scope",
        sessionId: "session-2",
      },
      { method: "cancelRequest", requestId: context.requestId },
    );
    expect(crossScopeCancel.value).toEqual({ cancelled: false });
    const ownerCancel = await mgr.execute(
      { ...context, requestId: "cancel-from-owner" },
      { method: "cancelRequest", requestId: context.requestId },
    );
    expect(ownerCancel.value).toEqual({ cancelled: true });
    await expect(original).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
    });
  });

  it("tabs.new 在 ready 前取消会关闭 provisional tab 并拒绝迟到 attach", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId) => opened.push(tabId),
    );
    const context = {
      requestId: "req-new-cancelled",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      clientMode: "desktop-continuous" as const,
    };
    const pending = mgr.execute(context, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened[0]!;
    await mgr.execute(
      { ...context, requestId: "req-cancel-new" },
      { method: "cancelRequest", requestId: context.requestId },
    );

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
      meta: { tabId, lifecycle: "closed", openTabIds: [] },
    });
    expect(closed).toEqual([tabId]);
    registerGuest(76);
    mgr.attachGuest(tabId, 76, { windowId: 1, workspaceKey: "/repo" });
    expect(mgr.hasGuest(tabId)).toBe(false);
  });

  it("动作下发后的 cancel 标记 uncertain side effect", async () => {
    const registered = registerGuest(83);
    const opened: string[] = [];
    let finishNavigation!: () => void;
    registered.guest.loadURL = async (url: string) => {
      registered.spy.loadedUrl = url;
      await new Promise<void>((resolve) => {
        finishNavigation = resolve;
      });
    };
    const mgr = new BrowserGuestManager(undefined, 5_000, undefined, (tabId) => opened.push(tabId));
    const context = {
      requestId: "create-side-effect-tab",
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-1",
      clientMode: "desktop-continuous" as const,
    };
    const createPending = mgr.execute(context, { method: "newTab" });
    await Promise.resolve();
    const tabId = opened[0]!;
    mgr.attachGuest(tabId, 83, { windowId: 1 });
    await createPending;

    const requestId = "navigate-side-effect";
    const pending = mgr.execute(
      { ...context, requestId },
      { method: "navigate", url: "https://side-effect.example", tabId },
    );
    await vi.waitFor(() => expect(registered.spy.loadedUrl).toBe("https://side-effect.example"));
    const cancel = await mgr.execute(
      { ...context, requestId: "cancel-side-effect" },
      { method: "cancelRequest", requestId },
    );
    expect(cancel.value).toEqual({ cancelled: true });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "uncertain" },
    });
    finishNavigation();
  });

  it("finalize 把 tab 标记为 deliverable 并保留在当前 scope", async () => {
    registerGuest(84);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("deliverable", 84, { active: true });
    const finalized = await mgr.execute("deliverable", { method: "finalize" });
    expect(finalized.meta).toMatchObject({
      tabId: "deliverable",
      lifecycle: "deliverable",
    });
    const listed = await mgr.execute("deliverable", { method: "list" });
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        tabId: "deliverable",
        lifecycle: "deliverable",
      }),
    ]);
  });

  it("playwrightWaitForTimeout 校验 tab、按时完成且可由 AbortSignal 取消", async () => {
    registerGuest(85);
    const mgr = new BrowserGuestManager();
    mgr.attachGuest("wait-tab", 85, { active: true });

    const startedAt = Date.now();
    const completed = await mgr.execute("wait-tab", {
      method: "playwrightWaitForTimeout",
      timeoutMs: 20,
      tabId: "wait-tab",
    });
    expect(completed).toMatchObject({
      ok: true,
      meta: { tabId: "wait-tab", lifecycle: "active" },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);

    const controller = new AbortController();
    const cancelled = mgr.execute(
      "wait-tab",
      {
        method: "playwrightWaitForTimeout",
        timeoutMs: 5_000,
        tabId: "wait-tab",
      },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "none" },
    });
  });

  // dwf 子代理的 sessionId 不是任何对话：closeSession 保留的 view 没人看得见、没人能认领，
  // 只会一直挂着 guest。closeTabs 让永不回来的 session 真正关掉自己名下的 tab。
  it("closeSession({ closeTabs }) 关闭该 session 名下全部 tab（含已释放的），其它 session 不动", async () => {
    const opened: Array<{ tabId: string; sessionId: string }> = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId, owner) => opened.push({ tabId, sessionId: owner.sessionId }),
    );
    const context = (sessionId: string, requestId: string) => ({
      requestId,
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId,
      clientMode: "desktop-continuous" as const,
    });
    const openTab = async (sessionId: string, guestId: number, url: string) => {
      const before = opened.length;
      const pending = mgr.execute(context(sessionId, `new-${guestId}`), { method: "newTab" });
      await vi.waitFor(() => expect(opened.length).toBe(before + 1));
      const tabId = opened.at(-1)!.tabId;
      const registered = registerGuest(guestId);
      registered.spy.url = url;
      mgr.attachGuest(tabId, guestId, { windowId: 1 });
      await pending;
      return tabId;
    };
    const actor = "sess_dwf-dwfrun-1-actor_1_1";
    const controlledTabId = await openTab(actor, 91, "https://controlled.example");
    const deliveredTabId = await openTab(actor, 92, "https://delivered.example");
    const otherTabId = await openTab("s2", 93, "https://other.example");
    // deliverable 释放回 actor 的 user-tab 集合：它已不在 tabs.list() 里，但仍归 actor。
    await mgr.execute(context(actor, "finalize"), {
      method: "finalizeTabs",
      keep: [{ tabId: deliveredTabId, status: "deliverable" }],
    });
    await expect(
      mgr.execute(context(actor, "list-before"), { method: "list" }),
    ).resolves.toMatchObject({ tabs: [expect.objectContaining({ tabId: controlledTabId })] });

    await expect(
      mgr.execute(context(actor, "close-session"), { method: "closeSession", closeTabs: true }),
    ).resolves.toMatchObject({ ok: true });

    expect([...closed].sort()).toEqual([controlledTabId, deliveredTabId].sort());
    await expect(
      mgr.execute(context(actor, "list-after"), { method: "list" }),
    ).resolves.toMatchObject({ tabs: [] });
    await expect(
      mgr.execute(context(actor, "user-after"), { method: "listUserTabs" }),
    ).resolves.toMatchObject({ userTabs: [] });
    await expect(
      mgr.execute(context("s2", "list-other"), { method: "list" }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ tabId: otherTabId })],
    });
  });

  it("closeSession 只释放目标 scope 的 tabs 且不关闭 view", async () => {
    const opened: Array<{ tabId: string; sessionId: string }> = [];
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      (tabId, owner) => opened.push({ tabId, sessionId: owner.sessionId }),
    );
    const context = (sessionId: string, requestId: string) => ({
      requestId,
      browserId: "iab-1",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId,
      clientMode: "desktop-continuous" as const,
    });
    const firstPending = mgr.execute(context("s1", "new-1"), {
      method: "newTab",
    });
    await Promise.resolve();
    const firstTabId = opened.find((entry) => entry.sessionId === "s1")!.tabId;
    const first = registerGuest(81);
    first.spy.url = "https://first.example";
    mgr.attachGuest(firstTabId, 81, { windowId: 1 });
    await firstPending;

    const secondPending = mgr.execute(context("s2", "new-2"), {
      method: "newTab",
    });
    await Promise.resolve();
    const secondTabId = opened.find((entry) => entry.sessionId === "s2")!.tabId;
    const second = registerGuest(82);
    second.spy.url = "https://second.example";
    mgr.attachGuest(secondTabId, 82, { windowId: 1 });
    await secondPending;

    const claimed = registerGuest(83);
    claimed.spy.url = "https://claimed.example";
    mgr.attachGuest("browser:claimed-on-close", 83, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "s1",
    });
    await mgr.execute(context("s1", "claim-user-tab"), {
      method: "claimTab",
      tabId: "browser:claimed-on-close",
    });

    await mgr.execute(context("s1", "close-session"), {
      method: "closeSession",
    });
    expect(closed).toEqual([]);
    await expect(mgr.execute(context("s1", "list-1"), { method: "list" })).resolves.toMatchObject({
      tabs: [],
    });
    await expect(mgr.execute(context("s2", "list-2"), { method: "list" })).resolves.toMatchObject({
      tabs: [expect.objectContaining({ tabId: secondTabId })],
    });
    await expect(
      mgr.execute(context("s2", "list-released"), { method: "listUserTabs" }),
    ).resolves.toMatchObject({ userTabs: [] });
    await expect(
      mgr.execute(context("s1", "list-owner-released"), {
        method: "listUserTabs",
      }),
    ).resolves.toMatchObject({
      userTabs: expect.arrayContaining([
        expect.objectContaining({ id: firstTabId }),
        expect.objectContaining({ id: "browser:claimed-on-close" }),
      ]),
    });
  });

  it("BTL04: 第 33 个逻辑 tab 出现后持久关闭最老 tab，并通知 renderer 删除 tab 壳", async () => {
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => null),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => []),
    };
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      5_000,
      (tabId) => closed.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        tabLimit: 2,
        recoveryStore,
      },
    );

    let oldestGuestSpy: GuestSpy | undefined;
    for (const [index, tabId] of ["browser:a", "browser:b", "browser:c"].entries()) {
      const registered = registerGuest(300 + index);
      if (index === 0) oldestGuestSpy = registered.spy;
      registered.spy.url = `https://example.com/${tabId}`;
      registered.spy.title = tabId;
      mgr.attachGuest(tabId, 300 + index, {
        active: false,
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      });
      await mgr.reportResidency({
        tabId,
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
        selected: false,
        visible: false,
        currentTask: false,
        loading: false,
        restoreUrl: registered.spy.url,
        title: registered.spy.title,
      });
    }

    await vi.waitFor(() => expect(closed).toEqual(["browser:a"]));
    await vi.waitFor(() => expect(mgr.hasGuest("browser:a")).toBe(false));
    expect(guestRegistry.get(300)?.isDestroyed()).toBe(true);
    expect(oldestGuestSpy?.sessionRemoveAfterDestroyCalls).toBe(0);
    expect(recoveryStore.remove).toHaveBeenCalledWith("browser:a");

    const context = {
      requestId: "logical-list",
      browserId: "unclaimed-iab",
      browserGeneration: 0,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      clientMode: "desktop-continuous" as const,
    };
    const userTabs = await mgr.execute(context, { method: "listUserTabs" });
    expect(userTabs.userTabs?.map((tab) => tab.id)).toEqual(["browser:b", "browser:c"]);

    await expect(
      mgr.ensureResidentFromRenderer({
        tabId: "browser:a",
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      }),
    ).rejects.toThrow("unavailable for renderer scope");
  });

  it("Electron 正在捕获的 guest 不会成为超限关闭 victim", async () => {
    const closed: string[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      (tabId) => closed.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        tabLimit: 1,
      },
    );
    const captured = registerGuest(320);
    captured.spy.beingCaptured = true;
    registerGuest(321);
    for (const [tabId, guestId] of [
      ["browser:captured", 320],
      ["browser:eligible", 321],
    ] as const) {
      mgr.attachGuest(tabId, guestId, {
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      });
      await mgr.reportResidency({
        tabId,
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
        selected: false,
        visible: false,
        currentTask: false,
        loading: false,
      });
    }

    await vi.waitFor(() => expect(closed).toEqual(["browser:eligible"]));
    expect(mgr.hasGuest("browser:captured")).toBe(true);
    expect(mgr.hasGuest("browser:eligible")).toBe(false);
  });

  it("BTL14: attach timeout 回滚为可重试 suspended，并拒绝旧 generation 的迟到 guest", async () => {
    const tabId = "browser:restore-timeout-retry";
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => restoredPageState(tabId)),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId)]),
    };
    const restoreRequests: Array<{ generation: number }> = [];
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          restoreRequests.push({ generation: payload.generation });
          if (restoreRequests.length !== 2) return;
          registerGuest(334);
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 334, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );
    await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    const request = {
      tabId,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    };

    await expect(mgr.ensureResidentFromRenderer(request)).rejects.toThrow("restore failed");
    expect(restoreRequests).toHaveLength(1);

    const late = registerGuest(333);
    mgr.attachGuest(tabId, 333, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      residencyGeneration: restoreRequests[0]?.generation,
    });
    expect(mgr.hasGuest(tabId)).toBe(false);
    expect(late.spy.closeCalls).toBe(1);

    await expect(mgr.ensureResidentFromRenderer(request)).resolves.toBeUndefined();
    expect(restoreRequests).toHaveLength(2);
    expect(mgr.hasGuest(tabId)).toBe(true);
  });

  it("BTL14: 单个 caller 取消只结束自身等待，不中止 tab 级共享恢复", async () => {
    const tabId = "browser:restore-caller-cancel";
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => restoredPageState(tabId)),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId)]),
    };
    let restorePayload: { generation: number } | undefined;
    const mgr = new BrowserGuestManager(
      undefined,
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          restorePayload = { generation: payload.generation };
        },
      },
    );
    await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    const context = {
      requestId: "cancel-first-restore-caller",
      browserId: "unclaimed-iab",
      browserGeneration: 0,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      clientMode: "desktop-continuous" as const,
    };
    const controller = new AbortController();
    const first = mgr.execute(context, { method: "getState", tabId }, controller.signal);
    await vi.waitFor(() => expect(restorePayload).toBeDefined());
    controller.abort();

    const second = mgr.ensureResidentFromRenderer({
      tabId,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    registerGuest(335);
    mgr.attachGuest(tabId, 335, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      residencyGeneration: restorePayload?.generation,
    });

    await expect(second).resolves.toBeUndefined();
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(mgr.hasGuest(tabId)).toBe(true);
  });

  it("BTL15: 上限关闭的持久化删除失败时保留 logical tab 且不通知 renderer", async () => {
    const closed: string[] = [];
    const warnings: string[] = [];
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => null),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => {
        throw new Error("disk unavailable");
      }),
      listShells: vi.fn(async () => []),
    };
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      (tabId) => closed.push(tabId),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        tabLimit: 1,
        recoveryStore,
        warn: (message) => warnings.push(message),
      },
    );
    registerGuest(336);
    mgr.attachGuest("browser:oldest", 336, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    registerGuest(337);
    mgr.attachGuest("browser:newest", 337, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    await mgr.reportResidency({
      tabId: "browser:newest",
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
      selected: false,
      visible: false,
      currentTask: false,
      loading: false,
    });

    expect(closed).toEqual([]);
    expect(mgr.hasGuest("browser:oldest")).toBe(true);
    expect(mgr.hasGuest("browser:newest")).toBe(true);
    expect(warnings.some((message) => message.includes("disk unavailable"))).toBe(true);
  });

  it("BTL07/12: 跨重启 shell 保持 suspended，两个 caller single-flight 恢复同一 guest", async () => {
    const tabId = "browser:restart-single-flight";
    const pageState = restoredPageState(tabId);
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => pageState),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId)]),
    };
    let restoreRequests = 0;
    let replacementSpy: GuestSpy | undefined;
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          restoreRequests += 1;
          const replacement = registerGuest(330);
          replacementSpy = replacement.spy;
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 330, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );

    const shells = await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({ tabId });
    expect(mgr.hasGuest(tabId)).toBe(false);

    const request = {
      tabId,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    };
    await Promise.all([
      mgr.ensureResidentFromRenderer(request),
      mgr.ensureResidentFromRenderer(request),
    ]);

    expect(restoreRequests).toBe(1);
    expect(replacementSpy?.historyRestoreCalls).toHaveLength(1);
    expect(mgr.hasGuest(tabId)).toBe(true);
  });

  it("BTL17/18: 冷恢复返回真实 identity，并在成功后发送同 generation terminal live", async () => {
    const tabId = "browser:restore-terminal";
    const record = restoredShellRecord(tabId);
    record.origin = "agent";
    record.browserId = "browser-real";
    record.browserGeneration = 11;
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => restoredPageState(tabId)),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [record]),
    };
    const restoreEvents: Array<{ generation: number; residency: string }> = [];
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          restoreEvents.push({ generation: payload.generation, residency: payload.residency });
          registerGuest(345);
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 345, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
        onResidencyChanged: (payload) => {
          restoreEvents.push({ generation: payload.generation, residency: payload.residency });
        },
      },
    );

    const shells = await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    expect(shells[0]).toMatchObject({
      browserId: "browser-real",
      browserGeneration: 11,
    });
    await mgr.ensureResidentFromRenderer({
      tabId,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    expect(restoreEvents).toHaveLength(2);
    expect(restoreEvents.map((event) => event.residency)).toEqual(["restoring", "live-background"]);
    expect(restoreEvents[1]?.generation).toBe(restoreEvents[0]?.generation);
  });

  it("BTL17: pageState 与 restoreUrl 都加载失败时销毁 bootstrap guest 并回滚 suspended", async () => {
    const tabId = "browser:restore-double-failure";
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => restoredPageState(tabId)),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId)]),
    };
    const residencyEvents: string[] = [];
    let replacementSpy: GuestSpy | undefined;
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onSuspendTabRequested: (payload) => residencyEvents.push(payload.residency),
        onRestoreTabRequested: (payload) => {
          residencyEvents.push(payload.residency);
          if (payload.residency !== "restoring") return;
          const replacement = registerGuest(346);
          replacementSpy = replacement.spy;
          replacement.spy.historyRestoreErrorBeforeApply = new Error("corrupt page state");
          replacement.spy.loadUrlError = new Error("ERR_NAME_NOT_RESOLVED");
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 346, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );
    await mgr.restoreTabs({ windowId: 1, workspaceKey: "/repo", sessionId: "session-a" });

    await expect(
      mgr.ensureResidentFromRenderer({
        tabId,
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      }),
    ).rejects.toThrow("restore failed");

    expect(residencyEvents).toEqual(["restoring", "suspended"]);
    expect(replacementSpy?.closeCalls).toBe(1);
    expect(mgr.hasGuest(tabId)).toBe(false);
  });

  it("BTL08: 损坏 pageState 删除后按 restoreUrl 降级，logical tab 继续存在", async () => {
    const tabId = "browser:corrupt-page-state";
    const restoreUrl = "https://example.com/url-fallback";
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => restoredPageState(tabId)),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId, restoreUrl)]),
    };
    let replacementSpy: GuestSpy | undefined;
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          const replacement = registerGuest(331);
          replacementSpy = replacement.spy;
          replacement.spy.historyRestoreErrorBeforeApply = new Error("corrupt page state");
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 331, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );
    await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    await mgr.ensureResidentFromRenderer({
      tabId,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    expect(recoveryStore.removePageState).toHaveBeenCalledWith(tabId);
    expect(replacementSpy?.loadedUrl).toBe(restoreUrl);
    expect(mgr.hasGuest(tabId)).toBe(true);
  });

  it("BTL16: pageState active URL 旧于 shell restoreUrl 时按当前 shell URL 冷恢复", async () => {
    const tabId = "browser:stale-page-state";
    const currentUrl = "https://example.com/current-shell";
    const stalePageState: BrowserTabPageStateRecord = {
      schemaVersion: 1,
      tabId,
      entries: [{ url: "https://example.com/old-snapshot", pageState: "old" }],
      activeIndex: 0,
      updatedAt: 1,
    };
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => stalePageState),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId, currentUrl)]),
    };
    let replacementSpy: GuestSpy | undefined;
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          const replacement = registerGuest(341);
          replacementSpy = replacement.spy;
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 341, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );
    await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    await mgr.ensureResidentFromRenderer({
      tabId,
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    expect(recoveryStore.removePageState).toHaveBeenCalledWith(tabId);
    expect(replacementSpy?.historyRestoreCalls).toEqual([]);
    expect(replacementSpy?.loadedUrl).toBe(currentUrl);
  });

  it("BTL13: forced restore 三类事实全缺失时定向关闭 orphan", async () => {
    const tabId = "browser:recovery-orphan";
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => null),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [restoredShellRecord(tabId, null)]),
    };
    const orphanCloses: Array<{ tabId: string; reason: "recovery-orphan" }> = [];
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRecoveryOrphanCloseRequested: (payload) => orphanCloses.push(payload),
        onRestoreTabRequested: (payload) => {
          registerGuest(332);
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 332, {
              windowId: 1,
              workspaceKey: "/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );
    await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });

    await expect(
      mgr.ensureResidentFromRenderer({
        tabId,
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      }),
    ).rejects.toThrow("restore failed");
    expect(orphanCloses).toEqual([{ tabId, reason: "recovery-orphan" }]);
    expect(mgr.hasGuest(tabId)).toBe(false);
  });

  it("BTL19: remote owner 拒绝缺失 remoteSessionId 的 attach，且其它 remote 不可 list/claim", async () => {
    const tabId = "browser:remote-owned";
    const record = restoredShellRecord(tabId);
    record.workspaceKey = "ssh://host/repo";
    record.remoteSessionId = "remote-a";
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => restoredPageState(tabId)),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [record]),
    };
    let mismatchedGuestSpy: GuestSpy | undefined;
    let mgr: InstanceType<typeof BrowserGuestManager>;
    mgr = new BrowserGuestManager(
      undefined,
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        recoveryStore,
        onRestoreTabRequested: (payload) => {
          if (payload.residency !== "restoring") return;
          const mismatched = registerGuest(347);
          mismatchedGuestSpy = mismatched.spy;
          queueMicrotask(() =>
            mgr.attachGuest(payload.tabId, 347, {
              windowId: 1,
              workspaceKey: "ssh://host/repo",
              sessionId: "session-a",
              residencyGeneration: payload.generation,
            }),
          );
        },
      },
    );
    await mgr.restoreTabs({
      windowId: 1,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-a",
      sessionId: "session-a",
    });

    const remoteBContext = {
      requestId: "remote-b-list",
      browserId: "browser-b",
      browserGeneration: 1,
      windowId: 1,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-b",
      sessionId: "session-a",
      clientMode: "desktop-continuous" as const,
    };
    expect((await mgr.execute(remoteBContext, { method: "listUserTabs" })).userTabs).toEqual([]);
    await expect(
      mgr.ensureResidentFromRenderer({
        tabId,
        windowId: 1,
        workspaceKey: "ssh://host/repo",
        remoteSessionId: "remote-a",
        sessionId: "session-a",
      }),
    ).rejects.toThrow("restore failed");
    expect(mismatchedGuestSpy?.closeCalls).toBe(1);

    const claim = await mgr.execute(
      { ...remoteBContext, requestId: "remote-b-claim" },
      { method: "claimTab", tabId },
    );
    expect(claim).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
  });

  it("BTL11: renderer close 校验完整 scope，删除恢复事实并阻止迟到 attach 复活", async () => {
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => null),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => []),
    };
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { recoveryStore },
    );
    registerGuest(310);
    mgr.attachGuest("browser:close-authority", 310, {
      windowId: 8,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-8",
      sessionId: "session-8",
    });

    await expect(
      mgr.closeTabFromRenderer({
        tabId: "browser:close-authority",
        windowId: 9,
        workspaceKey: "ssh://host/repo",
        remoteSessionId: "remote-8",
        sessionId: "session-8",
      }),
    ).rejects.toThrow("unavailable");
    await mgr.closeTabFromRenderer({
      tabId: "browser:close-authority",
      windowId: 8,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-8",
      sessionId: "session-8",
    });
    expect(recoveryStore.remove).toHaveBeenCalledWith("browser:close-authority");
    expect(mgr.hasGuest("browser:close-authority")).toBe(false);

    registerGuest(311);
    mgr.attachGuest("browser:close-authority", 311, {
      windowId: 8,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-8",
      sessionId: "session-8",
    });
    expect(mgr.hasGuest("browser:close-authority")).toBe(false);
  });

  it("BTL23: Agent close 等待恢复仓库删除后才返回成功并通知 renderer", async () => {
    const removeStarted = createDeferred();
    const releaseRemove = createDeferred();
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => null),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => {
        removeStarted.resolve();
        await releaseRemove.promise;
      }),
      listShells: vi.fn(async () => []),
    };
    const closeNotifications: string[] = [];
    // owner 必须一并捕获：renderer 靠它路由到 tab 所属 workspace 的 side pane 状态，
    // 只断言 tabId 的话，回调丢掉 owner 会让"用户切走 workspace 后 Agent 关 tab"重新变成幽灵 tab。
    const closeOwners: unknown[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      (tabId, owner) => {
        closeNotifications.push(tabId);
        closeOwners.push(owner);
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { recoveryStore },
    );
    registerGuest(348);
    mgr.attachGuest("browser:durable-close", 348, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    let settled = false;
    const closeResult = mgr
      .execute(
        {
          requestId: "durable-close",
          browserId: "unclaimed-iab",
          browserGeneration: 0,
          windowId: 1,
          workspaceKey: "/repo",
          sessionId: "session-a",
          clientMode: "desktop-continuous",
        },
        { method: "close", tabId: "browser:durable-close" },
      )
      .finally(() => {
        settled = true;
      });

    await removeStarted.promise;
    expect(settled).toBe(false);
    expect(closeNotifications).toEqual([]);
    releaseRemove.resolve();

    await expect(closeResult).resolves.toMatchObject({ ok: true });
    expect(closeNotifications).toEqual(["browser:durable-close"]);
    // 通知必须带上 attach 时的 owner scope，renderer 才能定位到 /repo 这个 workspace 的 side pane。
    expect(closeOwners).toMatchObject([{ workspaceKey: "/repo", sessionId: "session-a" }]);
    expect(mgr.hasGuest("browser:durable-close")).toBe(false);
  });

  it("BTL24: Agent close 之后 renderer 再次关闭同一 tab 幂等成功，UI 壳不会永久关不掉", async () => {
    const recoveryStore = {
      upsert: vi.fn(async () => undefined),
      upsertPageState: vi.fn(async () => undefined),
      getPageState: vi.fn(async () => null),
      removePageState: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listShells: vi.fn(async () => []),
    };
    const closeNotifications: string[] = [];
    const closeOwners: unknown[] = [];
    const mgr = new BrowserGuestManager(
      undefined,
      undefined,
      (tabId, owner) => {
        closeNotifications.push(tabId);
        closeOwners.push(owner);
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { recoveryStore },
    );
    registerGuest(352);
    mgr.attachGuest("browser:ghost-close", 352, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    await expect(
      mgr.execute(
        {
          requestId: "agent-close",
          browserId: "unclaimed-iab",
          browserGeneration: 0,
          windowId: 1,
          workspaceKey: "/repo",
          sessionId: "session-a",
          clientMode: "desktop-continuous",
        },
        { method: "close", tabId: "browser:ghost-close" },
      ),
    ).resolves.toMatchObject({ ok: true });

    // Bug 回归：Agent close 已把 logical tab 从 main 删除，但 BrowserViewCloseTab 通知可能落在
    // 非当前 workspace 而被 renderer 丢弃，UI 侧仍留着壳。此时用户点 × 会走 renderer close，
    // 旧实现在这里抛 "unavailable for renderer scope"，renderer 拿不到授权就永不移除 UI，
    // 于是该 tab 永远关不掉。main 必须对"已关闭/不存在"的关闭请求幂等放行。
    await expect(
      mgr.closeTabFromRenderer({
        tabId: "browser:ghost-close",
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      }),
    ).resolves.toBeUndefined();
    // 幂等不等于重放：不得再次通知 renderer，也不得让 tab 复活。
    expect(closeNotifications).toEqual(["browser:ghost-close"]);
    // 唯一那次通知必须带上 attach 时的 owner scope，否则 renderer 只能在当前 workspace 找 tab，
    // 用户已切走时通知被丢弃，UI 壳又变回关不掉的幽灵 tab。
    expect(closeOwners).toMatchObject([{ workspaceKey: "/repo", sessionId: "session-a" }]);
    expect(mgr.hasGuest("browser:ghost-close")).toBe(false);
  });

  it("BTL25: renderer 关闭 main 侧未知 tab 时幂等成功，并阻止迟到 attach 复活", async () => {
    const closeNotifications: string[] = [];
    const mgr = new BrowserGuestManager(undefined, undefined, (tabId) =>
      closeNotifications.push(tabId),
    );

    await expect(
      mgr.closeTabFromRenderer({
        tabId: "browser:unknown-shell",
        windowId: 1,
        workspaceKey: "/repo",
        sessionId: "session-a",
      }),
    ).resolves.toBeUndefined();
    expect(closeNotifications).toEqual([]);

    // renderer 已明确表达关闭意图，此后任何迟到 attach 都不得把这个 tab 拉回来。
    registerGuest(353);
    mgr.attachGuest("browser:unknown-shell", 353, {
      windowId: 1,
      workspaceKey: "/repo",
      sessionId: "session-a",
    });
    expect(mgr.hasGuest("browser:unknown-shell")).toBe(false);
  });
  it("BTL26: 远程 human tab 的 renderer close 不因 remoteSessionId 缺失/漂移被拒，但仍拒绝跨 window/workspace/session", async () => {
    // Bug 原因：attach 侧 renderer 用 `tab.remoteSessionId ?? workspaceRemoteSessionId` 兜底冻结 owner，
    // close 侧却只取 tab.remoteSessionId。human tab 从不写该字段，远程下 close payload 必然缺 remoteSessionId，
    // 旧实现在这里抛 "unavailable for renderer scope"，renderer 拿不到授权就永不移除 UI —— tab 永远关不掉。
    // close 是收敛意图：同 window+workspace+session 下关闭自己看得见的 tab 不构成越权，remoteSessionId
    // 的防重连语义只属于 attach。跨 window/workspace/session 的越权关闭仍必须拒绝。
    const mgr = new BrowserGuestManager();
    registerGuest(360);
    mgr.attachGuest("browser:remote-missing", 360, {
      windowId: 1,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-1",
      sessionId: "unscoped",
    });

    for (const overrides of [
      { windowId: 2 },
      { workspaceKey: "ssh://host/other" },
      { sessionId: "other-session" },
    ]) {
      await expect(
        mgr.closeTabFromRenderer({
          tabId: "browser:remote-missing",
          windowId: 1,
          workspaceKey: "ssh://host/repo",
          sessionId: "unscoped",
          ...overrides,
        }),
      ).rejects.toThrow("unavailable for renderer scope");
    }

    // remoteSessionId 缺失（human tab 的真实形态）：必须放行。
    await expect(
      mgr.closeTabFromRenderer({
        tabId: "browser:remote-missing",
        windowId: 1,
        workspaceKey: "ssh://host/repo",
        sessionId: "unscoped",
      }),
    ).resolves.toBeUndefined();
    expect(mgr.hasGuest("browser:remote-missing")).toBe(false);

    // remoteSessionId 漂移（远程重连后的遗留 tab）：同样必须放行，否则又是关不掉。
    registerGuest(361);
    mgr.attachGuest("browser:remote-drift", 361, {
      windowId: 1,
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-1",
      sessionId: "unscoped",
    });
    await expect(
      mgr.closeTabFromRenderer({
        tabId: "browser:remote-drift",
        windowId: 1,
        workspaceKey: "ssh://host/repo",
        remoteSessionId: "remote-2",
        sessionId: "unscoped",
      }),
    ).resolves.toBeUndefined();
    expect(mgr.hasGuest("browser:remote-drift")).toBe(false);
  });

});

describe("BrowserGuestManager.collectMemoryDiagnostics", () => {
  it("返回 tabs / closedTabIds 的只读大小", () => {
    const mgr = new BrowserGuestManager();
    expect(mgr.collectMemoryDiagnostics()).toEqual({ tabs: 0, closedTabIds: 0 });
  });
});
