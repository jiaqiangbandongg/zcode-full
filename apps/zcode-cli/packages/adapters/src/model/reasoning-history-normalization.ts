import type {
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelId,
  ModelProviderId,
} from "@zcode/contracts";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { getStatusCode, unwrapRetryError } from "./failure-inspection.js";

const EMPTY_ASSISTANT_CONTENT_FALLBACK = "(no content)";
const REJECTED_REASONING_FALLBACK = "[Thinking removed]";

// 旧历史保留 builtin 身份，当前选型已迁到 account 身份；Individual/Team
// 也会使用不同 ID。只在 reasoning 回放时识别同服务的这些明确身份，不改变选型或鉴权。
// 不能复用套餐展示分组：Start/Off-Peak/API 接入不在这份签名兼容范围内。
const REASONING_PROVIDER_GROUPS: readonly (readonly string[])[] = [
  [
    "builtin:zai-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  ],
  [
    "builtin:bigmodel-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  ],
];

export function normalizeReasoningHistory(
  messages: ModelInputMessage[],
  targetModel?: { modelId: ModelId; providerId: ModelProviderId },
): ModelInputMessage[] {
  const compatibleHistory = removeCrossModelReasoning(messages, targetModel);
  const withoutOrphans = removeReasoningOnlyAssistants(compatibleHistory);
  const withoutTrailingReasoning = removeTrailingReasoning(withoutOrphans);
  const withoutWhitespaceOnlyAssistants = removeWhitespaceOnlyAssistants(withoutTrailingReasoning);
  return repairEmptyAssistantContent(withoutWhitespaceOnlyAssistants);
}

export function removeRejectedReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const filtered = filterReasoningBlocks(messages, isSignedOrRedactedReasoning);
  if (filtered === messages) return messages;

  const result = filtered.slice();
  for (let index = 0; index < filtered.length; index += 1) {
    if (filtered[index] === messages[index]) continue;

    const message = filtered[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    let content = message.content.filter(
      (block) => block.type !== "text" || block.text.trim().length > 0,
    );
    if (!hasToolCalls(message) && content.every((block) => block.type === "reasoning")) {
      content = [...content, { type: "text", text: REJECTED_REASONING_FALLBACK }];
    }
    result[index] = { ...message, content };
  }
  return result;
}

export function repairReasoningHistoryAfterSignatureRejection(
  projectedMessages: ModelInputMessage[],
  error: unknown,
): ModelInputMessage[] | undefined {
  if (!isThinkingSignatureRejection(error)) return undefined;

  // 调用方传入的已经是逻辑请求入口完成结构归一化后的副本。这里仅执行签名拒绝清理，
  // 不能再次运行结构 passes，否则会删除刚补出的 assistant 占位并改变轮次边界。
  const repaired = removeRejectedReasoning(projectedMessages);
  return repaired === projectedMessages ? undefined : repaired;
}

export function isThinkingSignatureRejection(error: unknown): boolean {
  const unwrapped = unwrapRetryError(error);
  if (getStatusCode(unwrapped) !== 400) return false;

  // Provider 没有为该 400 提供独立错误码；这里只匹配已确认的窄化文案，
  // 避免把其他 invalid_request 误当成可修改历史并重试。
  const message = errorMessage(unwrapped).toLowerCase();
  if (message.includes("signature in thinking block")) return true;

  const namesThinkingBlock =
    message.includes("thinking block") ||
    message.includes("`thinking`") ||
    message.includes("redacted_thinking");
  const namesSignatureFailure =
    message.includes("cannot be modified") || message.includes("invalid signature");
  return namesThinkingBlock && namesSignatureFailure;
}

function removeCrossModelReasoning(
  messages: ModelInputMessage[],
  targetModel: { modelId: ModelId; providerId: ModelProviderId } | undefined,
): ModelInputMessage[] {
  if (!targetModel) return messages;

  return filterReasoningBlocks(messages, (block, message) => {
    if (!message.providerId || !message.modelId) return false;
    if (
      message.modelId === targetModel.modelId &&
      areReasoningProvidersCompatible(message.providerId, targetModel.providerId)
    ) {
      return false;
    }
    return isSignedOrRedactedReasoning(block);
  });
}

function areReasoningProvidersCompatible(
  source: ModelProviderId,
  target: ModelProviderId,
): boolean {
  return (
    source === target ||
    REASONING_PROVIDER_GROUPS.some((group) => group.includes(source) && group.includes(target))
  );
}

function filterReasoningBlocks(
  messages: ModelInputMessage[],
  shouldRemove: (block: ModelReasoningContentBlock, message: ModelInputMessage) => boolean,
): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const content = message.content.filter(
      (block) => block.type !== "reasoning" || !shouldRemove(block, message),
    );
    if (content.length === message.content.length) continue;

    result ??= messages.slice();
    // 此处只过滤 reasoning block，保留消息顺序与结构；结构修复由独立阶段处理。
    result[index] = { ...message, content };
  }

  return result ?? messages;
}

