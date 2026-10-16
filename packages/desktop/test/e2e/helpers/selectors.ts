/**
 * 根据 test-ids 常量值生成 CSS 属性选择器。
 * 用法: sel(TID_LOGIN_BUTTON) => '[data-testid="login-button"]'
 */
export function sel(tid: string): string {
  return `[data-testid="${tid}"]`;
}
