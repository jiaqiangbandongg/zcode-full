/** 管理入口共享稳定错误码映射；Host 原始错误仅留在日志与详情，避免直接变成用户文案。 */
export function getSourceServerManagementErrorMessage(
  cause: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  if (typeof code === "string") {
    const messageId = `settings.source.error.${code}`;
    const translated = formatMessage({ id: messageId });
    if (translated !== messageId) return translated;
  }
  return formatMessage({ id: "settings.source.operationFailed" });
}
