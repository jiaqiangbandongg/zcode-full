import {
  BROWSER_VIEWPORT_ZOOM_OPTIONS,
  DEFAULT_BROWSER_VIEWPORT_ZOOM,
  type BrowserViewportSize,
  type BrowserViewportZoom,
} from "@zcode/shared";

export { BROWSER_VIEWPORT_ZOOM_OPTIONS, DEFAULT_BROWSER_VIEWPORT_ZOOM };
export type { BrowserViewportZoom };

/** Fit 的画布内边距与 ResponsiveBrowserViewport 的 `p-4` 保持一致。 */
export const RESPONSIVE_BROWSER_CANVAS_PADDING_PX = 16;

export function resolveBrowserViewportScale({
  canvasSize,
  desktopZoomFactor = 1,
  viewportSize,
  zoom,
}: {
  canvasSize: BrowserViewportSize | null;
  desktopZoomFactor?: number;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): number {
  if (zoom !== "fit") {
    return Number(zoom) / 100;
  }
  if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) {
    return 1;
  }

  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  // ResizeObserver 返回父 renderer 页面缩放后的 CSS 尺寸；换算为屏幕视觉尺寸后再解析 Fit，
  // 才不会让应用全局缩放被误当成浏览器预览缩放。
  const availableWidth =
    Math.max(0, canvasSize.width - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  const availableHeight =
    Math.max(0, canvasSize.height - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  if (availableWidth === 0 || availableHeight === 0) {
    return 1;
  }

  return Math.min(1, availableWidth / viewportSize.width, availableHeight / viewportSize.height);
}

export function resolveBrowserViewportRendererScale({
  desktopZoomFactor,
  visualScale,
}: {
  desktopZoomFactor: number;
  visualScale: number;
}): number {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  return visualScale / safeDesktopZoomFactor;
}

export function resolveResponsiveBrowserGuestLayout(desktopZoomFactor: number): {
  layoutScale: number;
  transformScale: number;
} {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;

  // 放大档曾把补偿交给 main 的 CDP metrics scale，但 metrics 是 per-session 状态，
  // 命令空闲 detach 后被 Chromium 清掉，guest 退回 viewport × zoom，Browser Use 每次操作页面都会
  // 变大又变回。放大和缩小统一在宿主布局补偿：先按 1 / zoom 布局，再缩放回 frame，
  // guest 的自然 viewport 因此与 CDP 是否 attach 无关。
  return {
    layoutScale: 1 / safeDesktopZoomFactor,
    transformScale: safeDesktopZoomFactor,
  };
}
