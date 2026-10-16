/**
 * 权限拖拽浮窗的几何计算。
 *
 * 刻意做成不依赖 Electron 的纯函数：吸附需要「系统设置窗口的 bounds」这一外部数据，而该数据随时
 * 可能拿不到（提供它的 CLI 未随包、被杀、或设置页根本没开）。把几何与数据获取分离后，fail-open
 * 行为才可被穷举测试 —— 吸附是观感增强，不是可用性前提，拿不到 bounds 必须退回一个确定可用的位置。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface ResolvePanelBoundsInput {
  /** 系统设置主窗口的屏幕坐标；null 表示当前拿不到（fail-open 到屏幕底部）。 */
  settings: Rect | null;
  /** 目标显示器的可用工作区（已排除菜单栏/Dock）。 */
  display: Rect;
  panel: PanelSize;
}

/** 吸附时与设置页底边的微重叠，观感上让面板与设置页连成一体。 */
const ANCHOR_OVERLAP_PX = 6;
/** fail-open 时距屏幕底部的留白。 */
const SCREEN_BOTTOM_INSET_PX = 28;

function clamp(value: number, min: number, max: number): number {
  // max < min 时（面板比可视区还大）优先保证不超出上/左边界
  return Math.max(min, Math.min(value, max));
}

function isUsableRect(rect: Rect | null): rect is Rect {
  // CGWindowList 偶尔返回 0 尺寸的过渡态窗口；吸附到它会把面板扔到屏幕角落，按不可用处理。
  return rect !== null && rect.width > 0 && rect.height > 0;
}

export function resolvePanelBounds(input: ResolvePanelBoundsInput): Rect {
  const { settings, display, panel } = input;

  const anchored = isUsableRect(settings);
  const rawX = anchored
    ? settings.x + (settings.width - panel.width) / 2
    : display.x + (display.width - panel.width) / 2;
  const rawY = anchored
    ? settings.y + settings.height - ANCHOR_OVERLAP_PX
    : display.y + display.height - panel.height - SCREEN_BOTTOM_INSET_PX;

  return {
    x: Math.round(clamp(rawX, display.x, display.x + display.width - panel.width)),
    y: Math.round(clamp(rawY, display.y, display.y + display.height - panel.height)),
    width: Math.round(panel.width),
    height: Math.round(panel.height),
  };
}
