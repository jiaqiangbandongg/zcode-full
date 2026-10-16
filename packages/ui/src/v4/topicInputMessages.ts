import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";

/** 合批是执行边界，不能把多人消息展示成一个人的正文。 */
export function expandTopicInputMessages(row: UserInputRow): UserInputRow[] {
  const source = row.botGroupSource;
  if (!source?.messages?.length) return [row];
  const claimed = new Set(source.messages.flatMap((message) => message.attachmentIndexes));
  const shared = row.attachments?.filter((_, index) => !claimed.has(index)) ?? [];
  return source.messages.map((message, index) => ({
    ...row,
    text: message.text,
    conversationQuotes: message.conversationQuotes ?? [],
    attachments: [
      ...(row.attachments?.filter((_, attachmentIndex) =>
        message.attachmentIndexes.includes(attachmentIndex),
      ) ?? []),
      ...(index === 0 ? shared : []),
    ],
    botGroupSource: {
      ...source,
      messages: undefined,
      topicContext: undefined,
      topicHistory: undefined,
      messageId: message.messageId,
      contentParts: message.contentParts,
      senderId: message.senderId,
      senderName: message.senderName,
    },
  }));
}
