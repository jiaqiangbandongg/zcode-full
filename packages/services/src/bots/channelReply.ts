import { resolveChannelMentionNames } from "#src/bots/channelMentionResolver.js";
import { createHash } from "node:crypto";
import {
  channelReplyHostRequestSchema,
  channelContentText,
  resolveChannelReplyParts,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
  type BotsStateFile,
  type BotsConfigFile,
  type BotConfig,
  type BotGroupDelivery,
} from "@zcode/shared";

interface ChannelReplyDependencies {
  readState(): Promise<BotsStateFile>;
  readConfig(): Promise<BotsConfigFile>;
  listMembers?(bot: BotConfig, chatId: string): Promise<Record<string, string>>;
  deliver(
    bot: BotConfig,
    chatId: string,
    threadId: string | undefined,
    result: BotGroupDelivery,
  ): Promise<void>;
}

async function readBinding(request: ChannelReplyHostRequest, deps: ChannelReplyDependencies) {
  const [state, config] = await Promise.all([deps.readState(), deps.readConfig()]);
  const matches = Object.entries(state.bots).filter(
    ([, context]) =>
      context.activeTaskId === request.taskId &&
      context.workspacePath === request.workspacePath &&
      (context.workspaceIdentity?.trim() || context.workspacePath) ===
        (request.workspaceIdentity?.trim() || request.workspacePath) &&
      Boolean(context.group),
  );
  if (matches.length !== 1)
    throw new Error(
      "Channel reply requires exactly one active task channel binding; do not retry without restoring the binding",
    );
  const [key, context] = matches[0]!;
  const group = context.group!;
  const bot = config.bots.find((candidate) => candidate.id === context.botId);
  if (
    !bot?.enabled ||
    !group.enabled ||
    group.ownerId !== bot.providerUserId ||
    !group.authorizationId ||
    (request.authorizationId !== undefined && group.authorizationId !== request.authorizationId) ||
    group.topicActive === false
  )
    throw new Error("Channel reply authorization changed");
  // 输入来源不是发送授权：从任务唯一绑定中解析可信目标，禁止拿另一任务/旧授权兜底。
  const nativeInputs = Object.entries(group.inputs ?? {}).filter(([, input]) => {
    const source = input.source;
    return (
      input.admission === "accepted" &&
      source.appId === bot.feishuAppId &&
      Boolean(source.appId) &&
      source.botId === bot.id &&
      source.provider === bot.provider &&
      source.chatId === group.chatId &&
      source.threadId === group.threadId &&
      source.authorizationId === group.authorizationId
    );
  });
  const eligible = nativeInputs.filter(
    ([, input]) =>
      input.taskId === request.taskId &&
      !["cancelled", "discarded", "stopped"].includes(input.progress?.status ?? ""),
  );
  // 原生身份不随任务切换失效；历史节点只作为名字候选，不能扩大当前发送 ref 的授权。
  const nameCandidates = nativeInputs.flatMap(
    ([, { source }]) =>
      source.messages?.flatMap((message) => message.contentParts ?? []) ??
      source.contentParts ??
      [],
  );
  const current = group.inputs?.[request.inputId];
  if (current && !eligible.some(([id]) => id === request.inputId))
    throw new Error("Channel reply execution input is no longer authorized");
  const anchor = eligible.find(([id]) => id === request.inputId) ?? eligible.at(-1);
  if (!anchor)
    throw new Error(
      "Channel reply has no valid native conversation context; do not retry unchanged",
    );
  const [sourceCommandId, { source }] = anchor;
  const trusted = eligible.flatMap(
    ([, { source }]) =>
      source.messages?.flatMap((message) => message.contentParts ?? []) ??
      source.contentParts ??
      [],
  );
  const scope = JSON.stringify([
    key,
    request.taskId,
    context.workspaceIdentity?.trim() || context.workspacePath,
    bot.id,
    bot.provider,
    bot.feishuAppId,
    bot.credentialRef,
    bot.providerUserId,
    group.authorizationId,
  ]);
  return { key, group, bot, source, sourceCommandId, trusted, nameCandidates, scope };
}

