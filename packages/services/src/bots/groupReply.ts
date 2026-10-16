import type { BotOutboundMessage } from "@zcode/shared";

type ReplyTarget = Pick<BotOutboundMessage, "replyToMessageId" | "threadId" | "rootMessageId">;

/** 明确拒绝后的有限降级；话题不能误发到群主聊天，也不能重试同一失效锚点。 */
export function getUnavailableReplyFallback(target: ReplyTarget): ReplyTarget | null {
  const current = target.replyToMessageId || (target.threadId ? target.rootMessageId : undefined);
  if (!current) return null;
  if (!target.threadId) return { ...target, replyToMessageId: undefined };
  if (!target.rootMessageId || current === target.rootMessageId) return null;
  return { ...target, replyToMessageId: target.rootMessageId };
}
