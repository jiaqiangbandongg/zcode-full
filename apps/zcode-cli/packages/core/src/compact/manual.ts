import { CompactTrigger } from "@zcode/contracts";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactPreservedSegment,
  CompactReason,
  CompactTrigger as CompactTriggerValue,
  MessageId,
  ModelMessageContent,
  TraceContext,
} from "@zcode/contracts";
import { modelMessageContentBlockToText, modelMessageContentToText } from "@zcode/contracts";
import { groupByAssistantStartedRounds } from "./rounds.js";

const EMPTY_TOOL_CALL_INPUT_JSON = "{}";

export interface CompactModelMessage {
  role: string;
  content: ModelMessageContent;
  toolCalls?: readonly {
    name: string;
    input: unknown;
  }[];
}

export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface BuildManualCompactBoundaryInput {
  preCompactDiscoveredTools?: string[];
  autoCompactThreshold?: number;
  boundaryId: string;
  compactReason?: CompactReason;
  customInstructions?: string;
  keptMessageCount?: number;
  lastSummarizedMessageId?: MessageId;
  phase?: CompactPhase;
  postCompactTokenCount?: number;
  preservedSegment?: CompactPreservedSegment;
  preCompactTokenCount: number;
  summarizedMessageCount: number;
  summaryMessageId: MessageId;
  traceContext: TraceContext;
  trigger?: CompactTriggerValue;
  truePostCompactTokenCount?: number;
  willRetriggerNextTurn?: boolean;
}

export const MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3;
export const COMPACT_PROMPT_TOO_LONG_RETRY_MARKER =
  "[earlier conversation truncated for compaction retry]";
export const COMPACT_PROMPT_TOO_LONG_USER_MESSAGE =
  "Conversation too long to compact automatically. Try /compact again after narrowing the active context.";

export function getMessagesToSummarize(
  messages: readonly CompactModelMessage[],
): CompactModelMessage[] {
  return messages
    .filter((message) => !isContextPrefixMessage(message))
    .map((message) => ({ ...message }));
}

export function hasEnoughMessagesToCompact(messages: readonly CompactModelMessage[]): boolean {
  const messagesToSummarize = getMessagesToSummarize(messages);
  return (
    groupMessagesByCompactRound(messagesToSummarize).length >= 2 &&
    messagesToSummarize.some((message) => message.role === "assistant")
  );
}

export function buildManualCompactBoundary(
  input: BuildManualCompactBoundaryInput,
): CompactBoundaryPayload {
  return {
    boundaryId: input.boundaryId,
    ...(input.preCompactDiscoveredTools
      ? { preCompactDiscoveredTools: input.preCompactDiscoveredTools }
      : {}),
    trigger: input.trigger ?? CompactTrigger.Manual,
    phase: input.phase,
    compactReason: input.compactReason,
    summarySource: "model",
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount: input.truePostCompactTokenCount,
    autoCompactThreshold: input.autoCompactThreshold,
    willRetriggerNextTurn: input.willRetriggerNextTurn,
    summarizedMessageCount: input.summarizedMessageCount,
    keptMessageCount: input.keptMessageCount ?? 0,
    lastSummarizedMessageId: input.lastSummarizedMessageId,
    preservedSegment: input.preservedSegment,
    summaryMessageIds: [input.summaryMessageId],
    customInstructions: input.customInstructions !== undefined,
    traceId: input.traceContext.traceId,
    turnId: input.traceContext.turnId,
  };
}

export function estimateMessageTokens(messages: readonly CompactModelMessage[]): number {
  return messages.reduce((total, message) => {
    let estimatedCharacterCount = modelMessageContentToTokenEstimateText(message.content).length;
    // assistant toolCalls 独立保存在 content 之外，旧估算只读取 content，
    // 大型工具入参会被完整发给 provider，却在 auto compact 和 preflight 中计为 0。
    for (const toolCall of message.toolCalls ?? []) {
      estimatedCharacterCount += (
        toolCall.name + stringifyToolCallInputForTokenEstimate(toolCall.input)
      ).length;
    }
    return total + Math.ceil(estimatedCharacterCount / ESTIMATED_TOKEN_CHAR_DIVISOR);
  }, 0);
}

function stringifyToolCallInputForTokenEstimate(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? EMPTY_TOOL_CALL_INPUT_JSON;
  } catch {
    // tool_use 解析失败时降级为空对象的 JSON 表示，供 estimator 估算。
    // ZCode 的模型输入仍可能包含未知内容；异常输入不能让本地预算估算中断 compact。
    return EMPTY_TOOL_CALL_INPUT_JSON;
  }
}

function modelMessageContentToTokenEstimateText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  // modelMessageContentToText 是“可见正文”投影，会有意隐藏 reasoning；
  // compact fallback 却把它当作 provider 上下文体积，导致无 usage anchor 时 reasoning 全部计 0。
  // token 估算使用独立投影，避免改变正文、memory、错误文案等既有消费者的语义。
  return content
    .map((block) =>
      block.type === "reasoning" ? block.text : modelMessageContentBlockToText(block),
    )
    .filter(Boolean)
    .join("\n\n");
}

function isContextPrefixMessage<T extends CompactModelMessage>(message: T): boolean {
  return (
    message.role === "system" ||
    (message.role === "user" &&
      modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>"))
  );
}

function groupMessagesByCompactRound<T extends CompactModelMessage>(messages: readonly T[]): T[][] {
  return groupByAssistantStartedRounds(messages, (message) => message.role);
}

export function getUsageTotalTokens(usage?: TokenUsageLike): number {
  const inputTokens =
    usage?.inputTokens ?? (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  return usage?.totalTokens ?? inputTokens + (usage?.outputTokens ?? 0);
}

export function createCompactBoundaryId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return `compact_${randomUUID()}`;
}
