import { requestVerificationDiagnostics } from "@zcode/shared";
import { CoreErrorType, ModelErrorCode, createCoreError, isCoreError } from "../deps.js";
import type { ModelUsage } from "../deps.js";
import { isPlainRecord, stringProperty } from "./data.js";
import {
  createCoreErrorFromProviderBusinessLike,
  findProviderBusinessFailureInMetadata,
} from "./provider-business-error.js";

export function readRawFinishReason(
  providerMetadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!providerMetadata) return undefined;
  const direct = providerMetadata.rawFinishReason;
  return typeof direct === "string" ? direct : undefined;
}

export function isContextExceededFinishReason(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
): boolean {
  return (
    isModelContextExceededMarker(finishReason) || isModelContextExceededMarker(rawFinishReason)
  );
}

export function createModelContextExceededFinishError(input: {
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
}) {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    {
      context: {
        finishReason: input.finishReason,
        rawFinishReason: input.rawFinishReason,
      },
      recoverable: true,
      retryable: true,
    },
  );
}

export function createCompactRapidRefillError(input: {
  consecutiveRapidRefills: number;
  maxConsecutiveRapidRefills: number;
  toolTurnThreshold: number;
  toolTurnsSinceCompact: number;
}) {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    `Autocompact stopped because the context refilled within fewer than ${input.toolTurnThreshold} tool turns after compaction ${input.maxConsecutiveRapidRefills} times in a row. A file or tool output may be too large. Read it in smaller chunks, or start a new session.`,
    {
      context: {
        consecutiveRapidRefills: input.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: input.maxConsecutiveRapidRefills,
        reason: "compact_rapid_refill_breaker",
        toolTurnsSinceCompact: input.toolTurnsSinceCompact,
        toolTurnThreshold: input.toolTurnThreshold,
      },
      recoverable: true,
      retryable: true,
    },
  );
}

export function isSuspiciousEmptyModelResult(
  finishReason: string | undefined,
  responseLength: number,
  toolCallCount: number,
  usage?: ModelUsage,
): boolean {
  return (
    responseLength === 0 &&
    toolCallCount === 0 &&
    isNonStopFinish(finishReason) &&
    isZeroUsage(usage)
  );
}

const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

export function createSuspiciousEmptyModelResultError(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
  model?: { modelId: string; providerId: string },
) {
  return createCoreError(CoreErrorType.ModelError, SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE, {
    context: {
      finishReason,
      ...(model ? { modelId: model.modelId, providerId: model.providerId } : {}),
      rawFinishReason,
      // UI/turn-errors 需识别空 completion，才能展示中文文案与 Coding Plan 恢复动作。
      // 空响应不能只有展示标记，否则监控无法与 provider/SSE 类故障做结构化聚合。
      reason: "empty_model_response",
      source: "provider",
      suspiciousEmpty: true,
    },
    recoverable: true,
    retryable: true,
  });
}

/** 空流终态诊断：供 core/adapters 日志与 UI 错误归因对照。 */
export function buildSuspiciousEmptyDiagnostics(
  input: {
    finishReason: string | undefined;
    providerMetadata: Record<string, unknown> | undefined;
    rawFinishReason: string | undefined;
    outboundHeaderKeys?: string[];
  } & Record<string, unknown>,
): Record<string, unknown> {
  const businessFailure = findProviderBusinessFailureInMetadata(input.providerMetadata);
  return {
    finishReason: input.finishReason ?? null,
    rawFinishReason: input.rawFinishReason ?? null,
    outboundHeaderKeys: input.outboundHeaderKeys ?? [],
    ...requestVerificationDiagnostics(input),
    providerMetadataKeys: input.providerMetadata
      ? Object.keys(input.providerMetadata).slice(0, 20)
      : [],
    providerBusinessCodeFromMetadata: businessFailure?.providerCode ?? null,
    providerBusinessMessageFromMetadata: businessFailure?.message ?? null,
    responseBodySummaryFromMetadata: businessFailure?.responseBodySummary ?? null,
  };
}

