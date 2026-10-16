import {
  aggregateHighspeedCardMetrics,
  listHighspeedTurnsByCard,
  listHighspeedTurnsBySession,
} from "@/highspeed/highspeedTurnStore.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";

/**
 * 诊断：这张卡为什么还不是自动分享候选，空数组表示已就绪。
 * 门禁条件与 turnStore.listHighspeedCardAutoShareCandidates 保持一致，
 * 由单测交叉断言两者结论不漂移；本模块只服务 debug 日志，不参与业务决策。
 */
export function collectHighspeedCardShareBlockers(cardId: string): string[] {
  const cardRecords = listHighspeedTurnsByCard(cardId);
  const blockers: string[] = [];
  if (cardRecords.length === 0) {
    return ["no-records"];
  }
  for (const record of cardRecords) {
    if (!record.metrics) {
      blockers.push(`turn-metrics-missing:${record.sourceCommandId}`);
      continue;
    }
    if (record.metrics.regularTps <= 0) {
      blockers.push(`turn-regular-tps-zero:${record.sourceCommandId}`);
    }
    if (record.metricsPersistedAt === undefined) {
      blockers.push(`turn-metrics-not-persisted:${record.sourceCommandId}`);
    }
    if (record.autoShareAttemptedAt !== undefined || record.autoSharedAt !== undefined) {
      blockers.push("auto-share-attempted");
    }
  }
  if (blockers.length === 0) {
    const metrics = aggregateHighspeedCardMetrics(cardId);
    if (metrics.outputTokens <= 0) {
      // 与候选判定同口径：没有生成内容的卡不得分享，也不得把 token_usage 强制成 1。
      blockers.push("zero-output");
    } else if (!isHighspeedShareEligible(metrics)) {
      // 与候选判定同口径：总体加速倍率 ≤1.2x 不发布左下角卡（spec §9），此处点名原因供 debug。
      blockers.push("below-min-speedup");
    }
  }
  return blockers;
}

/**
 * 诊断：会话内已到期、但还没有尝试过自动分享的卡。
 * 用于 debug 日志回答“左下角分享卡为什么没更新”；不改变分享行为。
 */
export function listHighspeedCardsAwaitingAutoShare(sessionId: string, now: number): string[] {
  const pendingRecords = listHighspeedTurnsBySession(sessionId).filter(
    (record) =>
      record.autoShareAttemptedAt === undefined && record.autoSharedAt === undefined,
  );
  const cardsById = new Map<string, typeof pendingRecords>();
  for (const record of pendingRecords) {
    const list = cardsById.get(record.card.cardId) ?? [];
    list.push(record);
    cardsById.set(record.card.cardId, list);
  }
  return [...cardsById.entries()]
    .filter(([, records]) => records.every((record) => record.card.expiresAt <= now))
    .map(([cardId]) => cardId);
}
