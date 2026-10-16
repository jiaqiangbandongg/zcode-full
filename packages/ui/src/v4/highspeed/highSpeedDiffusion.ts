export const HIGHSPEED_DIFFUSION_DURATION_MS = 1_400;
const HIGHSPEED_DIFFUSION_FINISH_START_PROGRESS = 0.84;
export const HIGHSPEED_MODEL_SWITCH_START_PROGRESS = 0.8;

interface HighSpeedDiffusionDistanceInput {
  height: number;
  width: number;
  x: number;
  y: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * 解析 sRGB 颜色的 hex（3/4/6/8 位）或 `rgb()`/`rgba()` 序列化，忽略透明度；
 * 其他颜色函数返回 null，避免把 `oklch()` 等的分量误读为 RGB 通道。
 */
export function parseHighSpeedCanvasColor(value: string): readonly [number, number, number] | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
    return [channel(0), channel(2), channel(4)];
  }

  const rgb = normalized.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/**
 * 把 CSS 颜色 token 交给 Canvas 规范化后解析为 RGB；token 缺失或 Canvas 无法解析时返回兜底色。
 *
 * Bug 根因：生产构建由 Lightning CSS 压缩颜色（如 `#ffffff` → `#fff`，也可能改写为颜色名），
 * 旧的手写解析只认 6 位 hex，失败后落回深色兜底，浅色主题的扩散马赛克因此显示为深色。
 * 回归约束：Canvas 对无法解析的值（如 `var()`，CSS.supports 却会接受）静默忽略并保留旧
 * fillStyle，不能用单次赋值后的读数判定；这里先后以两种不同哨兵色打底各赋值一次，两次读数
 * 一致才说明赋值被接受，否则会把默认黑色或上一个 token 的颜色当成本次结果。
 */
export function resolveHighSpeedCanvasColor(
  context: Pick<CanvasRenderingContext2D, "fillStyle">,
  value: string,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  const specified = value.trim();
  if (!specified) return fallback;

  context.fillStyle = "#000000";
  context.fillStyle = specified;
  const overBlack = context.fillStyle;
  context.fillStyle = "#ffffff";
  context.fillStyle = specified;
  const overWhite = context.fillStyle;
  if (typeof overBlack !== "string" || overBlack !== overWhite) return fallback;
  return parseHighSpeedCanvasColor(overBlack) ?? fallback;
}

export function resolveHighSpeedDiffusionProgress(elapsedMs: number): number {
  return clampUnit(elapsedMs / HIGHSPEED_DIFFUSION_DURATION_MS);
}

export function shouldCompleteHighSpeedDiffusion(progress: number): boolean {
  return progress >= HIGHSPEED_DIFFUSION_FINISH_START_PROGRESS;
}

export function shouldStartHighSpeedModelSwitch(progress: number): boolean {
  return progress >= HIGHSPEED_MODEL_SWITCH_START_PROGRESS;
}

export function resolveHighSpeedDiffusionDistance({
  height,
  width,
  x,
  y,
}: HighSpeedDiffusionDistanceInput): number {
  const radiusX = Math.max(width / 2, 1);
  const radiusY = Math.max(height / 2, 1);
  const dx = Math.abs((x - width / 2) / radiusX);
  const dy = Math.abs((y - height / 2) / radiusY);

  // 四次超椭圆让长条 Composer 的四向推进更接近参考中的厚像素波，而不是尖锐圆环。
  return Math.pow(dx ** 4 + dy ** 4, 0.25);
}