function removeReasoningOnlyAssistants(messages: ModelInputMessage[]): ModelInputMessage[] {
  const result = messages.filter((message) => {
    if (message.role !== "assistant" || hasToolCalls(message)) return true;
    if (!Array.isArray(message.content) || message.content.length === 0) return true;
    return !message.content.every((block) => block.type === "reasoning");
  });
  return result.length === messages.length ? messages : result;
}

function removeTrailingReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return messages;

  let end = last.content.length;
  while (end > 0 && last.content[end - 1]?.type === "reasoning") {
    end -= 1;
  }
  if (end === last.content.length) return messages;

  const result = messages.slice();
  result[result.length - 1] = {
    ...last,
    content: last.content.slice(0, end),
  };
  return result;
}

function removeWhitespaceOnlyAssistants(messages: ModelInputMessage[]): ModelInputMessage[] {
  const filtered = messages.filter((message) => {
    if (message.role !== "assistant" || hasToolCalls(message)) return true;
    if (!Array.isArray(message.content) || message.content.length === 0) return true;
    return !message.content.every(
      (block) =>
        block.type === "text" &&
        (block.text.trim().length === 0 || block.text.trim() === EMPTY_ASSISTANT_CONTENT_FALLBACK),
    );
  });
  if (filtered.length === messages.length) return messages;
  return mergeAdjacentUserMessages(filtered);
}

function repairEmptyAssistantContent(messages: ModelInputMessage[]): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      message.content.length > 0 ||
      hasToolCalls(message)
    ) {
      continue;
    }

    result ??= messages.slice();
    result[index] = {
      ...message,
      content: [{ type: "text", text: EMPTY_ASSISTANT_CONTENT_FALLBACK }],
    };
  }

  return result ?? messages;
}

function mergeAdjacentUserMessages(messages: ModelInputMessage[]): ModelInputMessage[] {
  const result: ModelInputMessage[] = [];

  for (const message of messages) {
    const previous = result.at(-1);
    if (!canMergeAdjacentUserMessages(previous, message)) {
      result.push(message);
      continue;
    }

    const merged: ModelInputMessage = {
      role: "user",
      content: mergeUserContent(previous.content, message.content),
    };
    const cacheControl = message.cacheControl ?? previous.cacheControl;
    if (cacheControl) merged.cacheControl = { ...cacheControl };
    result[result.length - 1] = merged;
  }

  return result;
}

function canMergeAdjacentUserMessages(
  previous: ModelInputMessage | undefined,
  next: ModelInputMessage,
): previous is ModelInputMessage & { role: "user" } {
  if (previous?.role !== "user" || next.role !== "user") return false;
  return !isToolResultUserMessage(previous) && !isToolResultUserMessage(next);
}

function isToolResultUserMessage(message: ModelInputMessage): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}

function mergeUserContent(
  previous: ModelMessageContent,
  next: ModelMessageContent,
): ModelMessageContentBlock[] {
  const previousBlocks = contentAsBlocks(previous);
  const nextBlocks = contentAsBlocks(next);
  const previousLast = previousBlocks.at(-1);
  const nextFirst = nextBlocks[0];

  if (previousLast?.type === "text" && nextFirst?.type === "text") {
    previousBlocks[previousBlocks.length - 1] = {
      ...previousLast,
      text: `${previousLast.text}\n`,
    };
  }

  return [...previousBlocks, ...nextBlocks];
}

function contentAsBlocks(content: ModelMessageContent): ModelMessageContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function isSignedOrRedactedReasoning(block: ModelReasoningContentBlock): boolean {
  const anthropic = anthropicOptions(block.providerOptions);
  return (
    (typeof anthropic.signature === "string" && anthropic.signature.length > 0) ||
    typeof anthropic.redactedData === "string"
  );
}

function hasToolCalls(message: ModelInputMessage): boolean {
  return (message.toolCalls?.length ?? 0) > 0;
}

function anthropicOptions(providerOptions: unknown): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return {};
  }
  const anthropic = (providerOptions as Record<string, unknown>).anthropic;
  return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? (anthropic as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}
