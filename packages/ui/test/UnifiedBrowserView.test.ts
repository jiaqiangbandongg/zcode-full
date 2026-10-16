// @vitest-environment jsdom
// UnifiedBrowserView 组件测试（<webview> + CDP-on-guest 架构）。
//
// 覆盖三条核心交互契约：
//  1. did-attach → 尽早上报 guest webContentsId 给 main（browserViewAttachGuest）；
//  2. 地址栏回车（form submit）→ 经 normalizeBrowserUrl 归一化后调 webview.loadURL；
//  3. 导航按钮由 webview 状态驱动（canGoBack）并直接调用 webview.goBack。
//
// 注意：根 vitest 只收 packages/*/test/**/*.test.ts（.ts，非 .tsx），故本文件用
// React.createElement 而非 JSX，并以文件头 docblock 单独启用 jsdom 环境。
import { createElement, StrictMode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EmbeddedBrowserWebviewChannels,
  type BrowserViewScreenshotSurfacePreparePayload,
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_LOAD_ERROR,
  TID_BROWSER_LOAD_ERROR_CERT_HINT,
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT,
  TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT,
  TID_BROWSER_RESPONSIVE_RESIZE_LEFT,
  TID_BROWSER_RESPONSIVE_RESIZE_TOP,
  TID_BROWSER_RESPONSIVE_RESIZE_WIDTH,
  TID_BROWSER_RESPONSIVE_SCALED_FRAME,
  TID_BROWSER_RESPONSIVE_TOOLBAR,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_BROWSER_RESPONSIVE_ZOOM_OPTION,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";

// 用 vi.hoisted 定义 mock 依赖，规避 vi.mock 工厂对外部变量的引用限制。
const h = vi.hoisted(() => {
  const attachGuest = vi.fn().mockResolvedValue(undefined);
  const detachGuest = vi.fn().mockResolvedValue(true);
  const reportResidency = vi.fn().mockResolvedValue(undefined);
  const screenshotSurfaceReady = vi.fn();
  const updateViewport = vi.fn().mockResolvedValue(undefined);
  const viewportListeners = new Set<
    (payload: {
      workspaceKey: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
      viewport: { width: number; height: number } | null;
    }) => void
  >();
  const zoomListeners = new Set<(state: { zoomLevel: number }) => void>();
  const openExternal = vi.fn();
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  const settingsState = {
    loading: false,
    settings: null as null | {
      embeddedBrowserViewportPreference: {
        mode: "normal" | "responsive";
        viewport: { width: number; height: number };
        zoom: "fit" | "50" | "75" | "100" | "125" | "150" | "200";
      };
    },
  };
  const platform = {
    browserViewAttachGuest: attachGuest,
    browserViewDetachGuest: detachGuest,
    browserViewReportResidency: reportResidency,
    browserViewScreenshotSurfaceReady: screenshotSurfaceReady,
    browserViewUpdateViewport: updateViewport,
    getDesktopZoomLevel: vi.fn().mockResolvedValue({ zoomLevel: 0 }),
    openExternal,
    onDesktopZoomLevelChanged: (listener: (state: { zoomLevel: number }) => void) => {
      zoomListeners.add(listener);
      listener({ zoomLevel: 0 });
      return () => zoomListeners.delete(listener);
    },
    onBrowserViewViewportChanged: (
      listener: typeof viewportListeners extends Set<infer T> ? T : never,
    ) => {
      viewportListeners.add(listener);
      return () => viewportListeners.delete(listener);
    },
  };
  return {
    attachGuest,
    detachGuest,
    openExternal,
    platform,
    reportResidency,
    screenshotSurfaceReady,
    settingsState,
    updateSettings,
    updateViewport,
    viewportListeners,
    zoomListeners,
  };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => h.platform,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    error: null,
    loading: h.settingsState.loading,
    refresh: vi.fn(),
    settings: h.settingsState.settings,
    update: h.updateSettings,
  }),
}));
// intl 只需把 message id 原样返回即可满足 aria-label / placeholder 断言。
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, number | string>) =>
        id === "browser.responsive.dimensionRangeError"
          ? `range ${values?.min}-${values?.max}`
          : id === "browser.guestFailed.detail"
            ? `${id} ${values?.reason} (${values?.exitCode})`
            : id,
    },
  }),
}));

// 静态 import 放在 mock 之后：vi.mock 会被提升，故被测组件加载到的是 mock 版依赖。
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { HumanBrowserView } from "@/browser-use/HumanBrowserView.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { ResponsiveBrowserViewport } from "@/browser-use/ResponsiveBrowserViewport.js";
import {
  resolveBrowserViewportScale,
  resolveResponsiveBrowserGuestLayout,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import {
  resolveDesktopZoomFactor,
  useDesktopZoomFactor,
} from "@/browser-use/useDesktopZoomFactor.js";
import { INITIAL_BROWSER_STATE } from "@/embeddedBrowserHelpers.js";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}

  emit(width: number, height: number) {
    this.callback(
      [
        {
          contentRect: { width, height },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

// BrowserToolbar 的图标按钮走 ControlHintTooltip（radix Tooltip），需 TooltipProvider 包裹。
function createViewElement(
  browserKey = "session-1",
  sessionId?: string,
  browserUseOperationUntil?: number,
  isVisible = true,
  browserResizeBaselineVersion?: number,
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null,
  deferEmptyGuest = false,
) {
  return createElement(
    TooltipProvider,
    null,
    createElement(UnifiedBrowserView, {
      browserKey,
      isVisible,
      sessionId,
      browserUseOperationUntil,
      browserResizeBaselineVersion,
      screenshotSurfaceRequest,
      deferEmptyGuest,
    }),
  );
}

function renderView(
  browserKey = "session-1",
  sessionId?: string,
  browserUseOperationUntil?: number,
  isVisible = true,
  browserResizeBaselineVersion?: number,
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null,
  deferEmptyGuest = false,
) {
  return render(
    createViewElement(
      browserKey,
      sessionId,
      browserUseOperationUntil,
      isVisible,
      browserResizeBaselineVersion,
      screenshotSurfaceRequest,
      deferEmptyGuest,
    ),
  );
}

function createHumanViewElement(browserKey = "human-tab-1", agentOpened = false) {
  return createElement(
    TooltipProvider,
    null,
    createElement(HumanBrowserView, {
      browserKey,
      isVisible: true,
      sessionId: "task-human",
      agentOpened,
    }),
  );
}

function renderHumanView(browserKey = "human-tab-1", agentOpened = false) {
  return render(createHumanViewElement(browserKey, agentOpened));
}

/** jsdom 下 <webview> 是普通 HTMLElement，没有 Electron guest 方法；这里补桩。 */
function stubWebview(el: HTMLElement, over: Record<string, unknown> = {}) {
  Object.assign(el, {
    getWebContentsId: vi.fn(() => 42),
    getURL: vi.fn(() => "about:blank"),
    getTitle: vi.fn(() => ""),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    loadURL: vi.fn(() => Promise.resolve()),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    openDevTools: vi.fn(),
    setZoomFactor: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    ...over,
  });
  return el;
}

function fireDomReady(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new Event("dom-ready"));
  });
}

function fireDidAttach(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new Event("did-attach"));
  });
}

/** 派发主 frame 加载失败事件；Electron 的 did-fail-load 带 isMainFrame 与 net error 码。 */
function fireDidFailLoad(
  el: HTMLElement,
  detail: { errorCode: number; errorDescription: string; validatedURL: string },
) {
  const event = new Event("did-fail-load");
  Object.assign(event, { ...detail, isMainFrame: true });
  act(() => {
    el.dispatchEvent(event);
  });
}

function fireRenderProcessGone(el: HTMLElement, reason: string, exitCode = 1) {
  const event = new Event("render-process-gone");
  Object.assign(event, { details: { exitCode, reason } });
  act(() => {
    el.dispatchEvent(event);
  });
}

function dragResizeHandle(handle: HTMLElement, pointerId: number, delta: { x: number; y: number }) {
  fireEvent.pointerDown(handle, {
    button: 0,
    clientX: 100,
    clientY: 100,
    pointerId,
    pointerType: "mouse",
  });
  fireEvent.pointerMove(handle, {
    buttons: 1,
    clientX: 100 + delta.x,
    clientY: 100 + delta.y,
    pointerId,
    pointerType: "mouse",
  });
  fireEvent.pointerUp(handle, { pointerId, pointerType: "mouse" });
}

function ResponsiveViewportHarness({
  isComposed = true,
  zoom,
}: {
  isComposed?: boolean;
  zoom: BrowserViewportZoom;
}) {
  const [viewportSize, setViewportSize] = useState({ width: 393, height: 852 });
  const desktopZoomFactor = useDesktopZoomFactor();
  return createElement(
    ResponsiveBrowserViewport,
    {
      active: true,
      desktopZoomFactor,
      isComposed,
      onViewportSizeChange: setViewportSize,
      viewportSize,
      zoom,
    },
    createElement("div", { "data-testid": "viewport-child" }),
  );
}

