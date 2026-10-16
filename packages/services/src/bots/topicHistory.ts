import type { BotTopicHistoryBatch, BotTopicHistoryRequest, BotTopicMessage } from "@zcode/shared";

/** 区分权限拒绝和临时网络错误，避免错误引导用户授权。 */
export class TopicHistoryPermissionError extends Error {}

interface TopicHistoryReader {
  /** 原生 thread 容器按创建时间倒序分页；接口不支持时间过滤。 */
  list(page?: string): Promise<{ messages: BotTopicMessage[]; next?: string }>;
  get(messageId: string): Promise<BotTopicMessage>;
  hydrate?(message: BotTopicMessage): Promise<BotTopicMessage>;
}

/** 只准备不可变背景，不推进检查点；推进必须等到 CLI admission 确认。 */
export async function readTopicHistory(
  request: BotTopicHistoryRequest,
  reader: TopicHistoryReader,
): Promise<BotTopicHistoryBatch> {
  // 根消息首次 @ 也必须访问原生历史接口，不能因没有旧消息而跳过权限校验。
  if (request.messageId === request.rootMessageId && !request.checkpoint) {
    await reader.list();
    return { messages: [], checkpoint: request.messageId, hasGap: false };
  }
  const seen = new Set<string>();
  const messages: BotTopicMessage[] = [];
  let boundaryFound = false;
  let checkpointFound = !request.checkpoint;
  let hasGap = false;
  let page: string | undefined;
  let examined = 0;
  let finished = false;
  const validate = (message: BotTopicMessage) => {
    if (message.chatId !== request.chatId || message.threadId !== request.threadId)
      throw new Error("Topic history scope mismatch");
  };
  // 有限页数也限制本次 @ 之后大量新消息的扫描，避免热话题一直追不上边界。
  for (let pages = 0; pages < 8 && !finished; pages += 1) {
    const batch = await reader.list(page);
    for (const message of batch.messages) {
      validate(message);
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (!boundaryFound) {
        if (message.id === request.messageId) boundaryFound = true;
        continue;
      }
      if (message.id === request.checkpoint) {
        checkpointFound = true;
        finished = true;
        break;
      }
      if (examined >= 200) {
        hasGap = true;
        finished = true;
        break;
      }
      examined += 1;
      if (message.deleted) hasGap = true;
      if (!message.deleted && message.id !== request.rootMessageId) messages.push(message);
    }
    if (!batch.next) finished = true;
    else if (!finished) page = batch.next;
  }
  if (!boundaryFound) throw new Error("Topic history invocation boundary unavailable");
  if (!finished || !checkpointFound) hasGap = true;
  messages.reverse();
  if (!request.checkpoint) {
    const root = await reader.get(request.rootMessageId);
    validate(root);
    if (root.deleted) hasGap = true;
    else if (root.id !== request.messageId) messages.unshift(root);
  }
  // 历史窗口外和删除卡片不能因正文读取失败阻断本轮输入；先筛选再读取必要材料。
  if (reader.hydrate) {
    const hydrated = await Promise.all(messages.map((message) => reader.hydrate!(message)));
    messages.splice(0, messages.length, ...hydrated);
  }
  // 卡片正文和机器人确认回复不是讨论材料；扫描仍保留原生边界，避免破坏检查点。
  const isBot = (message: BotTopicMessage) => message.senderType === "app";
  const cards = new Set(
    messages
      .filter((message) => isBot(message) && message.controlCard === true)
      .map((message) => message.id),
  );
  return {
    messages: messages.filter(
      (message) =>
        !cards.has(message.id) &&
        !(isBot(message) && message.parentId && cards.has(message.parentId)),
    ),
    checkpoint: request.messageId,
    hasGap,
  };
}