function receipt(saved: BotGroupDelivery | undefined, id: string): ChannelReplyResult {
  return {
    status:
      saved?.status === "sent" || saved?.status === "failed" || saved?.status === "invalidated"
        ? saved.status
        : "unknown",
    deliveryId: id,
    ...(saved?.providerMessageId ? { providerMessageId: saved.providerMessageId } : {}),
    ...(saved?.lastError ? { error: saved.lastError } : {}),
  };
}

export async function replyToBotChannel(
  value: ChannelReplyHostRequest,
  deps: ChannelReplyDependencies,
): Promise<ChannelReplyResult> {
  const request = channelReplyHostRequestSchema.parse(value);
  let binding = await readBinding(request, deps);
  const { bot } = binding;
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        "channel-reply",
        bot.id,
        request.taskId,
        request.inputId,
        request.toolCallId,
      ]),
    )
    .digest("hex");
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify(
        request.parts.map((part) =>
          part.type === "text"
            ? [part.type, part.text]
            : part.type === "mention"
              ? [part.type, part.refId]
              : [part.type, part.name, part.candidateRef ?? null],
        ),
      ),
    )
    .digest("hex");
  const replay = async (saved: BotGroupDelivery | undefined) => {
    if (!saved?.channelReplyRequestHash) return undefined;
    if (saved.channelReplyRequestHash !== requestHash)
      throw new Error("Channel reply idempotency conflict");
    // unknown 是崩溃恢复标记，不代表活跃发送已结束；复用投递 owner 等待，
    // 无活跃发送的持久记录由 owner 保持不重发，不能另建重试队列。
    if (saved.status !== "sent" && saved.status !== "invalidated") {
      await deps.deliver(bot, binding.group.chatId, binding.group.threadId, saved);
      saved = (await deps.readState()).bots[binding.key]?.group?.deliveries?.[id];
    }
    return receipt(saved, id);
  };
  const previous = await replay(binding.group.deliveries?.[id]);
  if (previous) return previous;
  let parts;
  if (request.parts.some((part) => part.type === "mentionName")) {
    if (bot.provider !== "feishu" && bot.provider !== "lark")
      throw new Error("Unsupported mention channel");
    let members: Record<string, string> | undefined;
    try {
      members = await deps.listMembers?.(bot, binding.group.chatId);
    } catch {
      /* 目录失败作为可解释的待澄清结果，不暴露不完整名单。 */
    }
    // 外部查询期间可能停用/换绑或停止执行；查询结果绝不能延续旧授权。
    const fresh = await readBinding(request, deps);
    if (
      fresh.scope !== binding.scope ||
      fresh.sourceCommandId !== binding.sourceCommandId ||
      fresh.source.messageId !== binding.source.messageId
    )
      throw new Error("Channel reply authorization changed during lookup");
    binding = fresh;
    const concurrent = await replay(binding.group.deliveries?.[id]);
    if (concurrent) return concurrent;
    const resolved = resolveChannelMentionNames(
      request.parts,
      binding.trusted,
      members,
      binding.scope,
      bot.provider,
      binding.nameCandidates,
    );
    if ("status" in resolved) return resolved;
    parts = resolved.parts;
  } else parts = resolveChannelReplyParts(request.parts, binding.trusted);
  if (parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider))
    throw new Error("Channel mention provider mismatch");
  if (!channelContentText(parts).trim() || channelContentText(parts).length > 2000)
    throw new Error("Channel reply must contain 1–2000 characters");
  const { group, source, sourceCommandId, key } = binding;
  const existing = group.deliveries?.[id];
  if (existing && JSON.stringify(existing.contentParts) !== JSON.stringify(parts))
    throw new Error("Channel reply idempotency conflict");
  await deps.deliver(bot, group.chatId, group.threadId, {
    id,
    channelReplyRequestHash: requestHash,
    appId: source.appId,
    trace: request.trace,
    authorizationId: group.authorizationId,
    taskId: request.taskId,
    sourceCommandId,
    text: channelContentText(parts),
    contentParts: parts,
    replyToMessageId: source.messageId,
    threadId: source.threadId,
    rootMessageId: source.rootMessageId,
    status: "pending",
    updatedAt: Date.now(),
  });
  const saved = (await deps.readState()).bots[key]?.group?.deliveries?.[id];
  if (saved && JSON.stringify(saved.contentParts) !== JSON.stringify(parts))
    throw new Error("Channel reply idempotency conflict");
  return receipt(saved, id);
}
