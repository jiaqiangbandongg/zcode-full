import type {
  BotConfig,
  BotInboundAttachment,
  BotsConfigFile,
  BotsStateFile,
  ZCodeProtocolTrace,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

export interface TopicResourceRequest {
  taskId: string;
  inputId: string;
  messageId: string;
  authorizationId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  resourceIndex?: number;
  signal?: AbortSignal;
  trace?: ZCodeProtocolTrace;
  remoteSessionId?: string;
}

export interface TopicResourceMessage {
  messageId: string;
  chatId: string;
  threadId: string;
  deleted?: boolean;
  attachments: BotInboundAttachment[];
}

export interface TopicResourceDependencies {
  readState(): Promise<BotsStateFile>;
  readConfig(): Promise<BotsConfigFile>;
  readMessage(
    bot: BotConfig,
    target: { messageId: string; chatId: string; threadId: string },
    signal?: AbortSignal,
  ): Promise<TopicResourceMessage>;
  download(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    target: { messageId: string; chatId: string; threadId: string },
    signal?: AbortSignal,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array }>;
}

/** 历史附件此前只有文字占位；下载必须从已接收输入反查身份，不能相信模型提供的群信息。 */
export async function readAuthorizedTopicResource(
  request: TopicResourceRequest,
  deps: TopicResourceDependencies,
): Promise<{ attachment: BotInboundAttachment; data: Uint8Array }> {
  const authorize = () => authorizeTopicResource(request, deps);

  const initial = await authorize();
  const native = await deps.readMessage(initial.bot, initial.target, request.signal);
  if (
    native.messageId !== initial.target.messageId ||
    native.chatId !== initial.target.chatId ||
    native.threadId !== initial.target.threadId ||
    native.deleted
  )
    throw new Error("Topic resource native scope mismatch");
  const index = request.resourceIndex ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || !native.attachments[index])
    throw new Error("Topic resource index unavailable");
  const check = async () => {
    // 停用、换绑及历史开关可能在 I/O 期间变化，旧请求不能在下载后继续暴露内容。
    if ((await authorize()).identity !== initial.identity)
      throw new Error("Topic resource authorization changed");
  };
  await check();
  const result = await deps.download(
    initial.bot,
    native.attachments[index]!,
    initial.target,
    request.signal,
  );
  await check();
  if (result.data.byteLength > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
    throw new Error("Topic resource exceeds attachment size limit");
  return result;
}

export async function authorizeTopicResource(
  request: TopicResourceRequest,
  deps: Pick<TopicResourceDependencies, "readState" | "readConfig">,
) {
  request.signal?.throwIfAborted();
  const [state, config] = await Promise.all([deps.readState(), deps.readConfig()]);
  const matches = Object.values(state.bots).filter((context) => {
    const input = context.group?.inputs?.[request.inputId];
    return (
      context.activeTaskId === request.taskId &&
      input?.taskId === request.taskId &&
      input.admission === "accepted" &&
      (context.workspaceIdentity?.trim() || context.workspacePath) ===
        (request.workspaceIdentity?.trim() || request.workspacePath)
    );
  });
  if (matches.length !== 1) throw new Error("Topic resource task scope unavailable");
  const context = matches[0]!;
  const group = context.group!;
  const source = group.inputs![request.inputId]!.source;
  const bot = config.bots.find((candidate) => candidate.id === context.botId);
  const parents = Object.values(state.bots).filter(
    (candidate) =>
      candidate.botId === context.botId &&
      candidate.group?.chatId === group.chatId &&
      !candidate.group.threadId,
  );
  const parent = parents.length === 1 ? parents[0]!.group : undefined;
  if (
    !bot?.enabled ||
    (bot.provider !== "feishu" && bot.provider !== "lark") ||
    !group.enabled ||
    !parent?.enabled ||
    parent.historyEnabled === false ||
    !request.authorizationId ||
    group.authorizationId !== request.authorizationId ||
    parent.authorizationId !== request.authorizationId ||
    group.ownerId !== bot.providerUserId ||
    parent.ownerId !== bot.providerUserId ||
    source.botId !== bot.id ||
    source.authorizationId !== request.authorizationId ||
    source.provider !== bot.provider ||
    source.chatId !== group.chatId ||
    !source.threadId ||
    (group.threadId && source.threadId !== group.threadId)
  )
    throw new Error("Topic resource authorization unavailable");

  const archived = Object.values(group.inputs ?? {}).some(
    (input) =>
      input.admission === "accepted" &&
      input.taskId === request.taskId &&
      input.source.botId === bot.id &&
      input.source.chatId === group.chatId &&
      input.source.threadId === source.threadId &&
      input.source.topicContext?.messages.some(
        (record) =>
          record.id === request.messageId &&
          record.chatId === group.chatId &&
          record.threadId === source.threadId &&
          !record.deleted &&
          ["file", "image", "post"].includes(record.kind),
      ),
  );
  if (!archived) throw new Error("Topic resource is not in this task's admitted archive");
  return {
    bot,
    target: { messageId: request.messageId, chatId: group.chatId, threadId: source.threadId },
    identity: JSON.stringify([
      bot.id,
      bot.provider,
      bot.providerUserId,
      bot.credentialRef,
      bot.feishuAppId,
      group.chatId,
      source.threadId,
      group.authorizationId,
    ]),
  };
}