export function finalizeSuspiciousEmptyModelResult(input: {
  finishReason: string | undefined;
  model: { modelId: string; providerId: string };
  providerMetadata: Record<string, unknown> | undefined;
  rawFinishReason: string | undefined;
}): void {
  const providerBusinessError = tryCreateProviderBusinessModelErrorFromMetadata(
    input.providerMetadata,
    input.model,
  );
  if (providerBusinessError) {
    throw providerBusinessError;
  }

  throw createSuspiciousEmptyModelResultError(
    input.finishReason,
    input.rawFinishReason,
    input.model,
  );
}

export function tryCreateProviderBusinessModelErrorFromMetadata(
  providerMetadata: Record<string, unknown> | undefined,
  model?: { modelId: string; providerId: string },
): ReturnType<typeof createCoreError> | undefined {
  const failure = findProviderBusinessFailureInMetadata(providerMetadata);
  if (!failure) {
    return undefined;
  }

  // adapter 偶发把 zcode-plan 业务错误落成空 finish + 零 usage，core 会先抛 suspicious empty。
  // 在 anomaly guard 前先从 providerMetadata 恢复 providerCode（如 3007），让 UI 能命中业务错误文案。
  return createCoreError(CoreErrorType.ModelError, failure.message, {
    context: {
      ...(model ? { modelId: model.modelId, providerId: model.providerId } : {}),
      ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
      source: "provider",
      ...(failure.responseBodySummary ? { responseBodySummary: failure.responseBodySummary } : {}),
    },
    recoverable: true,
    retryable: false,
  });
}

function isNonStopFinish(finishReason?: string): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

export function normalizeStreamError(error: unknown): Error {
  const providerBusinessError = createCoreErrorFromProviderBusinessLike(error);
  if (providerBusinessError) {
    return providerBusinessError;
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(
    typeof error === "string" ? error : (JSON.stringify(error) ?? "Model stream failed"),
  );
}

const MODEL_CONTEXT_EXCEEDED_MARKERS = new Set<string>([
  CoreErrorType.ModelContextExceeded,
  ModelErrorCode.ModelContextExceeded,
  "context_exceeded",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

const MODEL_MEDIA_TOO_LARGE_MARKERS = new Set<string>([
  "media_too_large",
  "media_payload_too_large",
  "image_too_large",
  "document_too_large",
]);

export function isModelContextExceededError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.ModelContextExceeded) {
      return true;
    }

    const record = current as Record<string, unknown>;
    if (
      isModelContextExceededMarker(stringProperty(record, "type")) ||
      isModelContextExceededMarker(stringProperty(record, "code")) ||
      isModelContextExceededMarker(stringProperty(record, "reason")) ||
      isModelContextExceededMarker(stringProperty(record, "stopReason")) ||
      isModelContextExceededMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isModelContextExceededMarker(stringProperty(context, "type")) ||
        isModelContextExceededMarker(stringProperty(context, "code")) ||
        isModelContextExceededMarker(stringProperty(context, "reason")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

export function isModelContextExceededMarker(value: string | undefined): boolean {
  return value !== undefined && MODEL_CONTEXT_EXCEEDED_MARKERS.has(value.trim().toLowerCase());
}

export function isModelMediaTooLargeError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (
      isModelMediaTooLargeMarker(stringProperty(record, "type")) ||
      isModelMediaTooLargeMarker(stringProperty(record, "code")) ||
      isModelMediaTooLargeMarker(stringProperty(record, "reason")) ||
      isModelMediaTooLargeMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isModelMediaTooLargeMarker(stringProperty(context, "type")) ||
        isModelMediaTooLargeMarker(stringProperty(context, "code")) ||
        isModelMediaTooLargeMarker(stringProperty(context, "reason")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

function isModelMediaTooLargeMarker(value: string | undefined): boolean {
  return value !== undefined && MODEL_MEDIA_TOO_LARGE_MARKERS.has(value.trim().toLowerCase());
}

function isModelContextExceededMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  return (
    (message.includes("context") && message.includes("exceed")) ||
    (message.includes("context") && message.includes("too long")) ||
    (message.includes("prompt") && message.includes("too long"))
  );
}

function isModelMediaTooLargeMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  return (
    (message.includes("media") || message.includes("image") || message.includes("document")) &&
    (message.includes("too large") || message.includes("exceed"))
  );
}