beforeEach(() => {
  cleanup();
  h.attachGuest.mockClear();
  h.detachGuest.mockReset();
  h.detachGuest.mockResolvedValue(true);
  h.openExternal.mockClear();
  h.reportResidency.mockClear();
  h.screenshotSurfaceReady.mockClear();
  h.settingsState.loading = false;
  h.settingsState.settings = null;
  h.updateSettings.mockReset();
  h.updateSettings.mockResolvedValue(undefined);
  h.updateViewport.mockReset();
  h.updateViewport.mockResolvedValue(undefined);
  h.viewportListeners.clear();
  h.zoomListeners.clear();
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("UnifiedBrowserView (<webview>)", () => {
  it("webview 节点始终带固定白色背景", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserViewportSurface, {
        browserRegionRef: { current: null },
        browserState: INITIAL_BROWSER_STATE,
        desktopZoomFactor: 1,
        formatMessage: ({ id }) => id,
        isEmptyBrowserState: false,
        isComposed: true,
        isResponsiveMode: false,
        onRetryGuest: vi.fn(),
        onViewportResize: vi.fn(),
        onViewportSizeChange: vi.fn(),
        onWebviewRef: vi.fn(),
        showResizeWarning: false,
        webviewGeneration: 0,
        viewportSize: { width: 393, height: 852 },
        viewportZoom: "fit",
      }),
    );

    expect(markup).toContain('style="background-color:#fff"');
  });

  it("延迟 guest 的空置态不创建 webview", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserViewportSurface, {
        browserRegionRef: { current: null },
        browserState: INITIAL_BROWSER_STATE,
        desktopZoomFactor: 1,
        formatMessage: ({ id }) => id,
        isEmptyBrowserState: true,
        shouldMountWebview: false,
        isComposed: true,
        isResponsiveMode: false,
        onRetryGuest: vi.fn(),
        onViewportResize: vi.fn(),
        onViewportSizeChange: vi.fn(),
        onWebviewRef: vi.fn(),
        showResizeWarning: false,
        webviewGeneration: 0,
        viewportSize: { width: 393, height: 852 },
        viewportZoom: "fit",
      }),
    );

    expect(markup).not.toContain("<webview");
    expect(markup).toContain("lucide-globe");
    expect(markup).not.toContain("lucide-loader");
  });

  it("新 human tab 与未提交地址草稿不创建 webview，回车后才创建并导航", () => {
    renderView("browser:empty-draft", "task-a", undefined, true, undefined, undefined, true);

    expect(screen.getByText("browser.empty")).toBeTruthy();
    expect(screen.queryByTestId(TID_BROWSER_WEBVIEW)).toBeNull();

    const addressInput = screen.getByTestId(TID_BROWSER_ADDRESS_INPUT);
    fireEvent.change(addressInput, { target: { value: "example.com" } });
    expect(screen.getByText("browser.empty")).toBeTruthy();
    expect(screen.queryByTestId(TID_BROWSER_WEBVIEW)).toBeNull();

    fireEvent.submit(addressInput.closest("form")!);
    expect(screen.queryByText("browser.empty")).toBeNull();
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(webview);
    expect(webview.loadURL).toHaveBeenCalledWith("https://example.com");
  });

  it("在 guest attach 前声明 popup 权限", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserViewportSurface, {
        browserRegionRef: { current: null },
        browserState: INITIAL_BROWSER_STATE,
        desktopZoomFactor: 1,
        formatMessage: ({ id }) => id,
        isEmptyBrowserState: false,
        isComposed: true,
        isResponsiveMode: false,
        onRetryGuest: vi.fn(),
        onRetryLoad: vi.fn(),
        onViewportResize: vi.fn(),
        onViewportSizeChange: vi.fn(),
        onWebviewRef: vi.fn(),
        showResizeWarning: false,
        webviewGeneration: 0,
        viewportSize: { width: 393, height: 852 },
        viewportZoom: "fit",
      }),
    );

    // 修复原因：ref 回调发生在 Electron guest attach 之后，只断言挂载后的最终 DOM
    // 会掩盖 popup 权限从未进入 guest 创建参数的问题；静态标记可约束创建期属性。
    expect(markup).toContain('<webview allowpopups=""');
  });

  it("固定缩放档位解析为对应视觉比例", () => {
    const canvasSize = { width: 1000, height: 1000 };
    const viewportSize = { width: 393, height: 852 };
    expect(
      (["50", "75", "100", "125", "150", "200"] as const).map((zoom) =>
        resolveBrowserViewportScale({ canvasSize, viewportSize, zoom }),
      ),
    ).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
  });

  it("Desktop zoom 全档位按 Electron guest surface 语义解析布局补偿", () => {
    for (let zoomLevel = -3; zoomLevel <= 5; zoomLevel += 1) {
      const desktopZoomFactor = resolveDesktopZoomFactor(zoomLevel);
      const layout = resolveResponsiveBrowserGuestLayout(desktopZoomFactor);
      expect(layout.layoutScale).toBeCloseTo(desktopZoomFactor < 1 ? 1 / desktopZoomFactor : 1);
      expect(layout.transformScale).toBeCloseTo(desktopZoomFactor < 1 ? desktopZoomFactor : 1);
    }
    expect(resolveResponsiveBrowserGuestLayout(Number.NaN)).toEqual({
      layoutScale: 1,
      transformScale: 1,
    });
  });

  it("自由尺寸固定比例会抵消 Desktop 全局缩放且保持 guest CSS viewport", () => {
    render(createElement(ResponsiveViewportHarness, { zoom: "100" }));
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const scaledFrame = screen.getByTestId(TID_BROWSER_RESPONSIVE_SCALED_FRAME);
    expect(viewport.dataset.responsiveScale).toBe("1");
    expect(viewport.style.transform).toBe("scale(1)");

    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 1 });
    });

    const desktopZoomFactor = resolveDesktopZoomFactor(1);
    const rendererScale = 1 / desktopZoomFactor;
    expect(Number.parseFloat(viewport.style.transform.slice(6))).toBeCloseTo(rendererScale);
    expect(Number.parseFloat(scaledFrame.style.width)).toBeCloseTo(393 * rendererScale);
    expect(Number.parseFloat(scaledFrame.style.height)).toBeCloseTo(852 * rendererScale);
    expect(viewport.dataset.responsiveScale).toBe("1");
    expect(viewport.style.width).toBe("393px");
    expect(viewport.style.height).toBe("852px");

    // 同样 20 个屏幕视觉像素在 +1 档下对应 20 / 1.1 个 renderer client px；
    // 反向补偿后仍只增加 20 CSS viewport px。
    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH), 20, {
      x: 20 / desktopZoomFactor,
      y: 0,
    });
    expect(viewport.style.width).toBe("413px");
  });

  it("Fit 在 Desktop 全局缩放下按实际画布解析但 renderer footprint 不重复放大", () => {
    render(createElement(ResponsiveViewportHarness, { zoom: "fit" }));
    const fitObserver = FakeResizeObserver.instances.at(-1);
    expect(fitObserver).toBeDefined();

    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 1 });
    });
    const fitObserverAfterZoom = FakeResizeObserver.instances.at(-1);
    expect(fitObserverAfterZoom).not.toBe(fitObserver);
    act(() => fitObserverAfterZoom?.emit(500, 600));

    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const scaledFrame = screen.getByTestId(TID_BROWSER_RESPONSIVE_SCALED_FRAME);
    const desktopZoomFactor = resolveDesktopZoomFactor(1);
    const expectedRendererScale = 568 / 852;
    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(
      expectedRendererScale * desktopZoomFactor,
    );
    expect(Number.parseFloat(viewport.style.transform.slice(6))).toBeCloseTo(expectedRendererScale);
    expect(Number.parseFloat(scaledFrame.style.height)).toBeCloseTo(568);
  });

  it("Desktop zoom 动态变化时重新采样 Fit 画布", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 500,
      top: 0,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    render(createElement(ResponsiveViewportHarness, { zoom: "fit" }));
    const observerCountBeforeZoom = FakeResizeObserver.instances.length;
    const rectReadCountBeforeZoom = rectSpy.mock.calls.length;

    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 1 });
    });

    expect(FakeResizeObserver.instances.length).toBeGreaterThan(observerCountBeforeZoom);
    expect(rectSpy.mock.calls.length).toBeGreaterThan(rectReadCountBeforeZoom);
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const desktopZoomFactor = resolveDesktopZoomFactor(1);
    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(
      ((600 - 32) * desktopZoomFactor) / 852,
    );
    rectSpy.mockRestore();
  });

  it("did-attach 在首次导航前上报 guest，dom-ready 不重复上报同一活跃状态", () => {
    renderView("session-1", "task-1");
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    expect(el.getAttribute("nodeintegrationinsubframes")).toBe("true");
    fireDidAttach(el);
    expect(h.attachGuest).toHaveBeenCalledTimes(1);
    fireDomReady(el);
    expect(h.attachGuest).toHaveBeenCalledTimes(1);
    expect(h.attachGuest.mock.calls[0][0]).toEqual({
      key: "session-1",
      webContentsId: 42,
      active: true,
      sessionId: "task-1",
    });
  });

  it("browser-use tab 使用冻结的 workspaceKey，不随当前 ambient workspace 漂移", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser-use:scope-owner",
          isVisible: true,
          workspaceKey: "workspace-owner",
          workspacePath: "/ambient-workspace",
          workspaceIdentity: "ambient-workspace",
          remoteSessionId: "remote-owner",
          sessionId: "session-owner",
        }),
      ),
    );
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDidAttach(el);

    expect(h.attachGuest).toHaveBeenCalledWith({
      key: "browser-use:scope-owner",
      webContentsId: 42,
      active: true,
      workspaceKey: "workspace-owner",
      remoteSessionId: "remote-owner",
      sessionId: "session-owner",
    });
  });

  it("scope fingerprint 变化时即使 webContentsId 不变也重新 attach", () => {
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser-use:scope-fingerprint",
          isVisible: true,
          workspaceKey: "workspace-a",
          workspacePath: "/workspace-a",
          sessionId: "session-a",
        }),
      ),
    );
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDidAttach(el);
    expect(h.attachGuest).toHaveBeenCalledTimes(1);

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser-use:scope-fingerprint",
          isVisible: true,
          workspaceKey: "workspace-b",
          workspacePath: "/workspace-b",
          sessionId: "session-b",
        }),
      ),
    );

    expect(h.attachGuest).toHaveBeenCalledTimes(2);
    expect(h.attachGuest.mock.calls.at(-1)?.[0]).toEqual({
      key: "browser-use:scope-fingerprint",
      webContentsId: 42,
      active: true,
      workspaceKey: "workspace-b",
      sessionId: "session-b",
    });
  });

  it("把 favicon 写入 residency shell，供挂起与冷启动恢复", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser:favicon",
          faviconUrl: "https://example.com/favicon.ico",
          isVisible: true,
          sessionId: "task-1",
          workspaceIdentity: "remote:ssh:dev:/repo",
          workspacePath: "/repo",
        }),
      ),
    );

    expect(h.reportResidency).toHaveBeenCalledWith(
      expect.objectContaining({
        faviconUrl: "https://example.com/favicon.ico",
        tabId: "browser:favicon",
        workspaceKey: "remote:ssh:dev:/repo",
      }),
    );
  });

  it("父组件刷新 metadata 回调时不重绑一次性 favicon 事件", () => {
    const addEventListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    try {
      const firstCallback = vi.fn();
      const view = render(
        createElement(
          TooltipProvider,
          null,
          createElement(UnifiedBrowserView, {
            browserKey: "browser:stable-favicon-listener",
            isVisible: true,
            onPageMetadataChange: firstCallback,
          }),
        ),
      );
      const faviconListenerCount = () =>
        addEventListener.mock.calls.filter(([eventName]) => eventName === "page-favicon-updated")
          .length;

      expect(faviconListenerCount()).toBe(1);
      view.rerender(
        createElement(
          TooltipProvider,
          null,
          createElement(UnifiedBrowserView, {
            browserKey: "browser:stable-favicon-listener",
            isVisible: true,
            onPageMetadataChange: vi.fn(),
          }),
        ),
      );

      expect(faviconListenerCount()).toBe(1);
    } finally {
      addEventListener.mockRestore();
    }
  });

  it("后台 guest 被 killed 后先等 main 断开旧 CDP，再替换并重新 attach", async () => {
    const restoreUrl = "https://example.com/restorable";
    const onUrlChange = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser-use:tab-1",
          initialUrl: restoreUrl,
          isVisible: false,
          onUrlChange,
          sessionId: "task-a",
          workspaceIdentity: "remote:ssh:dev:/repo",
          workspacePath: "/repo",
        }),
      ),
    );
    const originalWebview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => restoreUrl),
    });
    fireDomReady(originalWebview);
    act(() => {
      originalWebview.dispatchEvent(new Event("did-stop-loading"));
    });
    expect(onUrlChange).toHaveBeenCalledWith(restoreUrl);

    h.attachGuest.mockClear();
    let finishDetach: ((detached: boolean) => void) | undefined;
    const detachCompleted = new Promise<boolean>((resolve) => {
      finishDetach = resolve;
    });
    h.detachGuest.mockReturnValueOnce(detachCompleted);
    fireRenderProcessGone(originalWebview, "killed");

    expect(h.detachGuest).toHaveBeenCalledWith({
      key: "browser-use:tab-1",
      webContentsId: 42,
    });
    // Electron 的 native DevToolsSession 还可能有在途通知；main ACK 前销毁旧节点会重开 UAF 窗口。
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(originalWebview);

    await act(async () => {
      finishDetach?.(true);
      await detachCompleted;
    });

    const recoveredWebview = screen.getByTestId(TID_BROWSER_WEBVIEW);
    expect(recoveredWebview).not.toBe(originalWebview);
    stubWebview(recoveredWebview, {
      getWebContentsId: vi.fn(() => 43),
    });
    fireDomReady(recoveredWebview);

    expect(h.attachGuest).toHaveBeenCalledWith({
      key: "browser-use:tab-1",
      webContentsId: 43,
      active: false,
      sessionId: "task-a",
      workspaceKey: "remote:ssh:dev:/repo",
    });
    const loadURL = (recoveredWebview as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL;
    expect(loadURL).toHaveBeenCalledWith(restoreUrl);
  });

  it("main 未确认 CDP detach 时保留旧 webview 并转为可重试失败态", async () => {
    renderView("browser:detach-rejected", "task-a");
    const originalWebview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(originalWebview);
    h.detachGuest.mockResolvedValueOnce(false);

    fireRenderProcessGone(originalWebview, "killed", 73);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(originalWebview);
    expect(screen.getByText("browser.guestFailed.title")).toBeTruthy();
    expect(screen.getByText(/killed \(73\)/)).toBeTruthy();
  });

  it("证书失败后再输入非法地址，错误态不沿用上一次的证书指引", () => {
    renderView("browser:cert-then-invalid", "task-a");
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => "https://intranet.test/"),
    });
    fireDomReady(webview);
    fireDidFailLoad(webview, {
      errorCode: -202,
      errorDescription: "ERR_CERT_AUTHORITY_INVALID",
      validatedURL: "https://intranet.test/",
    });
    expect(screen.getByTestId(TID_BROWSER_LOAD_ERROR_CERT_HINT)).toBeTruthy();

    // 地址非法这条错误没有 net error 码，若不清 loadErrorCode，就会继续挂着上一次的 -202
    // 而给出"去开忽略证书校验"的误导指引。
    const addressInput = screen.getByTestId(TID_BROWSER_ADDRESS_INPUT);
    fireEvent.change(addressInput, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(addressInput.closest("form")!);

    expect(screen.getByText("browser.invalidUrl")).toBeTruthy();
    expect(screen.queryByTestId(TID_BROWSER_LOAD_ERROR_CERT_HINT)).toBeNull();
  });

  it("guest 进程级失败盖过加载失败错误态", () => {
    renderView("browser:guest-over-load", "task-a");
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(webview);
    fireDidFailLoad(webview, {
      errorCode: -202,
      errorDescription: "ERR_CERT_AUTHORITY_INVALID",
      validatedURL: "https://intranet.test/",
    });
    expect(screen.getByTestId(TID_BROWSER_LOAD_ERROR)).toBeTruthy();

    // guest 连画面都没有，必须让位给可重建 guest 的失败态，而不是继续画"这次导航被拒"。
    fireRenderProcessGone(webview, "launch-failed");

    expect(screen.queryByTestId(TID_BROWSER_LOAD_ERROR)).toBeNull();
  });

  it("错误态的重新加载按钮重走当前地址，不重建 guest", () => {
    const restoreUrl = "https://intranet.test/";
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser:retry-load",
          initialUrl: restoreUrl,
          isVisible: true,
          sessionId: "task-a",
        }),
      ),
    );
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => restoreUrl),
    });
    fireDomReady(webview);
    fireDidFailLoad(webview, {
      errorCode: -202,
      errorDescription: "ERR_CERT_AUTHORITY_INVALID",
      validatedURL: restoreUrl,
    });

    const loadURL = (webview as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL;
    loadURL.mockClear();
    fireEvent.click(screen.getByText("browser.loadError.retry"));

    expect(loadURL).toHaveBeenCalledWith(restoreUrl);
    // 同一个 guest 继续用，不能因为一次导航失败就重建并丢掉网页历史。
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(webview);
  });

  it("证书类加载失败画出可读错误态并给出放行指引，而不是留下空白页", () => {
    renderView("browser:cert-error", "task-a");
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => "https://intranet.test/"),
    });
    fireDomReady(webview);

    fireDidFailLoad(webview, {
      errorCode: -202,
      errorDescription: "ERR_CERT_AUTHORITY_INVALID",
      validatedURL: "https://intranet.test/",
    });

    // Bug 原因：errorMessage 过去只写进 state 没有渲染消费者，空置态又被同时关掉，
    // Electron `<webview>` 也没有 Chrome 的安全插页，最终只剩一张纯黑的 chrome-error 页。
    expect(screen.getByTestId(TID_BROWSER_LOAD_ERROR)).toBeTruthy();
    expect(screen.getByTestId(TID_BROWSER_LOAD_ERROR_CERT_HINT)).toBeTruthy();
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).className).toContain("hidden");
  });

  it("非证书类加载失败画错误态但不给证书指引", () => {
    renderView("browser:dns-error", "task-a");
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => "https://nonexistent.test/"),
    });
    fireDomReady(webview);

    fireDidFailLoad(webview, {
      errorCode: -105,
      errorDescription: "ERR_NAME_NOT_RESOLVED",
      validatedURL: "https://nonexistent.test/",
    });

    expect(screen.getByTestId(TID_BROWSER_LOAD_ERROR)).toBeTruthy();
    expect(screen.queryByTestId(TID_BROWSER_LOAD_ERROR_CERT_HINT)).toBeNull();
  });

  it("guest 启动或完整性失败时保留错误，不进入重建循环", () => {
    renderView("browser:launch-failed", "task-a");
    const originalWebview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(originalWebview);
    h.attachGuest.mockClear();

    fireRenderProcessGone(originalWebview, "launch-failed");

    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(originalWebview);
    expect(h.attachGuest).not.toHaveBeenCalled();
  });

  it("guest 启动失败时展示失败态与诊断信息，不再裸露容器底色", () => {
    renderView("browser:launch-failed-surface", "task-a");
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(webview);

    fireRenderProcessGone(webview, "launch-failed", 72);

    expect(screen.getByText("browser.guestFailed.title")).toBeTruthy();
    expect(screen.getByText("browser.guestFailed.description")).toBeTruthy();
    expect(screen.getByText(/launch-failed \(72\)/)).toBeTruthy();
    expect(screen.queryByText("browser.empty")).toBeNull();
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).className).toContain("hidden");
  });

  it("失败态点击重试时重建 guest 并恢复最近 URL", async () => {
    const restoreUrl = "https://example.com/restorable";
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser-use:tab-retry",
          initialUrl: restoreUrl,
          isVisible: true,
          sessionId: "task-a",
          workspaceIdentity: "remote:ssh:dev:/repo",
          workspacePath: "/repo",
        }),
      ),
    );
    const originalWebview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => restoreUrl),
    });
    fireDomReady(originalWebview);
    act(() => {
      originalWebview.dispatchEvent(new Event("did-stop-loading"));
    });

    fireRenderProcessGone(originalWebview, "launch-failed", 72);
    h.attachGuest.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "browser.guestFailed.retry" }));
      await Promise.resolve();
    });

    const retriedWebview = screen.getByTestId(TID_BROWSER_WEBVIEW);
    expect(retriedWebview).not.toBe(originalWebview);
    expect(screen.queryByText("browser.guestFailed.title")).toBeNull();

    stubWebview(retriedWebview, { getWebContentsId: vi.fn(() => 43) });
    fireDomReady(retriedWebview);
    expect(h.attachGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "browser-use:tab-retry",
        webContentsId: 43,
      }),
    );
    const loadURL = (retriedWebview as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL;
    expect(loadURL).toHaveBeenCalledWith(restoreUrl);
  });

  it("失败后直接输入新 URL 能退出失败态并用新 guest 导航", async () => {
    renderView("browser:launch-failed-address-navigation", "task-a");
    const originalWebview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(originalWebview);
    fireRenderProcessGone(originalWebview, "launch-failed", 72);

    const addressInput = screen.getByTestId(TID_BROWSER_ADDRESS_INPUT);
    expect(addressInput.className).toContain("h-8");
    expect(addressInput.className).toContain("rounded-full");
    fireEvent.change(addressInput, { target: { value: "https://example.com/after-failure" } });
    await act(async () => {
      fireEvent.submit(addressInput.closest("form")!);
      await Promise.resolve();
    });

    const replacementWebview = screen.getByTestId(TID_BROWSER_WEBVIEW);
    expect(replacementWebview).not.toBe(originalWebview);
    expect(screen.queryByText("browser.guestFailed.title")).toBeNull();

    stubWebview(replacementWebview, { getWebContentsId: vi.fn(() => 44) });
    fireDomReady(replacementWebview);
    const loadURL = (replacementWebview as unknown as { loadURL: ReturnType<typeof vi.fn> })
      .loadURL;
    expect(loadURL).toHaveBeenCalledWith("https://example.com/after-failure");
  });

  it("失败态的外部 navigationRequest 重建 guest，并在导航接管后回执", async () => {
    const request = {
      id: "navigation-after-launch-failed",
      url: "https://example.com/external-after-failure",
    };
    const onNavigationRequestHandled = vi.fn();
    const createNavigationView = (navigationRequest: typeof request | null) =>
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "browser:launch-failed-external-navigation",
          isVisible: true,
          navigationRequest,
          onNavigationRequestHandled,
          sessionId: "task-a",
        }),
      );
    const view = render(createNavigationView(null));
    const originalWebview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(originalWebview);
    fireRenderProcessGone(originalWebview, "launch-failed", 72);

    view.rerender(createNavigationView(request));
    await act(async () => {
      await Promise.resolve();
    });

    const replacementWebview = screen.getByTestId(TID_BROWSER_WEBVIEW);
    expect(replacementWebview).not.toBe(originalWebview);
    expect(screen.queryByText("browser.guestFailed.title")).toBeNull();
    expect(onNavigationRequestHandled).not.toHaveBeenCalled();

    let finishNavigation: (() => void) | undefined;
    const navigationFinished = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    const loadURL = vi.fn(() => navigationFinished);
    stubWebview(replacementWebview, { loadURL });
    fireDomReady(replacementWebview);
    expect(loadURL).toHaveBeenCalledWith(request.url);
    expect(onNavigationRequestHandled).not.toHaveBeenCalled();

    await act(async () => {
      finishNavigation?.();
      await navigationFinished;
    });
    expect(onNavigationRequestHandled).toHaveBeenCalledOnce();
    expect(onNavigationRequestHandled).toHaveBeenCalledWith(request.id);
  });

  it("自由尺寸放大时重发 metrics 且不扩张 webview，缩小保留布局反补偿", async () => {
    renderView("session-zoom", "task-zoom");
    const setZoomFactor = vi.fn();
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      setZoomFactor,
    });
    fireDomReady(webview);
    // 先让 useDesktopZoomFactor 的初始异步读取落定，避免它覆盖下面主动派发的 zoom 档位。
    await act(async () => {
      await Promise.resolve();
    });
    expect(setZoomFactor).not.toHaveBeenCalled();
    expect(webview.style.transform).toBe("");

    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 1 });
    });
    expect(setZoomFactor).not.toHaveBeenCalled();
    expect(webview.style.transform).toBe("");

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
    await act(async () => {
      await Promise.resolve();
    });
    const enlargeZoomFactor = resolveDesktopZoomFactor(1);
    expect(webview.style.transform).toBe("");
    expect(webview.style.position).toBe("");
    expect(webview.style.width).toBe("");
    expect(webview.style.height).toBe("");
    expect(webview.dataset.browserCompositorScale).toBe(String(enlargeZoomFactor));
    expect(webview.dataset.browserLayoutScale).toBe("1");
    expect(webview.dataset.browserTransformScale).toBe("1");
    const updateCountAfterEnter = h.updateViewport.mock.calls.length;

    let resolveViewportSync: (() => void) | undefined;
    h.updateViewport.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveViewportSync = resolve;
        }),
    );
    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 2 });
    });
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
    const secondEnlargeZoomFactor = resolveDesktopZoomFactor(2);
    expect(webview.style.transform).toBe("");
    expect(webview.dataset.browserCompositorScale).toBe(String(secondEnlargeZoomFactor));
    expect(webview.style.position).toBe("");
    expect(webview.dataset.browserLayoutScale).toBe("1");
    expect(webview.dataset.browserTransformScale).toBe("1");
    expect(h.updateViewport.mock.calls.length).toBeGreaterThan(updateCountAfterEnter);
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-zoom",
      viewport: { width: 393, height: 852 },
    });
    const zoomCallsBeforeMetricsResolved = setZoomFactor.mock.calls.length;
    expect(resolveViewportSync).toBeDefined();
    await act(async () => {
      resolveViewportSync?.();
      await Promise.resolve();
    });
    // Desktop page zoom 的传播可能晚于 React effect；必须在 main 完成 metrics 后
    // 再归一一次 guest zoom，锁住曾导致右侧、底部留白的竞态。
    expect(setZoomFactor.mock.calls.length).toBeGreaterThan(zoomCallsBeforeMetricsResolved);
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);

    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: -2 });
    });
    const shrinkZoomFactor = resolveDesktopZoomFactor(-2);
    const shrinkLayoutScale = 1 / shrinkZoomFactor;
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(webview.style.transform).toBe(`scale(${shrinkZoomFactor})`);
    expect(webview.style.position).toBe("absolute");
    expect(Number.parseFloat(webview.style.width.slice(5))).toBeCloseTo(shrinkLayoutScale * 100);
    expect(Number.parseFloat(webview.style.height.slice(5))).toBeCloseTo(shrinkLayoutScale * 100);
    expect(webview.dataset.browserLayoutScale).toBe(String(shrinkLayoutScale));
    expect(webview.dataset.browserTransformScale).toBe(String(shrinkZoomFactor));

    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 2 });
    });
    expect(webview.style.position).toBe("");
    expect(webview.style.transform).toBe("");
    expect(webview.dataset.browserLayoutScale).toBe("1");

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(setZoomFactor).toHaveBeenLastCalledWith(resolveDesktopZoomFactor(2));
    expect(webview.style.transform).toBe("");
    expect(webview.dataset.browserCompositorScale).toBeUndefined();
    expect(webview.dataset.browserLayoutScale).toBeUndefined();
    expect(webview.dataset.browserTransformScale).toBeUndefined();

    const callCountAfterExit = setZoomFactor.mock.calls.length;
    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 3 });
    });
    expect(setZoomFactor).toHaveBeenCalledTimes(callCountAfterExit);
  });

  it("attach guest 使用 workspaceIdentity 作为隔离 key", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(UnifiedBrowserView, {
          browserKey: "human-tab",
          isVisible: true,
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:dev:/repo",
          sessionId: "task-remote",
        }),
      ),
    );
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDomReady(el);
    expect(h.attachGuest).toHaveBeenCalledWith({
      key: "human-tab",
      webContentsId: 42,
      active: true,
      workspaceKey: "remote:ssh:dev:/repo",
      sessionId: "task-remote",
    });
  });

  it("地址栏回车触发 webview.loadURL（url 经 normalize）", () => {
    renderView();
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    // 先 dom-ready 让 isReady=true，否则导航会排队而非立即 loadURL。
    fireDomReady(el);

    const input = screen.getByTestId(TID_BROWSER_ADDRESS_INPUT) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "example.com" } });
    // BrowserToolbar 是 <form onSubmit>；jsdom 不实现隐式提交，直接提交 form 等价于回车语义。
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    const loadURL = (el as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL;
    expect(loadURL).toHaveBeenCalledTimes(1);
    // normalizeBrowserUrl 给无协议输入补全 scheme（公网域名 → https://example.com）。
    expect(loadURL.mock.calls[0][0]).toBe("https://example.com");
  });

  it("后退按钮由 webview.canGoBack 驱动，点击调用 webview.goBack", () => {
    renderView();
    const back = screen.getByTestId(TID_BROWSER_BACK_BUTTON) as HTMLButtonElement;
    // 初始：webview 未就绪 → canGoBack 未知 → 后退禁用。
    expect(back.disabled).toBe(true);

    // canGoBack 返回 true 后 dom-ready 同步状态 → 后退可用。
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      canGoBack: vi.fn(() => true),
    });
    fireDomReady(el);
    expect(back.disabled).toBe(false);

    // 点击后退 → 直接驱动 webview.goBack（不再经 main IPC）。
    fireEvent.click(back);
    const goBack = (el as unknown as { goBack: ReturnType<typeof vi.fn> }).goBack;
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it("地址栏右侧只常驻自由尺寸、元素选择和更多，并按优先级折叠外部打开与调试", () => {
    renderView();

    const responsiveButton = screen.getByLabelText("browser.responsive.enter");
    const elementPickerButton = screen.getByLabelText("browser.elementPicker.start");
    const moreButton = screen.getByLabelText("browser.more");

    expect(
      responsiveButton.compareDocumentPosition(elementPickerButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      elementPickerButton.compareDocumentPosition(moreButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.queryByLabelText("browser.openExternal")).toBeNull();
    expect(screen.queryByLabelText("browser.devtools")).toBeNull();

    fireEvent.pointerDown(moreButton, { button: 0, ctrlKey: false });

    const openExternalItem = screen.getByRole("menuitem", {
      name: "browser.openExternal",
    });
    const devtoolsItem = screen.getByRole("menuitem", {
      name: "browser.devtools",
    });
    expect(openExternalItem.getAttribute("aria-disabled")).toBe("true");
    expect(devtoolsItem.getAttribute("aria-disabled")).toBe("true");
    expect(
      openExternalItem.compareDocumentPosition(devtoolsItem) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("在默认浏览器中打开当前已加载的 http/https URL，不读取未提交的地址栏草稿", () => {
    renderView();
    const currentUrl = "https://example.com/current";
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL: vi.fn(() => currentUrl),
    });
    fireDomReady(el);

    fireEvent.change(screen.getByTestId(TID_BROWSER_ADDRESS_INPUT), {
      target: { value: "https://draft.example.com/not-submitted" },
    });
    fireEvent.pointerDown(screen.getByLabelText("browser.more"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "browser.openExternal" }));

    expect(h.openExternal).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith(currentUrl);
  });

  it("本地 file 页面允许外部打开，调试菜单项仍打开 DevTools", () => {
    renderView();
    const openDevTools = vi.fn();
    const getURL = vi.fn(() => "file:///workspace/index.html");
    const el = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getURL,
      openDevTools,
    });
    fireDomReady(el);

    fireEvent.pointerDown(screen.getByLabelText("browser.more"), {
      button: 0,
      ctrlKey: false,
    });
    const openExternalItem = screen.getByRole("menuitem", {
      name: "browser.openExternal",
    });
    // Radix 只在禁用时设置 aria-disabled="true"，启用态不会写入 false 属性。
    expect(openExternalItem.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(openExternalItem);
    expect(h.openExternal).toHaveBeenCalledWith("file:///workspace/index.html");

    // 选择可用菜单项后 Radix 会关闭菜单，重新打开后再验证 DevTools。
    fireEvent.pointerDown(screen.getByLabelText("browser.more"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "browser.devtools" }));
    expect(openDevTools).toHaveBeenCalledTimes(1);
  });

  it("自由尺寸按钮位于元素选择左侧，切换模式不会重建 webview", () => {
    renderView();
    const responsiveButton = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    const elementPickerButton = screen.getByTestId(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    const originalWebview = screen.getByTestId(TID_BROWSER_WEBVIEW);

    expect(
      responsiveButton.compareDocumentPosition(elementPickerButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(responsiveButton);
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("true");
    expect(viewport.dataset.responsiveWidth).toBe("393");
    expect(viewport.dataset.responsiveHeight).toBe("852");
    expect(viewport.style.width).toBe("393px");
    expect(viewport.style.height).toBe("852px");
    const responsiveToolbar = screen.getByTestId(TID_BROWSER_RESPONSIVE_TOOLBAR);
    expect(responsiveToolbar.classList).toContain("h-8");
    expect(responsiveToolbar.classList).toContain("bg-background");
    expect(responsiveToolbar.classList).not.toContain("bg-surface");
    expect(responsiveToolbar.classList).toContain("gap-1");
    const widthInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT) as HTMLInputElement;
    const heightInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT) as HTMLInputElement;
    expect(widthInput.classList).toContain("border-transparent");
    expect(widthInput.classList).toContain("bg-transparent");
    expect(widthInput.classList).toContain("hover:bg-hover");
    expect(heightInput.classList).toContain("border-transparent");
    expect(heightInput.classList).toContain("bg-transparent");
    expect(widthInput.value).toBe("393");
    expect(heightInput.value).toBe("852");
    const zoomSelect = screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    expect(zoomSelect.dataset.variant).toBe("ghost");
    expect(zoomSelect.textContent).toContain("browser.responsive.fitToWindow");
    expect(screen.queryByText("393 × 852")).toBeNull();
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(originalWebview);
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-1",
      viewport: { width: 393, height: 852 },
    });

    fireEvent.click(responsiveButton);
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("false");
    expect(viewport.style.width).toBe("");
    expect(viewport.style.height).toBe("");
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(originalWebview);
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-1",
      viewport: null,
    });
    expect(screen.queryByTestId(TID_BROWSER_RESPONSIVE_TOOLBAR)).toBeNull();
  });

  it("human Browser 创建时恢复已保存的自由尺寸、分辨率和固定预览比例", async () => {
    h.settingsState.settings = {
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 412, height: 915 },
        zoom: "50",
      },
    };
    renderHumanView();

    const responsiveButton = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("true");
    expect(viewport.style.width).toBe("412px");
    expect(viewport.style.height).toBe("915px");
    expect(viewport.dataset.responsiveScale).toBe("0.5");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain("50%");

    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDidAttach(webview);
    await act(async () => Promise.resolve());

    expect(h.attachGuest).toHaveBeenCalled();
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "human-tab-1",
      viewport: { width: 412, height: 915 },
    });
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("human toggle、合法尺寸和缩放选择更新显示偏好，拖拽式尺寸写入会合并防抖", () => {
    vi.useFakeTimers();
    renderHumanView();

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(h.updateSettings).toHaveBeenLastCalledWith({
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 393, height: 852 },
        zoom: "fit",
      },
    });

    const widthInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT);
    fireEvent.change(widthInput, { target: { value: "430" } });
    fireEvent.keyDown(widthInput, { key: "Enter" });
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(250));
    expect(h.updateSettings).toHaveBeenLastCalledWith({
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 430, height: 852 },
        zoom: "fit",
      },
    });

    const zoomSelect = screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    fireEvent.keyDown(zoomSelect, { key: "Enter" });
    fireEvent.click(screen.getByTestId(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-50`));
    expect(h.updateSettings).toHaveBeenLastCalledWith({
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 430, height: 852 },
        zoom: "50",
      },
    });

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(h.updateSettings).toHaveBeenLastCalledWith({
      embeddedBrowserViewportPreference: {
        mode: "normal",
        viewport: { width: 430, height: 852 },
        zoom: "50",
      },
    });
  });

  it("Agent Browser Use 不读取 human 偏好，Agent viewport 事件也不写偏好", () => {
    h.settingsState.settings = {
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 412, height: 915 },
        zoom: "50",
      },
    };

    renderView("agent-tab", "task-agent");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).style.width).toBe("");

    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-agent",
          tabId: "agent-tab",
          browserId: "iab-agent",
          browserGeneration: 1,
          viewport: { width: 1280, height: 720 },
        });
      }
    });
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).style.width).toBe("1280px");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain(
      "browser.responsive.fitToWindow",
    );
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("模型打开的新页面使用 Agent 默认 1280×720，且不读写 human 偏好", async () => {
    h.settingsState.settings = {
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 412, height: 915 },
        zoom: "50",
      },
    };

    renderHumanView("model-popup", true);

    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).style.width).toBe("1280px");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).style.height).toBe("720px");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain(
      "browser.responsive.fitToWindow",
    );

    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireDidAttach(webview);
    await act(async () => Promise.resolve());

    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "model-popup",
      viewport: { width: 1280, height: 720 },
    });
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("human tab 收到 Agent viewport event 时只更新当前运行态，不污染 human 偏好", () => {
    h.settingsState.settings = {
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 412, height: 915 },
        zoom: "50",
      },
    };
    renderHumanView();

    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-human",
          tabId: "human-tab-1",
          browserId: "iab-human",
          browserGeneration: 1,
          viewport: { width: 375, height: 667 },
        });
      }
    });

    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).style.width).toBe("375px");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain("50%");
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("已挂载 human tab 不因后续 settings 快照变化而重新初始化", () => {
    h.settingsState.settings = {
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: 412, height: 915 },
        zoom: "50",
      },
    };
    const view = renderHumanView();

    h.settingsState.settings = {
      embeddedBrowserViewportPreference: {
        mode: "normal",
        viewport: { width: 800, height: 600 },
        zoom: "200",
      },
    };
    view.rerender(createHumanViewElement());

    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).style.width).toBe("412px");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain("50%");
  });

  it("顶部宽高输入只提交 strict range 内的整数，并为无效草稿显示范围提示", () => {
    renderView();
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    const widthInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT) as HTMLInputElement;
    const heightInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT) as HTMLInputElement;
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);

    fireEvent.change(widthInput, { target: { value: "412" } });
    fireEvent.keyDown(widthInput, { key: "Enter" });
    expect(viewport.style.width).toBe("412px");
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-1",
      viewport: { width: 412, height: 852 },
    });

    fireEvent.change(heightInput, { target: { value: "915" } });
    fireEvent.blur(heightInput);
    expect(viewport.style.height).toBe("915px");
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-1",
      viewport: { width: 412, height: 915 },
    });

    const updateCount = h.updateViewport.mock.calls.length;
    for (const invalidValue of ["", "319", "412.5", "3841"]) {
      fireEvent.change(widthInput, { target: { value: invalidValue } });
      fireEvent.blur(widthInput);
      expect(widthInput.value).toBe(invalidValue);
      expect(widthInput.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toBe("range 320-3840");
    }
    expect(h.updateViewport).toHaveBeenCalledTimes(updateCount);

    fireEvent.change(widthInput, { target: { value: "412" } });
    fireEvent.keyDown(widthInput, { key: "Enter" });
    expect(widthInput.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Fit 模式接受 3840×2160，并对越界高度草稿提示范围", () => {
    renderView();
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    const zoomSelect = screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    fireEvent.keyDown(zoomSelect, { key: "Enter" });
    fireEvent.click(screen.getByTestId(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-fit`));

    const widthInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT) as HTMLInputElement;
    const heightInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT) as HTMLInputElement;
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    fireEvent.change(widthInput, { target: { value: "3840" } });
    fireEvent.keyDown(widthInput, { key: "Enter" });
    fireEvent.change(heightInput, { target: { value: "2160" } });
    fireEvent.keyDown(heightInput, { key: "Enter" });
    expect(viewport.style.width).toBe("3840px");
    expect(viewport.style.height).toBe("2160px");
    expect(widthInput.value).toBe("3840");
    expect(heightInput.value).toBe("2160");
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-1",
      viewport: { width: 3840, height: 2160 },
    });

    const updateCount = h.updateViewport.mock.calls.length;
    fireEvent.change(heightInput, { target: { value: "2161" } });
    fireEvent.blur(heightInput);
    expect(heightInput.value).toBe("2161");
    expect(heightInput.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("range 320-2160");
    expect(h.updateViewport).toHaveBeenCalledTimes(updateCount);
  });

  it("不可见 Browser view 的无效尺寸不应把 Tooltip Portal 泄漏到窗口左上角", () => {
    renderView("session-1", undefined, undefined, false);
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));

    const heightInput = screen.getByTestId(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT) as HTMLInputElement;
    fireEvent.change(heightInput, { target: { value: "2161" } });
    fireEvent.blur(heightInput);

    expect(heightInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it("缩放选择器提供指定档位且只改变 renderer 预览比例", () => {
    renderView();
    stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    const zoomSelect = screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);

    fireEvent.keyDown(zoomSelect, { key: "Enter" });
    const zoomOption = screen.getByTestId(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-50`);
    fireEvent.click(zoomOption);

    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const scaledFrame = screen.getByTestId(TID_BROWSER_RESPONSIVE_SCALED_FRAME);
    expect(zoomSelect.textContent).toContain("50%");
    expect(viewport.dataset.responsiveScale).toBe("0.5");
    expect(viewport.style.width).toBe("393px");
    expect(viewport.style.height).toBe("852px");
    expect(scaledFrame.style.width).toBe("196.5px");
    expect(scaledFrame.style.height).toBe("426px");
    expect(h.updateViewport).toHaveBeenCalledTimes(1);
  });

  it("每次进入自由尺寸默认 Fit，模式内 viewport 同步不覆盖当前缩放", () => {
    renderView("tab-1", "task-1");
    const responsiveButton = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    fireEvent.click(responsiveButton);
    const zoomSelect = screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    expect(zoomSelect.textContent).toContain("browser.responsive.fitToWindow");

    fireEvent.keyDown(zoomSelect, { key: "Enter" });
    fireEvent.click(screen.getByTestId(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-50`));
    expect(zoomSelect.textContent).toContain("50%");

    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-1",
          tabId: "tab-1",
          browserId: "iab-1",
          browserGeneration: 1,
          viewport: { width: 412, height: 915 },
        });
      }
    });
    expect(zoomSelect.textContent).toContain("50%");

    fireEvent.click(responsiveButton);
    fireEvent.click(responsiveButton);
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain(
      "browser.responsive.fitToWindow",
    );
    expect((screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT) as HTMLInputElement).value).toBe(
      "412",
    );
    expect(
      (screen.getByTestId(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT) as HTMLInputElement).value,
    ).toBe("915");
  });

  it("截图期间临时 Fit，避免固定 200% 预览的 raster 被裁剪，释放后恢复偏好", () => {
    const view = renderView("tab-1", "sess-1");
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    fireEvent.keyDown(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT), { key: "Enter" });
    fireEvent.click(screen.getByTestId(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-200`));
    const webview = screen.getByTestId(TID_BROWSER_WEBVIEW);
    const settingsWrites = h.updateSettings.mock.calls.length;
    const request = createScreenshotSurfaceRequest();
    view.rerender(createViewElement("tab-1", "sess-1", undefined, true, undefined, request));
    expect(
      Number(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).dataset.responsiveScale),
    ).toBeLessThanOrEqual(1);
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain("200%");
    expect(h.updateSettings).toHaveBeenCalledTimes(settingsWrites);
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(webview);
    view.rerender(createViewElement("tab-1", "sess-1", undefined, true, undefined, null));
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).dataset.responsiveScale).toBe("2");
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(webview);
  });

  it("BVR09: 录制期间临时用请求 viewport 的 100% surface，结束后恢复用户预览比例", () => {
    const view = renderView("tab-1", "sess-1");
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    const zoomSelect = screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    fireEvent.keyDown(zoomSelect, { key: "Enter" });
    fireEvent.click(screen.getByTestId(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-50`));

    const request = createScreenshotSurfaceRequest({
      surfaceScaleMode: "unscaled",
      viewport: { width: 1920, height: 1080 },
    });
    view.rerender(createViewElement("tab-1", "sess-1", undefined, true, undefined, request));

    const recordingViewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(recordingViewport.style.width).toBe("1920px");
    expect(recordingViewport.style.height).toBe("1080px");
    expect(recordingViewport.dataset.responsiveScale).toBe("1");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain("50%");
    expect((screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT) as HTMLInputElement).value).toBe(
      "393",
    );

    view.rerender(createViewElement("tab-1", "sess-1", undefined, true, undefined, null));
    const restoredViewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(restoredViewport.style.width).toBe("393px");
    expect(restoredViewport.style.height).toBe("852px");
    expect(restoredViewport.dataset.responsiveScale).toBe("0.5");
  });

  it("BVR09: 普通全窗口预览也只临时切换录制 surface，不改变自由尺寸按钮状态", () => {
    const request = createScreenshotSurfaceRequest({
      surfaceScaleMode: "unscaled",
      viewport: { width: 1280, height: 720 },
    });
    const view = renderView("tab-1", "sess-1", undefined, true, undefined, request);

    const responsiveButton = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    const recordingViewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("false");
    expect(recordingViewport.style.width).toBe("1280px");
    expect(recordingViewport.style.height).toBe("720px");
    expect(recordingViewport.dataset.responsiveScale).toBe("1");

    view.rerender(createViewElement("tab-1", "sess-1", undefined, true, undefined, null));
    const restoredViewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(restoredViewport.style.width).toBe("");
    expect(restoredViewport.dataset.responsiveScale).toBeUndefined();
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("Fit to window 按画布宽高等比缩小且不超过 100%", () => {
    render(createElement(ResponsiveViewportHarness, { zoom: "fit" }));
    const fitObserver = FakeResizeObserver.instances.at(-1);
    expect(fitObserver).toBeDefined();

    act(() => fitObserver?.emit(500, 600));
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const scaledFrame = screen.getByTestId(TID_BROWSER_RESPONSIVE_SCALED_FRAME);
    const expectedScale = 568 / 852;
    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(expectedScale);
    expect(Number.parseFloat(scaledFrame.style.height)).toBeCloseTo(568);

    act(() => fitObserver?.emit(1000, 1000));
    expect(viewport.dataset.responsiveScale).toBe("1");
  });

  it("隐藏 Fit tab 的 0×0 布局样本不覆盖最后有效缩放", () => {
    render(createElement(ResponsiveViewportHarness, { zoom: "fit" }));
    const fitObserver = FakeResizeObserver.instances.at(-1);
    expect(fitObserver).toBeDefined();

    act(() => fitObserver?.emit(500, 600));
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const expectedScale = 568 / 852;
    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(expectedScale);

    // inactive tab 的 display:none 会让 ResizeObserver 回报 0×0；这不是有效布局。
    act(() => fitObserver?.emit(0, 0));
    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(expectedScale);
  });

  it("隐藏 Fit tab 重新 composed 时在首绘前重测当前画布", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 500,
      top: 0,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const { rerender } = render(
      createElement(ResponsiveViewportHarness, {
        isComposed: true,
        zoom: "fit",
      }),
    );
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(568 / 852);

    rerender(
      createElement(ResponsiveViewportHarness, {
        isComposed: false,
        zoom: "fit",
      }),
    );
    rectSpy.mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    rerender(
      createElement(ResponsiveViewportHarness, {
        isComposed: true,
        zoom: "fit",
      }),
    );

    expect(Number(viewport.dataset.responsiveScale)).toBeCloseTo(468 / 852);
    rectSpy.mockRestore();
  });

  it("缩放后的拖拽距离会换算为 CSS viewport 像素", () => {
    const { unmount } = render(createElement(ResponsiveViewportHarness, { zoom: "50" }));
    let viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH), 21, {
      x: 20,
      y: 0,
    });
    expect(viewport.style.width).toBe("433px");

    unmount();
    render(createElement(ResponsiveViewportHarness, { zoom: "200" }));
    viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH), 22, {
      x: 20,
      y: 0,
    });
    expect(viewport.style.width).toBe("403px");
  });

  it("Agent 设置 viewport 时自动打开自由尺寸并复用现有 webview", () => {
    renderView("tab-1", "task-1");
    const originalWebview = screen.getByTestId(TID_BROWSER_WEBVIEW);

    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-1",
          tabId: "tab-1",
          browserId: "iab-1",
          browserGeneration: 1,
          viewport: { width: 375, height: 667 },
        });
      }
    });

    const responsiveButton = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    expect(responsiveButton.getAttribute("aria-pressed")).toBe("true");
    expect(viewport.style.width).toBe("375px");
    expect(viewport.style.height).toBe("667px");
    expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT).textContent).toContain(
      "browser.responsive.fitToWindow",
    );
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(originalWebview);
    expect(h.updateViewport).not.toHaveBeenCalled();
  });

  it("只在自由尺寸模式消费 guest 二维滚动边界消息并滚动画布", () => {
    renderView();
    const webview = screen.getByTestId(TID_BROWSER_WEBVIEW);
    const responsiveCanvas = document.querySelector<HTMLElement>(
      '[data-responsive-browser-mode="inactive"]',
    );
    expect(responsiveCanvas).not.toBeNull();
    const scrollBy = vi.fn();
    Object.assign(responsiveCanvas as HTMLElement, { scrollBy });

    const dispatchGuestMessage = (channel: string, args: unknown[]) => {
      const event = new Event("ipc-message");
      Object.assign(event, { args, channel });
      act(() => webview.dispatchEvent(event));
    };

    dispatchGuestMessage(EmbeddedBrowserWebviewChannels.WheelBoundary, [
      { deltaX: 120, deltaY: 80 },
    ]);
    expect(scrollBy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    dispatchGuestMessage("unrelated-channel", [{ deltaX: 120, deltaY: 80 }]);
    dispatchGuestMessage(EmbeddedBrowserWebviewChannels.WheelBoundary, [
      { deltaX: Number.NaN, deltaY: Number.NaN },
    ]);
    dispatchGuestMessage(EmbeddedBrowserWebviewChannels.WheelBoundary, [{}]);
    dispatchGuestMessage(EmbeddedBrowserWebviewChannels.WheelBoundary, [
      { deltaX: "120", deltaY: "80" },
    ]);
    expect(scrollBy).not.toHaveBeenCalled();

    dispatchGuestMessage(EmbeddedBrowserWebviewChannels.WheelBoundary, [
      { deltaX: 120, deltaY: 80 },
    ]);
    expect(scrollBy).toHaveBeenCalledWith({
      behavior: "auto",
      left: 120,
      top: 80,
    });
  });

  it("自由尺寸支持四边与四角拖拽，角落无图标且保留 tab 内上次尺寸", () => {
    renderView();
    const responsiveButton = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    fireEvent.click(responsiveButton);

    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH), 1, {
      x: 40,
      y: 0,
    });
    expect(viewport.style.width).toBe("433px");
    expect(viewport.style.height).toBe("852px");

    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_LEFT), 2, {
      x: -20,
      y: 0,
    });
    expect(viewport.style.width).toBe("453px");

    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT), 3, {
      x: 0,
      y: 30,
    });
    expect(viewport.style.height).toBe("882px");

    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_TOP), 4, {
      x: 0,
      y: -10,
    });
    expect(viewport.style.height).toBe("892px");

    const corners = [
      {
        delta: { x: -10, y: -10 },
        expected: { height: "902px", width: "463px" },
        testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT,
      },
      {
        delta: { x: 10, y: -10 },
        expected: { height: "912px", width: "473px" },
        testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT,
      },
      {
        delta: { x: -10, y: 10 },
        expected: { height: "922px", width: "483px" },
        testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT,
      },
      {
        delta: { x: 10, y: 10 },
        expected: { height: "932px", width: "493px" },
        testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER,
      },
    ] as const;
    corners.forEach((corner, index) => {
      const handle = screen.getByTestId(corner.testId);
      expect(handle.querySelector("svg")).toBeNull();
      dragResizeHandle(handle, index + 5, corner.delta);
      expect(viewport.style.width).toBe(corner.expected.width);
      expect(viewport.style.height).toBe(corner.expected.height);
    });

    dragResizeHandle(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_CORNER), 9, {
      x: -1000,
      y: -1000,
    });
    expect(viewport.style.width).toBe("320px");
    expect(viewport.style.height).toBe("320px");

    fireEvent.click(responsiveButton);
    fireEvent.click(responsiveButton);
    expect(viewport.style.width).toBe("320px");
    expect(viewport.style.height).toBe("320px");
  });

  it("自由尺寸拖拽中窗口失焦会结束手势，重新聚焦后需再次按下才能继续拖拽", () => {
    renderView();
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));

    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const handle = screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT);
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 10,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      buttons: 1,
      clientX: 80,
      clientY: 120,
      pointerId: 10,
      pointerType: "mouse",
    });
    fireEvent.blur(window);
    expect(viewport.style.width).toBe("413px");
    expect(viewport.style.height).toBe("872px");

    fireEvent.pointerMove(handle, {
      buttons: 0,
      clientX: 40,
      clientY: 180,
      pointerId: 10,
      pointerType: "mouse",
    });
    expect(viewport.style.width).toBe("413px");
    expect(viewport.style.height).toBe("872px");

    dragResizeHandle(handle, 11, { x: -10, y: 10 });
    expect(viewport.style.width).toBe("423px");
    expect(viewport.style.height).toBe("882px");

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 12,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      buttons: 1,
      clientX: 90,
      clientY: 110,
      pointerId: 12,
      pointerType: "mouse",
    });
    fireEvent.lostPointerCapture(handle, {
      pointerId: 12,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      buttons: 0,
      clientX: 50,
      clientY: 150,
      pointerId: 12,
      pointerType: "mouse",
    });
    expect(viewport.style.width).toBe("433px");
    expect(viewport.style.height).toBe("892px");

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 13,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      buttons: 0,
      clientX: 80,
      clientY: 120,
      pointerId: 13,
      pointerType: "mouse",
    });
    expect(viewport.style.width).toBe("433px");
    expect(viewport.style.height).toBe("892px");

    const updateCount = h.updateViewport.mock.calls.length;
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 14,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      buttons: 1,
      clientX: 70,
      clientY: 130,
      pointerId: 14,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(h.updateViewport).toHaveBeenCalledTimes(updateCount + 1);
    expect(h.updateViewport).toHaveBeenLastCalledWith({
      tabId: "session-1",
      viewport: null,
    });
  });

  it("四边 separator 图标默认隐藏并在 hover / focus 显示", () => {
    renderView();
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));

    [
      TID_BROWSER_RESPONSIVE_RESIZE_LEFT,
      TID_BROWSER_RESPONSIVE_RESIZE_WIDTH,
      TID_BROWSER_RESPONSIVE_RESIZE_TOP,
      TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT,
    ].forEach((testId) => {
      const icon = screen.getByTestId(testId).querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon?.classList).toContain("opacity-0");
      expect(icon?.classList).toContain("group-hover/resize-edge:opacity-100");
      expect(icon?.classList).toContain("group-focus-visible/resize-edge:opacity-100");
    });
  });

  it("四边自由尺寸分隔条支持与所在方向一致的键盘调整", () => {
    renderView();
    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    const viewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    const leftHandle = screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_LEFT);
    const widthHandle = screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH);
    const topHandle = screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_TOP);
    const heightHandle = screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT);

    fireEvent.keyDown(widthHandle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(leftHandle, { key: "ArrowLeft" });
    fireEvent.keyDown(heightHandle, { key: "ArrowDown" });
    fireEvent.keyDown(topHandle, { key: "ArrowUp", shiftKey: true });

    expect(viewport.style.width).toBe("404px");
    expect(viewport.style.height).toBe("863px");
    expect(leftHandle.getAttribute("aria-valuenow")).toBe("404");
    expect(widthHandle.getAttribute("aria-valuenow")).toBe("404");
    expect(topHandle.getAttribute("aria-valuenow")).toBe("863");
    expect(heightHandle.getAttribute("aria-valuenow")).toBe("863");
  });

  it("多个 Browser tab 分别持有自由尺寸状态", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          "div",
          null,
          createElement(UnifiedBrowserView, {
            browserKey: "tab-a",
            isVisible: true,
          }),
          createElement(UnifiedBrowserView, {
            browserKey: "tab-b",
            isVisible: true,
          }),
        ),
      ),
    );
    const buttons = screen.getAllByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    const viewports = screen.getAllByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);

    fireEvent.click(buttons[0]);
    fireEvent.keyDown(screen.getAllByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH)[0], {
      key: "ArrowRight",
      shiftKey: true,
    });

    expect(viewports[0].style.width).toBe("403px");
    expect(viewports[1].style.width).toBe("");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("用户在 Agent 操作期间切换自由尺寸复用 resize 弱提示且不叠加", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    renderView("tab-1", "task-1", Date.now() + 5_000);

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).dataset.browserResizeDimmed).toBe("true");

    fireEvent.keyDown(screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH), {
      key: "ArrowRight",
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("模型主动显示已有 Browser 时只重建尺寸基线，不显示 resize 弱提示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const operationUntil = Date.now() + 5_000;
    const view = renderView("tab-1", "task-1", operationUntil, false);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    // Browser 后台挂载时可能仍保留上一次非零 observation。
    act(() => observer?.emit(640, 480));
    view.rerender(createViewElement("tab-1", "task-1", operationUntil, true));
    act(() => observer?.emit(800, 600));

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).dataset.browserResizeDimmed).toBeUndefined();
  });

  it("pane 已可见时模型 newTab 的多帧初始化收敛不提示，稳定后用户 resize 仍提示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const operationUntil = Date.now() + 5_000;
    const view = renderView("tab-1", "task-1", operationUntil, true, 0);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    act(() => observer?.emit(800, 600));
    view.rerender(createViewElement("tab-1", "task-1", operationUntil, true, 1));
    const settlingObserver = FakeResizeObserver.instances.at(-1);
    expect(settlingObserver).toBeDefined();
    // 实机上 newTab marker 后仍会经历 guest 挂载和 side-pane 动画的多帧收敛；
    // 不能只清一次 baseline，否则第二帧会被误认成用户 resize。
    act(() => {
      vi.advanceTimersByTime(220);
      settlingObserver?.emit(780, 600);
      vi.advanceTimersByTime(90);
      settlingObserver?.emit(760, 600);
      vi.advanceTimersByTime(90);
      settlingObserver?.emit(740, 600);
      vi.advanceTimersByTime(90);
      settlingObserver?.emit(720, 600);
    });
    expect(screen.queryByRole("status")).toBeNull();

    // 连续回调最多延长到 500ms；封顶后 marker 不消费当前 active 周期的提示额度。
    act(() => {
      vi.advanceTimersByTime(11);
      settlingObserver?.emit(700, 600);
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("普通模型 operation 不重建基线，后续用户 resize 仍提示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const view = renderView("tab-1", "task-1", Date.now() + 5_000, true, 0);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    act(() => observer?.emit(800, 600));
    view.rerender(createViewElement("tab-1", "task-1", Date.now() + 8_000, true, 0));
    act(() => observer?.emit(760, 600));

    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("模型主动 set/reset viewport 不提示，且不消费后续用户 resize 的提示额度", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    renderView("tab-1", "task-1", Date.now() + 5_000);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    act(() => observer?.emit(800, 600));
    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-1",
          tabId: "tab-1",
          browserId: "iab-1",
          browserGeneration: 1,
          viewport: { width: 375, height: 667 },
        });
      }
    });
    // 模型进入自由尺寸会挂载控制条并改变 browser region 高度；这次只建立新基线。
    act(() => observer?.emit(800, 568));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-1",
          tabId: "tab-1",
          browserId: "iab-1",
          browserGeneration: 1,
          viewport: null,
        });
      }
    });
    act(() => observer?.emit(800, 600));
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).dataset.browserResizeDimmed).toBe("true");
  });

  it("模型在自由尺寸内继续改 viewport 不吞掉后续外部布局 resize 告警", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    renderView("tab-1", "task-1", Date.now() + 5_000);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    act(() => observer?.emit(800, 600));
    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-1",
          tabId: "tab-1",
          browserId: "iab-1",
          browserGeneration: 1,
          viewport: { width: 375, height: 667 },
        });
      }
    });
    act(() => observer?.emit(800, 568));

    act(() => {
      for (const listener of h.viewportListeners) {
        listener({
          workspaceKey: "/repo",
          sessionId: "task-1",
          tabId: "tab-1",
          browserId: "iab-1",
          browserGeneration: 1,
          viewport: { width: 414, height: 896 },
        });
      }
    });
    expect(screen.queryByRole("status")).toBeNull();

    // 自由尺寸模式没有切换，因此模型事件不会重新开启稳定期；当前模式切换的稳定期结束后，
    // 真正的 pane resize 仍告警。
    act(() => {
      vi.advanceTimersByTime(301);
      observer?.emit(760, 568);
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("browser-use operation active 时 resize 只显示一次弱提示并自动消失", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    renderView("tab-1", "task-1", Date.now() + 5_000);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    act(() => observer?.emit(800, 600));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => observer?.emit(700, 600));
    const warning = screen.getByRole("status");
    expect(warning.textContent).toBe("browser.resizeDuringOperationWarning");
    expect(warning.classList).toContain("bg-popover");
    expect(warning.classList).toContain("border-popover-border");
    expect(warning.classList).toContain("shadow-md");
    expect(warning.classList).not.toContain("bg-warning");
    expect(warning.classList).toContain("pointer-events-none");
    expect(warning.querySelector('[data-browser-resize-warning-accent="visible"]')).not.toBeNull();
    expect(warning.querySelector("svg")?.classList).toContain("text-warning");
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).dataset.browserResizeDimmed).toBe("true");

    // 连续拖拽不会刷新 3 秒计时器或叠加第二条提示。
    act(() => {
      vi.advanceTimersByTime(1_000);
      observer?.emit(650, 600);
      vi.advanceTimersByTime(1_999);
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW).dataset.browserResizeDimmed).toBeUndefined();
  });

  it("operation inactive 时 resize 只更新尺寸基线，不显示提示", () => {
    renderView("tab-1", "task-1");
    const observer = FakeResizeObserver.instances.at(-1);

    act(() => {
      observer?.emit(800, 600);
      observer?.emit(700, 600);
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("operation active 但 tab 隐藏时 resize 不显示提示", () => {
    renderView("tab-1", "task-1", Date.now() + 5_000, false);
    const observer = FakeResizeObserver.instances.at(-1);

    act(() => {
      observer?.emit(800, 600);
      observer?.emit(700, 600);
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("负 Desktop zoom 的扩张布局按 layout scale 还原后等待两个稳定 frame", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const flushOneAnimationFrame = () => {
      const entry = rafQueue.entries().next().value as [number, FrameRequestCallback] | undefined;
      const callback = entry?.[1];
      if (entry) rafQueue.delete(entry[0]);
      expect(callback).toBeDefined();
      act(() => callback?.(0));
    };
    const request = createScreenshotSurfaceRequest({
      viewport: { width: 1280, height: 720 },
    });
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    const responsiveViewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
    responsiveViewport.dataset.responsiveScale = "0.5";
    const layoutScale = 1 / resolveDesktopZoomFactor(-2);
    webview.dataset.browserLayoutScale = String(layoutScale);
    Object.defineProperties(webview, {
      offsetWidth: {
        configurable: true,
        value: Math.round(1280 * layoutScale),
      },
      offsetHeight: {
        configurable: true,
        value: Math.round(720 * layoutScale),
      },
    });
    // Fit 预览会继续缩放 transformed rect，因此只能从 raw layout 还原逻辑 viewport。
    vi.spyOn(webview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 640,
      bottom: 360,
      width: 640,
      height: 360,
      toJSON: () => ({}),
    });
    fireDomReady(webview);
    FakeResizeObserver.instances
      .at(-1)
      ?.emit(Math.round(1280 * layoutScale), Math.round(720 * layoutScale));

    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    responsiveViewport.dataset.responsiveScale = "0.625";
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      viewport: { width: 1280, height: 720 },
      surfaceScale: 0.625,
    });
  });

  it.each([
    { width: 960, height: 720 },
    { width: 1440, height: 480 },
  ])("普通后台截图在受限画布 %j 下保留请求逻辑尺寸，ready 后恢复原模式", (canvas) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const request = createScreenshotSurfaceRequest({ viewport: { width: 1280, height: 720 } });
    const view = renderView("tab-1", "sess-1", undefined, false);
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    const button = screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    const writes = h.updateSettings.mock.calls.length;
    const logicalSize = () => {
      const frame = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
      // 按组件实际布局派生尺寸，不能直接把 request.viewport 填给 webview 掩盖普通模式缺陷。
      return {
        width: Number.parseFloat(frame.style.width) || canvas.width,
        height: Number.parseFloat(frame.style.height) || canvas.height,
      };
    };
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, get: () => logicalSize().width },
      offsetHeight: { configurable: true, get: () => logicalSize().height },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockImplementation(() => {
      const { width, height } = logicalSize();
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      };
    });
    view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    act(() => vi.advanceTimersByTime(4100));
    expect(h.screenshotSurfaceReady).toHaveBeenCalledOnce();
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: request.viewport }),
    );
    expect(logicalSize()).toEqual(request.viewport);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(webview);
    expect(h.updateSettings).toHaveBeenCalledTimes(writes);
    view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, null));
    expect(
      screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT).dataset.responsiveScale,
    ).toBeUndefined();
    expect(logicalSize()).toEqual(canvas);
    expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(webview);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(h.updateSettings).toHaveBeenCalledTimes(writes);
  });

  it.each(["natural", "emulated"] as const)(
    "缩小应用时 %s 截图按实际 viewport 模式准备 guest 布局",
    async (viewportMode) => {
      const view = renderView("tab-1", "sess-1", undefined, false);
      const setZoomFactor = vi.fn();
      const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), { setZoomFactor });
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        for (const listener of h.zoomListeners) listener({ zoomLevel: -2 });
      });
      const writes = h.updateSettings.mock.calls.length;
      const request = createScreenshotSurfaceRequest({
        viewport: { width: 508, height: 855 },
        viewportMode,
      });
      view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
      const frame = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
      expect(frame.style.width).toBe("508px");
      expect(frame.style.height).toBe("855px");
      // 自然 viewport 没有 metrics 固定尺寸，不能扩张 webview 后再反向 transform 假装逻辑尺寸未变。
      expect(Number(webview.dataset.browserLayoutScale)).toBeCloseTo(
        viewportMode === "natural" ? 1 : 1 / resolveDesktopZoomFactor(-2),
      );
      expect(webview.style.position).toBe(viewportMode === "natural" ? "" : "absolute");
      expect(webview.style.transform).toBe(
        viewportMode === "natural" ? "" : `scale(${resolveDesktopZoomFactor(-2)})`,
      );
      view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, null));
      expect(screen.getByTestId(TID_BROWSER_WEBVIEW)).toBe(webview);
      expect(webview.style.position).toBe("");
      expect(frame.dataset.responsiveScale).toBeUndefined();
      expect(setZoomFactor).not.toHaveBeenCalled();
      expect(h.updateSettings).toHaveBeenCalledTimes(writes);
    },
  );

  it("普通后台截图的临时 Fit 释放不覆盖 main 管理的 fallback guest zoom", async () => {
    const view = renderView("tab-1", "sess-1", undefined, false);
    const setZoomFactor = vi.fn();
    stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), { setZoomFactor });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      for (const listener of h.zoomListeners) listener({ zoomLevel: 2 });
    });
    const request = createScreenshotSurfaceRequest({ viewport: { width: 1280, height: 720 } });
    view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, null));
    // fallback metrics 仍有效，临时布局退出不能按退出用户自由尺寸模式恢复 desktop zoom。
    expect(setZoomFactor).not.toHaveBeenCalled();
  });

  it("后台 surface 连续两个稳定 frame 后才 ready，并回传当前 guest id", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const flushOneAnimationFrame = () => {
      const entry = rafQueue.entries().next().value as [number, FrameRequestCallback] | undefined;
      const callback = entry?.[1];
      if (entry) rafQueue.delete(entry[0]);
      expect(callback).toBeDefined();
      act(() => callback?.(0));
    };
    const request = createScreenshotSurfaceRequest({ webContentsId: 42 });
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, value: 1274 },
      offsetHeight: { configurable: true, value: 720 },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1274,
      bottom: 720,
      width: 1274,
      height: 720,
      toJSON: () => ({}),
    });
    fireDomReady(webview);
    FakeResizeObserver.instances.at(-1)?.emit(1274, 720);

    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      viewport: { width: 1274, height: 720 },
      surfaceScale: 1,
    });
  });

  it("窗口被遮挡导致 rAF 冻结时，timer 兜底仍然能 ready", () => {
    // 回归（3.5.2 browser use 截图 1500ms 超时）：ready 过去只挂 rAF，主窗口不在前台时
    // Chromium 冻结 renderer 的 rAF，ready 永远发不出去。这里模拟 rAF 完全不回调。
    vi.useFakeTimers();
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const request = createScreenshotSurfaceRequest();
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, value: 1274 },
      offsetHeight: { configurable: true, value: 720 },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1274,
      bottom: 720,
      width: 1274,
      height: 720,
      toJSON: () => ({}),
    });

    act(() => vi.advanceTimersByTime(100));
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      surfaceScale: 1,
      viewport: { width: 1274, height: 720 },
    });
  });

  it("超过旧 2500ms 边界后仍会在 main timeout 前继续验证 surface", () => {
    vi.useFakeTimers();
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const request = createScreenshotSurfaceRequest({ timeoutMs: 3000 });
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    let size = { width: 900, height: 500 };
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, get: () => size.width },
      offsetHeight: { configurable: true, get: () => size.height },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    }));

    act(() => vi.advanceTimersByTime(2600));
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    size = { width: 1274, height: 720 };
    act(() => vi.advanceTimersByTime(100));
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      surfaceScale: 1,
      viewport: { width: 1274, height: 720 },
    });
  });

  it("超过 prepare timeout 加清理宽限后停止 surface 验证", () => {
    vi.useFakeTimers();
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const request = createScreenshotSurfaceRequest({ timeoutMs: 3000 });
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    let size = { width: 900, height: 500 };
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, get: () => size.width },
      offsetHeight: { configurable: true, get: () => size.height },
    });
    const readBounds = vi.spyOn(webview, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    }));

    act(() => vi.advanceTimersByTime(4000));
    const readsAtDeadline = readBounds.mock.calls.length;
    size = { width: 1274, height: 720 };
    act(() => vi.advanceTimersByTime(500));
    expect(readBounds).toHaveBeenCalledTimes(readsAtDeadline);
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
  });

  it("viewport 起初不匹配且没有 resize/dom-ready 时，也会重试到 ready", () => {
    // 回归：viewport 未对齐过去直接 return，只能等 ResizeObserver / dom-ready 重启；
    // setViewportSize 之后尺寸若不再变化就没有第二次验证机会，白等 1500ms 超时。
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const flushOneAnimationFrame = () => {
      const entry = rafQueue.entries().next().value as [number, FrameRequestCallback] | undefined;
      const callback = entry?.[1];
      if (entry) rafQueue.delete(entry[0]);
      expect(callback).toBeDefined();
      act(() => callback?.(0));
    };
    const request = createScreenshotSurfaceRequest();
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    let size = { width: 900, height: 500 };
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, get: () => size.width },
      offsetHeight: { configurable: true, get: () => size.height },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    }));

    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    // 只改尺寸，不触发 ResizeObserver / dom-ready：验证重试链本身还活着。
    size = { width: 1274, height: 720 };
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      surfaceScale: 1,
      viewport: { width: 1274, height: 720 },
    });
  });

  it("guest 在 dom-ready 后才可读时，无 resize 也会重新等待两个稳定 frame", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const flushOneAnimationFrame = () => {
      const entry = rafQueue.entries().next().value as [number, FrameRequestCallback] | undefined;
      const callback = entry?.[1];
      if (entry) rafQueue.delete(entry[0]);
      expect(callback).toBeDefined();
      act(() => callback?.(0));
    };
    const request = createScreenshotSurfaceRequest();
    render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW), {
      getWebContentsId: vi.fn(() => 0),
    });
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, value: 1274 },
      offsetHeight: { configurable: true, value: 720 },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1274,
      bottom: 720,
      width: 1274,
      height: 720,
      toJSON: () => ({}),
    });

    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    Object.assign(webview, { getWebContentsId: vi.fn(() => 42) });
    fireDomReady(webview);
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      surfaceScale: 1,
      viewport: { width: 1274, height: 720 },
    });
  });

  it("release 在稳定 frame 前取消等待，之后 flush 不会 ready", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => rafQueue.delete(rafId));
    const request = createScreenshotSurfaceRequest();
    const view = render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, value: 1274 },
      offsetHeight: { configurable: true, value: 720 },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1274,
      bottom: 720,
      width: 1274,
      height: 720,
      toJSON: () => ({}),
    });
    view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, null));
    act(() => {
      for (const callback of rafQueue.values()) callback(0);
    });
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
  });

  it("StrictMode 重挂载会成对清理 screenshot dom-ready 与 ResizeObserver", () => {
    const addEventListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const removeEventListener = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const request = createScreenshotSurfaceRequest();
    const view = render(
      createElement(
        StrictMode,
        null,
        createViewElement("tab-1", "sess-1", undefined, false, undefined, request),
      ),
    );
    view.unmount();
    const domReadyAdds = addEventListener.mock.calls.filter(
      ([type]) => type === "dom-ready",
    ).length;
    const domReadyRemoves = removeEventListener.mock.calls.filter(
      ([type]) => type === "dom-ready",
    ).length;
    expect(domReadyAdds).toBeGreaterThan(0);
    expect(domReadyRemoves).toBe(domReadyAdds);
    expect(FakeResizeObserver.instances.every((observer) => observer.disconnected)).toBe(true);
  });

  it("后台 surface 尺寸波动会重置稳定计数，并在 request 清理时取消等待", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextRafId += 1;
      rafQueue.set(nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (rafId: number) => {
      cancelAnimationFrame(rafId);
      rafQueue.delete(rafId);
    });
    const flushOneAnimationFrame = () => {
      const entry = rafQueue.entries().next().value as [number, FrameRequestCallback] | undefined;
      const callback = entry?.[1];
      if (entry) rafQueue.delete(entry[0]);
      expect(callback).toBeDefined();
      act(() => callback?.(0));
    };
    const request = createScreenshotSurfaceRequest();
    const view = render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
    const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
    let size = { width: 1274, height: 720 };
    Object.defineProperties(webview, {
      offsetWidth: { configurable: true, get: () => size.width },
      offsetHeight: { configurable: true, get: () => size.height },
    });
    vi.spyOn(webview, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    }));
    FakeResizeObserver.instances.at(-1)?.emit(size.width, size.height);
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();

    size = { width: 1274, height: 719 };
    FakeResizeObserver.instances.at(-1)?.emit(size.width, size.height);
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();

    size = { width: 1274, height: 720 };
    FakeResizeObserver.instances.at(-1)?.emit(size.width, size.height);
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
    flushOneAnimationFrame();
    expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
      ...request,
      viewport: { width: 1274, height: 720 },
      surfaceScale: 1,
    });

    const surfaceObserver = FakeResizeObserver.instances.at(-1);
    view.rerender(createViewElement("tab-1", "sess-1", undefined, false, undefined, null));
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(surfaceObserver?.disconnected).toBe(true);
  });
});

function createScreenshotSurfaceRequest(
  overrides: Partial<BrowserViewScreenshotSurfacePreparePayload> = {},
): BrowserViewScreenshotSurfacePreparePayload {
  return {
    requestId: "screenshot-request-1",
    workspaceKey: "workspace-1",
    sessionId: "sess-1",
    browserId: "browser-1",
    browserGeneration: 2,
    tabId: "tab-1",
    webContentsId: 42,
    viewport: { width: 1274, height: 720 },
    ...overrides,
  };
}
