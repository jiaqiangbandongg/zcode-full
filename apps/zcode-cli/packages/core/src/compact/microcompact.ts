import {
  MicrocompactStrategy,
  MicrocompactTrigger,
  modelMessageContentToText,
  type MicrocompactBoundaryPayload,
  type ModelMessageContent,
  type ToolCallId,
} from "@zcode/contracts";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens } from "./manual.js";

export const MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX =
  "[Old tool result content cleared]";
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE =
  "[Old tool result content cleared]";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
export const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = [
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "ApplyPatch",
] as const;

export interface LocalMicrocompactPolicyConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  idleThresholdMinutes?: number;
  keepRecentToolResults?: number;
  compactableToolNames?: readonly string[];
  clearErrorResults?: boolean;
  minTokenSavings?: number;
}

export interface LocalMicrocompactMessage extends CompactModelMessage {
  isError?: boolean;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

export type LocalMicrocompactBoundaryPayload = Omit<
  MicrocompactBoundaryPayload,
  "traceId" | "turnId"
>;

export interface LocalMicrocompactDecision {
  estimatedTokenCount: number;
  reason:
    | "disabled"
    | "not_triggered"
    | "no_candidates"
    | "nothing_to_clear"
    | "below_min_savings"
    | "applied";
  thresholdTokens?: number;
  trigger?: MicrocompactTrigger;
}

export interface LocalMicrocompactResult<T extends LocalMicrocompactMessage> {
  decision: LocalMicrocompactDecision;
  messages: T[];
  payload?: LocalMicrocompactBoundaryPayload;
}

interface ToolResultCandidate {
  index: number;
  toolCallId: string;
}

export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  const ratioThreshold = Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  const bufferThreshold = autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS;
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold));
}

export function maybeLocalMicrocompactMessages<T extends LocalMicrocompactMessage>(input: {
  config?: LocalMicrocompactPolicyConfig;
  lastAssistantCompletedAtMs?: number;
  messages: readonly T[];
  nowMs?: number;
}): LocalMicrocompactResult<T> {
  const config = input.config ?? {};
  const messages = input.messages.map(cloneLocalMicrocompactMessage);
  const estimatedTokenCount = estimateMessageTokens(messages);
  const thresholdTokens = positiveInt(config.thresholdTokens);

  if (config.enabled === false) {
    return {
      decision: { estimatedTokenCount, reason: "disabled", thresholdTokens },
      messages,
    };
  }

  const trigger = resolveMicrocompactTrigger({
    config,
    estimatedTokenCount,
    lastAssistantCompletedAtMs: input.lastAssistantCompletedAtMs,
    nowMs: input.nowMs,
    thresholdTokens,
  });
  if (!trigger) {
    return {
      decision: { estimatedTokenCount, reason: "not_triggered", thresholdTokens },
      messages,
    };
  }

  const candidateGroups = collectCompactableToolResultGroups(messages, config);
  if (candidateGroups.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "no_candidates", thresholdTokens, trigger },
      messages,
    };
  }

  const keepCount =
    positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS;
  const boundedKeepCount = Math.max(1, keepCount);
  const clearGroupCount = Math.max(0, candidateGroups.length - boundedKeepCount);
  if (clearGroupCount === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages,
    };
  }

  const toClear = candidateGroups.slice(0, clearGroupCount).flat();
  const toKeep = candidateGroups.slice(clearGroupCount).flat();
  for (const candidate of toClear) {
    const message = messages[candidate.index];
    if (!message) continue;
    messages[candidate.index] = {
      ...message,
      content: buildClearedToolResultContent(),
    };
  }

  const postTokenCount = estimateMessageTokens(messages);
  const tokensSaved = Math.max(0, estimatedTokenCount - postTokenCount);
  const minSavings =
    positiveInt(config.minTokenSavings) ?? DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS;
  if (tokensSaved < minSavings) {
    return {
      decision: { estimatedTokenCount, reason: "below_min_savings", thresholdTokens, trigger },
      messages: input.messages.map(cloneLocalMicrocompactMessage),
    };
  }

  return {
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger },
    messages,
    payload: {
      clearedMessageCount: toClear.length,
      clearedToolCallIds: toClear.map((candidate) => candidate.toolCallId as ToolCallId),
      keptToolCallIds: toKeep.map((candidate) => candidate.toolCallId as ToolCallId),
      postMicrocompactTokenCount: postTokenCount,
      preMicrocompactTokenCount: estimatedTokenCount,
      strategy: MicrocompactStrategy.LocalToolResultClear,
      tokensSaved,
      trigger,
    },
  };
}

function resolveMicrocompactTrigger(input: {
  config: LocalMicrocompactPolicyConfig;
  estimatedTokenCount: number;
  lastAssistantCompletedAtMs?: number;
  nowMs?: number;
  thresholdTokens?: number;
}): MicrocompactTrigger | undefined {
  const idleThresholdMinutes =
    positiveInt(input.config.idleThresholdMinutes) ??
    DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES;
  if (
    input.lastAssistantCompletedAtMs !== undefined &&
    Number.isFinite(input.lastAssistantCompletedAtMs)
  ) {
    const elapsedMs = (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs;
    if (elapsedMs > idleThresholdMinutes * 60_000) {
      return MicrocompactTrigger.TimeBased;
    }
  }

  if (input.thresholdTokens !== undefined && input.estimatedTokenCount >= input.thresholdTokens) {
    return MicrocompactTrigger.TokenPressure;
  }

  return undefined;
}

function collectCompactableToolResultGroups<T extends LocalMicrocompactMessage>(
  messages: readonly T[],
  config: LocalMicrocompactPolicyConfig,
): ToolResultCandidate[][] {
  const compactableTools = new Set(
    config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS,
  );
  const clearErrorResults = config.clearErrorResults === true;
  const groups: ToolResultCandidate[][] = [];
  let currentGroup: ToolResultCandidate[] | undefined;

  const flushCurrentGroup = (): void => {
    if (currentGroup && currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = undefined;
  };

  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      flushCurrentGroup();
      currentGroup = [];
      return;
    }

    if (message.role !== "tool") return;
    if (!message.toolCallId || !message.toolName) return;
    if (!compactableTools.has(message.toolName)) return;
    if (message.isError && !clearErrorResults) return;
    if (isMicrocompactClearedToolResultContent(message.content)) return;
    if (hasMediaToolResultContent(message.content)) return;

    if (!currentGroup) {
      groups.push([{ index, toolCallId: message.toolCallId }]);
      return;
    }

    currentGroup.push({ index, toolCallId: message.toolCallId });
  });

  flushCurrentGroup();
  return groups;
}

function buildClearedToolResultContent(): ModelMessageContent {
  return MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
}

function isMicrocompactClearedToolResultContent(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content) === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
}

function hasMediaToolResultContent(content: ModelMessageContent): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    // video 与 image/file 同为受保护媒体：Read 视频结果漏判会被 microcompact 清掉。
    return block.type === "image" || block.type === "video" || block.type === "file";
  });
}

function cloneLocalMicrocompactMessage<T extends LocalMicrocompactMessage>(message: T): T {
  return {
    ...message,
    content: cloneContent(message.content),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  };
}

function cloneContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if ("source" in block && block.source) {
      return { ...block, source: { ...block.source } };
    }
    if ("providerOptions" in block && block.providerOptions) {
      return { ...block, providerOptions: { ...block.providerOptions } };
    }
    return { ...block };
  }) as ModelMessageContent;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
