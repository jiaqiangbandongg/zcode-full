import type { BotActor, BotContextState } from "@zcode/shared";

/** 群身份不能用发送者代替，否则多人会串到私聊或各自创建任务。 */
export function getBotConversationKey(
  actor: Pick<BotActor, "botId" | "chatType" | "chatId" | "threadId" | "conversationThreadId">,
): string {
  if (actor.chatType === "private") return actor.botId;
  const chatId = actor.chatId?.trim();
  if (!chatId) throw new Error("Group chat ID is required");
  // 旧默认群键保持不变；话题必须进入独立键，不能覆盖群默认任务。
  const threadId = (
    actor.conversationThreadId !== undefined ? actor.conversationThreadId : actor.threadId
  )?.trim();
  return JSON.stringify(threadId ? [actor.botId, chatId, threadId] : [actor.botId, chatId]);
}

export function getBotStateKey(context: BotContextState): string {
  return getBotConversationKey({
    botId: context.botId,
    chatType: context.group ? "group" : "private",
    chatId: context.group?.chatId,
    threadId: context.group?.threadId,
  });
}

export function isGroupOwnerCommand(command: string): boolean {
  return !["help", "status", "message", "answer"].includes(command);
}

export function canAnswerGroupQuestion(
  actorId: string,
  ownerId: string,
  initiatorId: string | undefined,
  isPlan: boolean,
): boolean {
  return actorId === ownerId || (!isPlan && actorId === initiatorId);
}
