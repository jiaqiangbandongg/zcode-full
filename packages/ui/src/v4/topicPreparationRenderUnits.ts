import type { BotTopicPreparation as Preparation } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export function pendingTopicPreparations(
  items: readonly Preparation[],
  rows: readonly ConversationRow[],
) {
  const acceptedIds = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "userInput" || !row.botGroupSource) continue;
    acceptedIds.add(row.botGroupSource.messageId);
    for (const message of row.botGroupSource.messages ?? []) acceptedIds.add(message.messageId);
  }
  // 失败材料不再投影为临时消息，连同来源一起移除，避免残留空白轮次或错误块。
  return items.filter((item) => item.status !== "failed" && !acceptedIds.has(item.messageId));
}

/** 准备消息进入现有轮次的消息流及测高/滚动链路；不伪造 CLI accepted row。 */
export function withTopicPreparationMessages(
  units: ConversationTurnRenderUnit[],
  rows: readonly ConversationRow[],
  items: readonly Preparation[],
): ConversationTurnRenderUnit[] {
  const pending = pendingTopicPreparations(items, rows);
  if (!pending.length) return units;
  const last = units.at(-1);
  if (last) return [...units.slice(0, -1), { ...last, topicPreparations: pending }];
  // 尚无 CLI 消息时只创建本地展示单元，不产生任务、轮次或可编辑的假消息。
  return [
    {
      key: "topic-preparation",
      turnId: "topic-preparation",
      topicPreparations: pending,
      visibleUserInputs: [],
      assistantWorkRows: [],
      assistantHistoryRows: [],
      assistantFollowingRows: [],
      assistantTailRows: [],
      browserTurnEndRows: [],
      hookInvocations: [],
      assistantTextRows: [],
      leadingBoundaryRows: [],
      flowItems: [],
      renderRows: [],
      isLastTurn: true,
      isRunning: false,
      assistantHistoryDefaultOpen: false,
      timelineOnly: true,
    },
  ];
}
