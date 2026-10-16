/**
 * CUA 权限拖拽浮窗的生命周期管理。
 *
 * 这个窗口有四个不可妥协的性质，全部来自实测：
 *
 * 1. **不能激活自己所属的 app**（`type: "panel"` + `focusable: false`，两者缺一不可）。它浮在
 *    「系统设置」之上，用户要在它和设置页之间拖拽。只设 focusable 时点击仍会激活 ZCode.app，
 *    焦点跳到主窗，引导流程当场断掉 —— 详见 `createRealCuaPermissionPanelWindow` 的注释。
 * 2. **必须压过系统设置**（`alwaysOnTop(true, "screen-saver")`）。普通 `floating` 层级在设置页
 *    激活时会被盖住。
 * 3. **拖拽落地后停止跟踪位置**（`freezePosition()`）。系统设置随后会弹模态提示，继续跟踪会让
 *    浮窗追着提示框跑并被压到它下面。
 * 4. **每个终态都必须销毁**。PiP 面板曾因为缺少明确启停边界而凭空常驻；这里 show/hide/destroy
 *    三态明确，destroy 幂等且会停掉定位数据源。
 *
 * 真实 BrowserWindow 通过 `createWindow` 注入，使生命周期与定位逻辑可以脱离 Electron 单测。
 */

import type { CuaPermissionKind, Locale } from "@zcode/shared";
import { resolvePanelBounds, type PanelSize, type Rect } from "./cuaPermissionPanelPositioner.js";

