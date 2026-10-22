const fallbackToastClaimsByCommandId = new Set<string>();
const cardInvalidationClaims = new Set<string>();

/**
 * 降级事件可能因 snapshot 重放或 SessionPane 重挂载被观察多次；模块级 claim 保证 Toast 只提示一次。
 */
export function claimHighspeedFallbackToast(sourceCommandId: string): boolean {
  if (fallbackToastClaimsByCommandId.has(sourceCommandId)) return false;
  fallbackToastClaimsByCommandId.add(sourceCommandId);
  return true;
}

/** Highspeed 退回或错误终态会随 snapshot 重放；同一失败事实只向卡片 owner 发送一次作废指令。 */
export function claimHighspeedCardInvalidation(sourceCommandId: string): boolean {
  if (cardInvalidationClaims.has(sourceCommandId)) return false;
  cardInvalidationClaims.add(sourceCommandId);
  return true;
}

/** 本地服务调用异常时释放 claim，让下一次 snapshot 可以重试。 */
export function releaseHighspeedCardInvalidation(sourceCommandId: string): void {
  cardInvalidationClaims.delete(sourceCommandId);
}
