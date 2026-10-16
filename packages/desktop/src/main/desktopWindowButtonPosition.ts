import { nativeTheme, type BrowserWindow, type Point } from "electron";
import { PlatformChannels } from "@zcode/shared";
import {
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";

export const MACOS_TRAFFIC_LIGHT_BASE_POSITION = { x: 22, y: 23 } as const;
export const MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX = 96;
export const MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN = 1.5;
export const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
export const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX = 4;
const customWindowsControls = new WeakSet<BrowserWindow>();

export function registerCustomWindowsControls(window: BrowserWindow) {
  customWindowsControls.add(window);
}

export function hasCustomWindowsControls(window: BrowserWindow) {
  return customWindowsControls.has(window);
}

export function resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel: number): Point {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const resolveVerticalPosition = (base: number) =>
    Math.max(
      MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX,
      Math.round(base + (base * zoomFactor - base) * MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN),
    );
  return {
    x: MACOS_TRAFFIC_LIGHT_BASE_POSITION.x,
    y: resolveVerticalPosition(MACOS_TRAFFIC_LIGHT_BASE_POSITION.y),
  };
}

export function resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const buttonPosition = resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel);
  return {
    buttonPosition,
    metrics: {
      leftPaddingPx: Math.round(MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX / zoomFactor),
    },
  };
}

export function resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel: number) {
  return Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * resolveDesktopZoomFactorForLevel(zoomLevel));
}

export function resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  return {
    // 原生按钮宽度不随页面缩放；固定 CSS 边距只适用于下面的自绘窗控分支。
    rightPaddingPx: Math.round(
      WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / resolveDesktopZoomFactorForLevel(zoomLevel),
    ),
    titleBarHeightPx: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function buildWindowsTitleBarOverlayForZoomLevel(
  zoomLevel: number,
  theme: "light" | "dark",
) {
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#f5f5f5" : "#1f1f1f",
    height: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function syncWindowControlsOverlayForZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  zoomLevel: number,
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (process.platform === "darwin") {
    const { buttonPosition, metrics } =
      resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel);
    // 页面缩放会改变 renderer 顶部栏的视觉尺寸，但 macOS 原生红绿灯不会随页面缩放。
    // 每次缩放后按同一 zoom factor 调整原生按钮纵向位置；横向位置先保持系统初始值，避免和固定宽度安全区重复补偿。
    // 红绿灯自身宽度不随页面 zoom 变化，所以 renderer 的 CSS padding 要按 zoom factor 反向补偿。
    targetWindow.setWindowButtonPosition(buttonPosition);
    targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, metrics);
    return;
  }

  if (process.platform === "win32") {
    if (hasCustomWindowsControls(targetWindow)) {
      // 自绘按钮随页面缩放，安全区也使用固定 CSS 像素，不能再反向补偿原生按钮宽度。
      targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, {
        rightPaddingPx: WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX,
      });
      return;
    }
    // Windows titleBarOverlay 的原生窗控不会跟 renderer 页面缩放自动同步。
    // 只同步高度会让右上角按钮和标题栏垂直尺寸一致，但固定 136px 安全区会被页面 zoom 一起放大，
    // 导致左侧按钮组和右侧窗控越拉越远；缩小时如果高度还被基线钳住，窗控也会提前停止变化。
    // 这里同时同步 overlay.height，并把 renderer 的右侧安全区按 zoomFactor 反向补偿，让两侧布局继续同频缩放。
    targetWindow.setTitleBarOverlay(
      buildWindowsTitleBarOverlayForZoomLevel(
        zoomLevel,
        nativeTheme.shouldUseDarkColors ? "dark" : "light",
      ),
    );
    targetWindow.webContents.send(
      PlatformChannels.WindowControlsOverlayChanged,
      resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel),
    );
  }
}

export function syncMacOSWindowButtonPositionForZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  zoomLevel: number,
) {
  syncWindowControlsOverlayForZoomLevel(targetWindow, zoomLevel);
}

export function syncMacOSWindowButtonPositionForCurrentZoomFactor(
  targetWindow: BrowserWindow | null | undefined,
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  syncWindowControlsOverlayForZoomLevel(targetWindow, zoomLevel);
}
