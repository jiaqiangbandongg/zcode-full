import type { BotActor, BotOutboundMessage } from "@zcode/shared";

/** 仅由服务明确识别的配置/连接错误升级，不能扫描模型输出猜测管理员待办。 */
export class BotAdminRequiredError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** 保留准备阶段的结构化提示，避免话题续接把收件人丢成纯文本。 */
export class BotReplyError extends Error {
  constructor(public readonly replies: BotOutboundMessage[]) {
    super(replies.map((reply) => reply.text).join("\n"));
  }
}

/** 通知去重不参与任务接收、授权或执行；重启后允许重新提醒。 */
export function createGroupAdminAttention() {
  const sent = new Map<string, true>();
  const scope = (actor: BotActor, owner: string) =>
    JSON.stringify([actor.botId, actor.chatId, actor.threadId, owner]);
  return {
    mention(actor: BotActor, owner: string | undefined, reason: string): string[] | undefined {
      if (actor.chatType !== "group" || !actor.chatId || !owner) return undefined;
      const key = `${scope(actor, owner)}:${reason}`;
      if (sent.has(key)) return [];
      sent.set(key, true);
      if (sent.size > 1000) sent.delete(sent.keys().next().value!);
      return [owner];
    },
    clear(actor?: BotActor, owner?: string, reason?: string) {
      if (!actor) {
        sent.clear();
        return;
      }
      if (!owner) return;
      const prefix = `${scope(actor, owner)}:`;
      for (const key of sent.keys()) {
        if (
          reason
            ? key === `${prefix}${reason}`
            : key.startsWith(prefix) &&
              !key.slice(prefix.length).startsWith("permission:") &&
              !key.slice(prefix.length).startsWith("plan:")
        )
          sent.delete(key);
      }
    },
  };
}
