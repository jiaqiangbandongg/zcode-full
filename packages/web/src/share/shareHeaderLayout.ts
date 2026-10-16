export interface ShareHeaderMeasurements {
  /** 分享 Header shell 的宽度。 */
  shellWidth: number;
  /** 内容 rail 左右边缘到 shell 边缘的距离。 */
  railContentLeft: number;
  railContentRight: number;
  brandWidth: number;
  titleContentWidth: number;
  /** 主题按钮与完整继续 CTA 的总宽度。 */
  continueWidth: number;
  /** 主题按钮与紧凑继续 CTA 的总宽度。 */
  compactContinueWidth?: number;
  /** 右侧区域是否包含继续 CTA；只读分享仍会保留主题按钮。 */
  hasContinueAction?: boolean;
  gap?: number;
  /** 宽屏锚点距视口边缘的内边距。 */
  edgePadding?: number;
  /** 两侧元素进入连续位移动画前必须保留的安全间距。 */
  minClearance?: number;
  /** 完整 CTA 至少要为可见标题保留的宽度。 */
  minTitleWidth?: number;
}

export interface ShareHeaderView {
  /** 0 是内容栏内联位置，1 是视口两侧锚定位置。 */
  progress: number;
  brandLeft: number;
  titleLeft: number;
  titleWidth: number;
  continueRight: number;
  titleTruncated: boolean;
  continueVisible: boolean;
  continueCompact: boolean;
}

const DEFAULT_GAP = 16;
const DEFAULT_EDGE_PADDING = 24;
const DEFAULT_MIN_CLEARANCE = 16;
const DEFAULT_MIN_TITLE_WIDTH = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * 计算分享 Header 的连续几何位置。
 *
 * 之前这里返回 inline/rail-aligned 两个离散布局，品牌和 CTA 会在临界宽度
 * 一次性从 flex 流切到绝对定位。现在用内容栏与视口边缘之间的可用 gutter
 * 推导 progress，让三个元素沿同一条轨道连续移动；当 gutter 仍足够容纳
 * 对应元素时保持宽屏外侧锚点，只有 gutter 不足后才开始向内容栏回收。
 */
export function resolveShareHeaderView({
  shellWidth,
  railContentLeft,
  railContentRight,
  brandWidth,
  titleContentWidth,
  continueWidth,
  compactContinueWidth = continueWidth,
  hasContinueAction = continueWidth > 0,
  gap = DEFAULT_GAP,
  edgePadding = DEFAULT_EDGE_PADDING,
  minClearance = DEFAULT_MIN_CLEARANCE,
  minTitleWidth = DEFAULT_MIN_TITLE_WIDTH,
}: ShareHeaderMeasurements): ShareHeaderView {
  const normalizedShellWidth = Math.max(0, shellWidth);
  const normalizedRailLeft = Math.max(0, railContentLeft);
  const normalizedRailRight = Math.max(0, railContentRight);
  const normalizedBrandWidth = Math.max(0, brandWidth);
  const normalizedTitleContentWidth = Math.max(0, titleContentWidth);
  const normalizedContinueWidth = Math.max(0, continueWidth);
  const normalizedCompactContinueWidth = Math.min(
    normalizedContinueWidth,
    Math.max(0, compactContinueWidth),
  );
  const normalizedGap = Math.max(0, gap);
  const normalizedEdgePadding = Math.max(0, edgePadding);
  const normalizedMinClearance = Math.max(0, minClearance);
  const normalizedMinTitleWidth = Math.max(0, minTitleWidth);
  const brandRequiredGutter = normalizedBrandWidth + normalizedEdgePadding + normalizedMinClearance;
  const brandProgress = clamp(normalizedRailLeft / brandRequiredGutter, 0, 1);
  const narrowBrandLeft = normalizedRailLeft;
  const narrowTitleLeft = normalizedRailLeft + normalizedBrandWidth + normalizedGap;
  const wideBrandLeft = normalizedEdgePadding;
  const wideTitleLeft = normalizedRailLeft;
  const wideTitleRight = normalizedShellWidth - normalizedRailRight;
  const wideContinueRight = normalizedEdgePadding;
  const brandLeft = lerp(narrowBrandLeft, wideBrandLeft, brandProgress);
  const titleLeft = Math.max(
    brandLeft + normalizedBrandWidth + normalizedGap,
    lerp(narrowTitleLeft, wideTitleLeft, brandProgress),
  );

  const resolveTrailingGeometry = (trailingWidth: number) => {
    const continueRequiredGutter = trailingWidth + normalizedEdgePadding + normalizedMinClearance;
    const continueProgress =
      trailingWidth === 0 ? 1 : clamp(normalizedRailRight / continueRequiredGutter, 0, 1);
    const continueRight = lerp(normalizedRailRight, wideContinueRight, continueProgress);
    const narrowTitleRight =
      normalizedShellWidth - normalizedRailRight - trailingWidth - normalizedGap;
    const titleRight = Math.min(
      lerp(narrowTitleRight, wideTitleRight, continueProgress),
      normalizedShellWidth - continueRight - trailingWidth - normalizedGap,
    );
    return {
      continueProgress,
      continueRight,
      titleWidth: Math.max(0, titleRight - titleLeft),
    };
  };

  const fullGeometry = resolveTrailingGeometry(normalizedContinueWidth);
  // 极窄屏仍为完整 CTA 永久预留宽度，会把标题压到 0。先保持连续轨道，
  // 只有完整 CTA 无法留下最小标题宽度时才切换为同一位置上的紧凑图标按钮。
  const continueCompact =
    hasContinueAction &&
    normalizedCompactContinueWidth < normalizedContinueWidth &&
    fullGeometry.titleWidth < normalizedMinTitleWidth;
  const geometry = continueCompact
    ? resolveTrailingGeometry(normalizedCompactContinueWidth)
    : fullGeometry;

  return {
    progress: Math.min(brandProgress, geometry.continueProgress),
    brandLeft,
    titleLeft,
    titleWidth: geometry.titleWidth,
    continueRight: geometry.continueRight,
    titleTruncated: normalizedTitleContentWidth > geometry.titleWidth,
    continueVisible: hasContinueAction,
    continueCompact,
  };
}
