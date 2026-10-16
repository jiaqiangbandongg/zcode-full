import { getUnavailableReplyFallback } from "#src/bots/groupReply.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { BotGroupDelivery } from "@zcode/shared";

interface GroupDeliveryDependencies {
  read(id: string): Promise<BotGroupDelivery | undefined>;
  write(result: BotGroupDelivery): Promise<void>;
  authorized(result: BotGroupDelivery): Promise<boolean>;
  send(result: BotGroupDelivery): Promise<void | { providerMessageId: string }>;
  onSettled?(): Promise<void>;
  delay?(milliseconds: number): Promise<void>;
}

/** 只保存和发送已生成结果；不持有任务执行或输入队列。 */
export function createGroupResultDelivery(deps: GroupDeliveryDependencies) {
  const inFlight = new Map<string, Promise<void>>();
  const deliver = (result: BotGroupDelivery, retry = false): Promise<void> => {
    const existing = inFlight.get(result.id);
    if (existing) return existing;
    const operation = (async () => {
      const saved = await deps.read(result.id);
      const current = saved ?? result;
      if (saved && (saved.status !== "failed" || !retry)) return;
      let attemptResult = current;
      let retries = 0;
      for (;;) {
        if (!(await deps.authorized(attemptResult))) {
          await deps.write({ ...attemptResult, status: "invalidated", updatedAt: Date.now() });
          return;
        }
        // 请求前落盘 unknown，进程中断后不得把不确定结果当作未发送。
        await deps.write({ ...attemptResult, status: "unknown", updatedAt: Date.now() });
        try {
          const sent = await deps.send(attemptResult);
          await deps.write({
            ...attemptResult,
            ...(sent ? { providerMessageId: sent.providerMessageId } : {}),
            status: "sent",
            lastError: undefined,
            updatedAt: Date.now(),
          });
          return;
        } catch (error) {
          const details = error as {
            deliveryRejected?: boolean;
            deliveryReplyUnavailable?: boolean;
            retryAfterMs?: number;
          } | null;
          const rejected = details?.deliveryRejected === true;
          await deps.write({
            ...attemptResult,
            status: rejected ? "failed" : "unknown",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
          });
          // 只有明确拒绝才降级；普通群去掉引用，话题最多退到根锚点，群目标仍由闭包固定。
          if (rejected && details?.deliveryReplyUnavailable) {
            const fallback = getUnavailableReplyFallback(attemptResult);
            if (fallback) {
              attemptResult = { ...attemptResult, ...fallback };
              continue;
            }
          }
          if (
            rejected &&
            typeof details?.retryAfterMs === "number" &&
            Number.isFinite(details.retryAfterMs) &&
            retries < 2
          ) {
            retries += 1;
            await (deps.delay ?? sleep)(
              Math.max(250, Math.min(30_000, details.retryAfterMs * retries)),
            );
            continue;
          }
          return;
        }
      }
    })().finally(async () => {
      inFlight.delete(result.id);
      await deps.onSettled?.();
    });
    inFlight.set(result.id, operation);
    return operation;
  };
  return Object.assign(deliver, {
    isInFlight: (id: string) => inFlight.has(id),
    // Bug 原因：崩溃恢复用的 unknown 曾直接触发 UI 告警；活跃发送只投影 pending，不能改写恢复记录。
    project: (result: BotGroupDelivery): BotGroupDelivery =>
      inFlight.has(result.id) ? { ...result, status: "pending" } : result,
  });
}
