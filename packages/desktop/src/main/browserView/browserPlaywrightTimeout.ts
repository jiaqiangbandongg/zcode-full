export const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 3_000;

/**
 * 内置浏览器对常规 Playwright 操作使用短失败预算：默认 3s，且由调用点给出上限。
 * 旧 IAB 直接采用 30s，导致猜错 locator 后长时间无效轮询；统一 normalizer 避免各 adapter 再次漂移。
 */
export function normalizePlaywrightTimeout(
  timeoutMs: number | undefined,
  max = PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
): number {
  const requested = typeof timeoutMs === "number" ? timeoutMs : PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(0, requested), max || PLAYWRIGHT_DEFAULT_TIMEOUT_MS);
}
