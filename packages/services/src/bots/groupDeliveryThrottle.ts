/** 群消息共享发送额度；只预留发送时间，不保存或执行任务输入。 */
export function createGroupDeliveryThrottle() {
  const nextSendAt = new Map<string, number>();
  return async (chatKey: string): Promise<void> => {
    const now = Date.now();
    const at = Math.max(now, nextSendAt.get(chatKey) ?? now);
    nextSendAt.set(chatKey, at + 250);
    if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
    // 空闲 key 不常驻；后续调用已预约时不能清掉它的额度。
    if ((nextSendAt.get(chatKey) ?? 0) <= Date.now()) nextSendAt.delete(chatKey);
  };
}