/** 浮窗需要的最小窗口能力面，便于测试替身实现。 */
export interface CuaPermissionPanelWindow {
  onceReadyToShow(callback: () => void): void;
  setBounds(bounds: Rect): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface CreateCuaPermissionDragPanelOptions {
  createWindow: (initialBounds: Rect) => CuaPermissionPanelWindow;
  getDisplayWorkArea: () => Rect;
  /** 系统设置窗口 bounds 数据源；缺失或抛错时 fail-open 到屏幕底部。 */
  getSettingsBounds?: () => Rect | null;
  /** 释放上述数据源（通常是 kill 掉常驻子进程）。 */
  stopSettingsBounds?: () => void;
  /** 浮窗 tile 显示的应用图标（data URL）。缺省时页面回退到内置占位图形。 */
  getIconDataUrl?: () => string | null;
  /** ZCode 当前界面语言。每次 show 都重新读取，禁止浮窗自行猜测系统语言。 */
  getLocale: () => Locale;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  panelSize?: PanelSize;
  repositionIntervalMs?: number;
}

export interface CuaPermissionDragPanel {
  show(permission: CuaPermissionKind): void;
  /**
   * 停止位置跟踪但保持窗口可见可拖。
   *
   * 拖拽落地后系统设置会弹一个模态提示（"…may not be able to record…"），继续跟踪会让浮窗
   * 追着提示框跑、把自己塞到它下面。拖过一次之后位置就该定住 —— 此时用户注意力已在系统设置上，
   * 浮窗再动只会干扰。下一个权限阶段 `show()` 时会自动恢复跟踪。
   */
  freezePosition(): void;
  hide(): void;
  destroy(): void;
}

export const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

const DEFAULT_PANEL_SIZE: PanelSize = { width: 560, height: 124 };
// 使用 0.15 秒跟踪间隔，兼顾位置同步开销与设置页拖动时的面板响应。
const DEFAULT_REPOSITION_INTERVAL_MS = 150;

export function createCuaPermissionDragPanel(
  options: CreateCuaPermissionDragPanelOptions,
): CuaPermissionDragPanel {
  const panelSize = options.panelSize ?? DEFAULT_PANEL_SIZE;
  const intervalMs = options.repositionIntervalMs ?? DEFAULT_REPOSITION_INTERVAL_MS;

  let window: CuaPermissionPanelWindow | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastBounds: Rect | null = null;
  let destroyed = false;

  function readSettingsBounds(): Rect | null {
    if (!options.getSettingsBounds) return null;
    try {
      return options.getSettingsBounds();
    } catch (error) {
      // fail-open：吸附只是观感增强，数据源出问题绝不能让授权引导挂掉。
      options.logger.warn(
        "[cua-permission-panel] settings bounds source failed; falling back to screen bottom",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  function sameRect(a: Rect | null, b: Rect): boolean {
    return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function reposition(): void {
    if (!window || window.isDestroyed()) return;
    const bounds = resolvePanelBounds({
      settings: readSettingsBounds(),
      display: options.getDisplayWorkArea(),
      panel: panelSize,
    });
    // 每 tick 都 setBounds 会造成可见抖动，只在目标矩形真的变化时移动。
    if (sameRect(lastBounds, bounds)) return;
    lastBounds = bounds;
    window.setBounds(bounds);
  }

  function startTracking(): void {
    if (timer) return;
    timer = setInterval(reposition, intervalMs);
    // 定位跟踪绝不该阻止进程退出。
    timer.unref?.();
  }

  function stopTracking(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    show(permission: CuaPermissionKind): void {
      if (destroyed) destroyed = false;
      const initialBounds = resolvePanelBounds({
        settings: readSettingsBounds(),
        display: options.getDisplayWorkArea(),
        panel: panelSize,
      });
      lastBounds = initialBounds;

      if (!window || window.isDestroyed()) {
        window = options.createWindow(initialBounds);
        window.onceReadyToShow(() => {
          if (!window || window.isDestroyed()) return;
          window.setBounds(lastBounds ?? initialBounds);
          // 浮窗是独立静态 renderer，不在主 React Intl 树内；不传 locale 的话
          // 英文 ZCode 也会显示硬编码中文。先发当前 locale 再显示，避免中文 fallback 闪屏。
          window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
            permission,
            locale: options.getLocale(),
            iconDataUrl: options.getIconDataUrl?.() ?? null,
          });
          window.showInactive();
          startTracking();
        });
        return;
      }

      window.setBounds(initialBounds);
      window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
        permission,
        locale: options.getLocale(),
        iconDataUrl: options.getIconDataUrl?.() ?? null,
      });
      window.showInactive();
      startTracking();
    },

    hide(): void {
      stopTracking();
      if (window && !window.isDestroyed()) window.hide();
    },

    freezePosition(): void {
      stopTracking();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopTracking();
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      lastBounds = null;
      options.stopSettingsBounds?.();
    },
  };
}

/**
 * 生产用的真实窗口工厂。属性组合是实测出来的最小可用集，逐条都有理由：
 *   frame:false + transparent  —— 圆角浮层观感
 *   type:"panel"               —— NSPanel + NSWindowStyleMaskNonactivatingPanel：
 *                                 点击此窗口**不激活所属 app**
 *   focusable:false            —— 窗口自身不接收焦点
 *   skipTaskbar:true           —— 不进 Dock/任务切换
 *   show:false + showInactive  —— 显示但不激活
 *   alwaysOnTop("screen-saver")—— 压过系统设置窗口；floating 层级会被盖住
 *
 * `type` 与 `focusable` 必须**同时**存在，这是踩过的坑：初版只设 focusable:false，点击浮窗后
 * 焦点跳到了 ZCode 主窗。三方对比实测结论 ——
 *   focusable:false 单独          → app 仍被激活，焦点落到同 app 下一个可聚焦窗口（主窗）
 *   type:panel 单独（focusable 默认 true） → panel 自己拿焦点并激活 app，系统设置照样被踢走
 *   两者兼备                       → 点击后零 focus 事件，系统设置保持前台 ✓
 * 换言之 focusable 管「窗口不拿焦点」，type:panel 管「app 不被激活」，缺任一半都会破功。
 */
export function createRealCuaPermissionPanelWindow(deps: {
  BrowserWindow: typeof import("electron").BrowserWindow;
  app: Pick<typeof import("electron").app, "isPackaged">;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
}): (initialBounds: Rect) => CuaPermissionPanelWindow {
  return (initialBounds: Rect) => {
    const win = new deps.BrowserWindow({
      ...initialBounds,
      // macOS: NSPanel with NSWindowStyleMaskNonactivatingPanel —— 见上方注释，
      // 这是「点击浮窗不把系统设置踢到后台」的必要条件。
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // 与主窗口保持一致：生产包始终加载签名包内的渲染资源。
    if (!deps.app.isPackaged && deps.rendererDevUrl) {
      void win.loadURL(`${deps.rendererDevUrl}/cua-permission-panel.html`);
    } else {
      void win.loadFile(`${deps.rendererDir}/cua-permission-panel.html`);
    }

    return {
      onceReadyToShow(callback: () => void) {
        win.once("ready-to-show", callback);
      },
      setBounds(bounds: Rect) {
        win.setBounds(bounds);
      },
      showInactive() {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      },
      hide() {
        win.hide();
      },
      destroy() {
        win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      send(channel: string, payload: unknown) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
    };
  };
}
