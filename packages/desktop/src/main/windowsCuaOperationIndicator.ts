import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, Display, Point, Rectangle } from "electron";
import type { HostCuaOperationStateResponse, Locale } from "@zcode/shared";
import {
  INDICATOR_CARD_TOP_OFFSET,
  INDICATOR_SHADOW_INSET,
  indicatorDataUrl,
  indicatorWindowSize,
} from "./windowsCuaOperationIndicatorContent.js";

const HIDE_ANIMATION_MS = 120;
/**
 * 兜底隐藏时限。主导隐藏的是 turn 终态 / session 关闭 / runtime 不可用 / workspace 销毁
 * 这几条显式清除路径，这个计时器只在它们全部失约时收场，保证浮层不会无限期停留。
 *
 * 取 30s 而不是更短：CUA 事实现在按 cell 上报（每个 node_repl cell 一次），同一 turn 内
 * 后续 cell 会刷新计时器，但单个 cell 本身可以跑很久，10s 会让浮层在操作中途熄灭。
 */
const AUTO_HIDE_MS = 30_000;
const CREATE_RETRY_MS = 250;

export interface WindowsCuaOperationIndicatorWindow {
  readonly webContents: Pick<BrowserWindow["webContents"], "executeJavaScript">;
  destroy(): void;
  hide(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  moveTop(): void;
  on(event: "closed", listener: () => void): this;
  setAlwaysOnTop(flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void;
  setBounds(bounds: Rectangle): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  showInactive(): void;
}

export interface WindowsCuaOperationIndicator {
  handleState(source: object, event: HostCuaOperationStateResponse): void;
  clearSource(source: object): void;
  ownsWindow(candidate: object): boolean;
  refreshContent(): void;
  dispose(): void;
}

interface IndicatorLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface WindowsCuaOperationIndicatorOptions {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  logger: IndicatorLogger;
  createWindow?: (options: BrowserWindowConstructorOptions) => WindowsCuaOperationIndicatorWindow;
  getCursorScreenPoint?: () => Point;
  getDisplayNearestPoint?: (point: Point) => Pick<Display, "workArea">;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createWindowsCuaOperationIndicator(
  options: WindowsCuaOperationIndicatorOptions,
): WindowsCuaOperationIndicator {
  const platform = options.platform ?? process.platform;
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions) =>
      new BrowserWindow(windowOptions) as WindowsCuaOperationIndicatorWindow);
  const getCursorScreenPoint =
    options.getCursorScreenPoint ?? (() => screen.getCursorScreenPoint());
  const getDisplayNearestPoint =
    options.getDisplayNearestPoint ?? ((point: Point) => screen.getDisplayNearestPoint(point));
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));

  const activeTurnKeysBySource = new Map<object, Set<string>>();
  const ownedWindows = new WeakSet<object>();
  const failedWindows = new WeakSet<object>();
  let window: WindowsCuaOperationIndicatorWindow | null = null;
  let windowReady = false;
  let windowShown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const autoHideTimersBySource = new Map<object, Map<string, ReturnType<typeof setTimeout>>>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let setupRetryAvailable = false;
  let disposed = false;

  function hasActiveTurns(): boolean {
    for (const keys of activeTurnKeysBySource.values()) {
      if (keys.size > 0) return true;
    }
    return false;
  }

  function keyFor(event: HostCuaOperationStateResponse): string {
    const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
    return `${workspaceKey}\0${event.sessionId}\0${event.turnId}`;
  }

  function setDocumentState(nextState: "active" | "leaving"): void {
    if (!window || window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) =>
        options.logger.debug("[cua-operation-indicator] state update failed", error),
      );
  }

  function cancelPendingHide(): void {
    if (!hideTimer) return;
    cancelSchedule(hideTimer);
    hideTimer = null;
  }

  function cancelAutoHide(source: object, key: string): void {
    const timers = autoHideTimersBySource.get(source);
    const timer = timers?.get(key);
    if (!timer) return;
    cancelSchedule(timer);
    timers?.delete(key);
    if (timers?.size === 0) autoHideTimersBySource.delete(source);
  }

  function scheduleAutoHide(source: object, key: string): void {
    cancelAutoHide(source, key);
    const timers = autoHideTimersBySource.get(source) ?? new Map();
    autoHideTimersBySource.set(source, timers);
    let timer: ReturnType<typeof setTimeout>;
    timer = schedule(() => {
      const currentTimers = autoHideTimersBySource.get(source);
      if (currentTimers?.get(key) !== timer) return;
      currentTimers.delete(key);
      if (currentTimers.size === 0) autoHideTimersBySource.delete(source);

      const sourceKeys = activeTurnKeysBySource.get(source);
      if (!sourceKeys?.delete(key)) return;
      if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
      // 安全计时器是 fail-hidden 边界：即使 runtime 没有补发 inactive，也不能让
      // 原生浮层无限期可见；后续 CUA tool-started 会重新建立该键并重新计时。
      if (!hasActiveTurns()) beginHide();
    }, AUTO_HIDE_MS);
    timers.set(key, timer);
  }

  function scheduleSetupRetry(): void {
    if (!setupRetryAvailable || !hasActiveTurns() || reconcileTimer) return;
    setupRetryAvailable = false;
    reconcileTimer = schedule(() => {
      reconcileTimer = null;
      ensureWindow();
    }, CREATE_RETRY_MS);
  }

  function discardFailedWindow(target: WindowsCuaOperationIndicatorWindow): void {
    failedWindows.add(target);
    if (window === target) {
      window = null;
      windowReady = false;
      windowShown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.debug(
        "[cua-operation-indicator] failed to discard partial window",
        destroyError,
      );
    }
  }

  function positionWindow(target: WindowsCuaOperationIndicatorWindow): void {
    const { width, height } = indicatorWindowSize(options.getLocale());
    const point = getCursorScreenPoint();
    const { workArea } = getDisplayNearestPoint(point);
    target.setBounds({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top),
    });
  }

  function handleLoadFailure(target: WindowsCuaOperationIndicatorWindow, error: unknown): void {
    options.logger.warn("[cua-operation-indicator] failed to load window content", error);
    if (disposed || target !== window) return;
    discardFailedWindow(target);
    scheduleSetupRetry();
  }

  function showWindowOnTop(target: WindowsCuaOperationIndicatorWindow): void {
    target.showInactive();
    // Windows 隐藏透明窗口后可能清除 WS_EX_TOPMOST；showInactive 只恢复可见性，
    // 不会恢复原生 Z-order，因此每次显示后都必须重新声明层级并移到该层级最前方。
    target.setAlwaysOnTop(true, "screen-saver");
    target.moveTop();
  }

  function loadContent(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      positionWindow(target);
      void target
        .loadURL(indicatorDataUrl(options.getLocale()))
        .then(() => {
          if (disposed || target !== window || target.isDestroyed()) return;
          windowReady = true;
          setupRetryAvailable = false;
          if (!hasActiveTurns()) {
            // refreshContent 可能发生在窗口已经隐藏之后；HTML 默认是 active，必须在
            // 无活跃 turn 时显式恢复离场状态，避免后续错误 show() 暴露假提示。
            setDocumentState("leaving");
            return;
          }
          positionWindow(target);
          showWindowOnTop(target);
          windowShown = true;
          setDocumentState("active");
        })
        .catch((error) => handleLoadFailure(target, error));
    } catch (error) {
      handleLoadFailure(target, error);
    }
  }

  function ensureWindow(repositionExisting = false): void {
    if (disposed || platform !== "win32" || !hasActiveTurns()) return;
    cancelPendingHide();
    if (window && !window.isDestroyed()) {
      if (repositionExisting) positionWindow(window);
      setDocumentState("active");
      // 根因：退场只隐藏而不销毁窗口；后续 turn 复用时必须重新显示已加载的窗口。
      if (windowReady && !windowShown) {
        showWindowOnTop(window);
        windowShown = true;
      }
      if (windowReady) setupRetryAvailable = false;
      return;
    }

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      const { width, height } = indicatorWindowSize(options.getLocale());
      created = createWindow({
        width,
        height,
        alwaysOnTop: true,
        focusable: false,
        frame: false,
        // 旧窗口只给 CSS shadow 留 1px 透明边，并叠加默认 DWM 矩形阴影，
        // 导致圆角阴影被裁成硬边和灰带；扩大透明画布后由 CSS 独占阴影。
        hasShadow: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        transparent: true,
        backgroundColor: "#00000000",
        autoHideMenuBar: true,
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        movable: false,
        webPreferences: {
          contextIsolation: true,
          devTools: false,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window = created;
      windowReady = false;
      windowShown = false;
      ownedWindows.add(created);
      created.setIgnoreMouseEvents(true);
      created.setContentProtection(true);
      created.on("closed", () => {
        const failedDuringSetup = failedWindows.delete(created as object);
        if (window === created) {
          window = null;
          windowReady = false;
          windowShown = false;
        }
        if (failedDuringSetup || disposed || !hasActiveTurns() || reconcileTimer) return;
        // 原因：系统意外关闭窗口时 Host 的 turn 仍然活跃，必须主动重建，不能等下一条状态。
        setupRetryAvailable = true;
        reconcileTimer = schedule(() => {
          reconcileTimer = null;
          ensureWindow();
        }, 0);
      });
      loadContent(created);
    } catch (error) {
      options.logger.warn("[cua-operation-indicator] failed to create secure window", error);
      if (created) discardFailedWindow(created);
      scheduleSetupRetry();
    }
  }

  function hideOrDestroy(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      target.hide();
      windowShown = false;
      return;
    } catch (error) {
      // 关闭是这个浮层的安全底线：它在声称"ZCode 正在操作电脑"，隐藏失败就等于向用户
      // 撒谎。hide() 抛错时降级为销毁窗口——下一个 CUA cell 会由 ensureWindow 重建。
      options.logger.warn("[cua-operation-indicator] hide failed, destroying window", error);
    }
    if (window === target) {
      window = null;
      windowReady = false;
    }
    windowShown = false;
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.warn(
        "[cua-operation-indicator] destroy after failed hide failed",
        destroyError,
      );
    }
  }

  function beginHide(): void {
    setupRetryAvailable = false;
    if (!window || window.isDestroyed() || hideTimer) return;
    setDocumentState("leaving");
    const target = window;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (!disposed && !hasActiveTurns() && target === window && !target.isDestroyed()) {
        hideOrDestroy(target);
      }
    }, HIDE_ANIMATION_MS);
  }

  function handleState(source: object, event: HostCuaOperationStateResponse): void {
    if (disposed || platform !== "win32") return;
    const key = keyFor(event);
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (event.active) {
      if (sourceKeys?.has(key)) {
        cancelPendingHide();
        scheduleAutoHide(source, key);
        ensureWindow();
        return;
      }
      const wasActive = hasActiveTurns();
      if (!wasActive) setupRetryAvailable = true;
      const nextKeys = sourceKeys ?? new Set<string>();
      nextKeys.add(key);
      activeTurnKeysBySource.set(source, nextKeys);
      scheduleAutoHide(source, key);
      // 只有 aggregate 从空变为非空时按当前鼠标显示器重定位，避免并行 source 让窗口跳动。
      ensureWindow(!wasActive);
      return;
    }
    if (!sourceKeys?.delete(key)) return;
    cancelAutoHide(source, key);
    if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
    if (!hasActiveTurns()) beginHide();
  }

  function clearSource(source: object): void {
    if (disposed || platform !== "win32" || !activeTurnKeysBySource.delete(source)) return;
    const timers = autoHideTimersBySource.get(source);
    for (const key of timers ? [...timers.keys()] : []) {
      cancelAutoHide(source, key);
    }
    if (!hasActiveTurns()) beginHide();
  }

  function refreshContent(): void {
    if (disposed || platform !== "win32" || !window || window.isDestroyed()) return;
    if (hasActiveTurns()) setupRetryAvailable = true;
    loadContent(window);
  }

  function ownsWindow(candidate: object): boolean {
    return ownedWindows.has(candidate);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    setupRetryAvailable = false;
    activeTurnKeysBySource.clear();
    for (const [source, timers] of autoHideTimersBySource) {
      for (const timer of timers.values()) cancelSchedule(timer);
      autoHideTimersBySource.delete(source);
    }
    cancelPendingHide();
    if (reconcileTimer) {
      cancelSchedule(reconcileTimer);
      reconcileTimer = null;
    }
    const target = window;
    window = null;
    windowReady = false;
    windowShown = false;
    if (target && !target.isDestroyed()) target.destroy();
  }

  return { handleState, clearSource, ownsWindow, refreshContent, dispose };
}
