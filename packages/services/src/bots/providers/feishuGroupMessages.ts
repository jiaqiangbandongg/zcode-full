import { channelContentText, type ChannelContentPart } from "@zcode/shared";
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// 接收事件用 bot，历史接口用 app；此前混用导致真实机器人事件在入口被丢弃。
export function isFeishuBotSender(senderType: string): boolean {
  return senderType === "bot" || senderType === "app";
}

/** 只接受真实 mention 身份，不能靠显示名或正文中的 @ 字样触发执行。 */
export function readGroupMessage(
  text: string,
  mentions: unknown,
  botOpenId: string,
  senderType: string,
  senderOpenId?: string,
): {
  text: string;
  commandText: string;
  mentionedBot: boolean;
  contentParts?: ChannelContentPart[];
} | null {
  // 机器人可参与已接入话题，但自身回声必须按可信 ID 过滤，不能使用显示名。
  if (!botOpenId || (senderType !== "user" && !isFeishuBotSender(senderType))) return null;
  if (isFeishuBotSender(senderType) && (!senderOpenId || senderOpenId === botOpenId)) return null;
  let mentioned = false;
  const tokens = new Map<string, ChannelContentPart>();
  for (const item of Array.isArray(mentions) ? mentions : []) {
    const mention = record(item);
    const id = record(mention?.id)?.open_id;
    const key = mention?.key;
    if (typeof key !== "string" || !key) continue;
    if (id === botOpenId) mentioned = true;
    if (typeof mention?.name === "string" || id === botOpenId) {
      if (typeof id === "string" && /^ou_[a-zA-Z0-9_-]+$/u.test(id))
        tokens.set(key, {
          type: "channelMention",
          refId: `m${tokens.size + 1}`,
          targetId: id,
          idType: "open_id",
          channel: "feishu",
          entityType: "unknown",
          name: typeof mention?.name === "string" && mention.name.trim() ? mention.name : id,
        });
      else tokens.set(key, { type: "text", text: `@${mention.name}` });
    }
  }
  text = text.trim();
  const contentParts: ChannelContentPart[] = [];
  while (text) {
    const next = [...tokens.keys()]
      .map((key) => ({ key, index: text.indexOf(key) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index || b.key.length - a.key.length)[0];
    if (!next) {
      contentParts.push({ type: "text", text });
      break;
    }
    if (next.index) contentParts.push({ type: "text", text: text.slice(0, next.index) });
    contentParts.push(tokens.get(next.key)!);
    text = text.slice(next.index + next.key.length);
  }
  while (contentParts[0]?.type === "text") {
    contentParts[0].text = contentParts[0].text.trimStart();
    if (contentParts[0].text) break;
    contentParts.shift();
  }
  while (contentParts.at(-1)?.type === "text") {
    const last = contentParts.at(-1)!;
    if (last.type !== "text") break;
    last.text = last.text.trimEnd();
    if (last.text) break;
    contentParts.pop();
  }
  // 自身 @ 是分工原文的一部分；只有命令副本可以剥离开头的唤醒标记。
  let commandStart = 0;
  while (commandStart < contentParts.length) {
    const part = contentParts[commandStart]!;
    if (
      (part.type === "text" && !part.text.trim()) ||
      (part.type === "channelMention" && part.targetId === botOpenId)
    )
      commandStart++;
    else break;
  }
  return {
    text: channelContentText(contentParts),
    commandText: channelContentText(contentParts.slice(commandStart)).trim(),
    mentionedBot: mentioned,
    ...(contentParts.some((part) => part.type === "channelMention") ? { contentParts } : {}),
  };
}

export function readGroupMentionText(
  text: string,
  mentions: unknown,
  botOpenId: string,
  senderType: string,
  senderOpenId?: string,
): string | null {
  // 引用准备也必须透传发送者身份，否则合法机器人被当作缺失身份过滤。
  const message = readGroupMessage(text, mentions, botOpenId, senderType, senderOpenId);
  return message?.mentionedBot ? message.text : null;
}

/** 只取卡片可见正文，不把按钮值和审批参数作为另一机器人的发言。 */
export function readGroupCardText(value: unknown): string {
  if (Array.isArray(value)) return value.map(readGroupCardText).filter(Boolean).join("\n");
  const item = record(value);
  if (!item) return "";
  const lines: string[] = [];
  for (const key of ["elements", "body", "header", "title", "text", "content"]) {
    const child = item[key];
    if (typeof child === "string" && (key === "text" || key === "content")) lines.push(child);
    else if (typeof child === "object") lines.push(readGroupCardText(child));
  }
  return lines.filter(Boolean).join("\n");
}

/** interactive 也是普通回复载体；只根据控件结构识别操作卡片，不能按消息类型全拦。 */
export function isGroupControlCard(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isGroupControlCard);
  const item = record(value);
  if (!item) return false;
  const tag = typeof item.tag === "string" ? item.tag : "";
  if (
    /^(?:button|action|form|input|select(?:_.*)?|multi_select(?:_.*)?|date_picker|time_picker|datetime_picker|picker|checker|overflow)$/u.test(
      tag,
    )
  )
    return true;
  return Object.entries(item).some(([key, child]) => key !== "value" && isGroupControlCard(child));
}

/** 卡片正文中的发送端 ID 可能与接收端不同，使用平台有序 mentions 恢复本端身份。 */
export function readGroupConversationCardText(value: unknown, mentions: unknown): string {
  const text = readGroupCardText(value);
  const native = Array.isArray(mentions)
    ? mentions.map(record).filter((item) => typeof item?.key === "string")
    : [];
  const nodes = [...text.matchAll(/<at\s+id=["']?([^\s>"']+)["']?[^>]*>[\s\S]*?<\/at>/gu)];
  let index = 0;
  return text.replace(
    /<at\s+id=["']?([^\s>"']+)["']?[^>]*>[\s\S]*?<\/at>/gu,
    (_node, id: string) => {
      const mention =
        native.find((item) => record(item?.id)?.open_id === id) ??
        (native.length === nodes.length ? native[index] : undefined);
      index++;
      return typeof mention?.key === "string" ? mention.key : "@unknown";
    },
  );
}
