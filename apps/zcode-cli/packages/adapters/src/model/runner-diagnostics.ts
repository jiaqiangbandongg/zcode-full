import { summarizeRequestVerificationHeaders } from "@zcode/shared";
import type { LanguageModelUsage } from "ai";
import type { Logger, ModelUsage } from "@zcode/contracts";
import { ModelFailureReason as ModelFailureReasonValue } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { normalizeUsage } from "./runner-normalization.js";
import { asRecord, stringProperty } from "./runner-record.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";

type GenerateTextResultWithMetadata = AiSdkGenerateTextResult & {
  request?: { body?: unknown };
  response?: {
    body?: unknown;
    headers?: Record<string, string>;
    id?: string;
    messages?: unknown[];
    modelId?: string;
    timestamp?: Date;
  };
  steps?: unknown[];
};

interface StreamDiagnostics {
  chunkCounts: Record<string, number>;
  errorChunkCount: number;
  finishReason?: string;
  lastChunkType?: string;
  lastErrorChunk?: unknown;
  lastFinishChunk?: unknown;
  rawFinishReason?: unknown;
  reasoningDeltaChars: number;
  textDeltaChars: number;
  toolCallCount: number;
  usage?: ModelUsage;
}

export function createStreamDiagnostics(): StreamDiagnostics {
  return {
    chunkCounts: {},
    errorChunkCount: 0,
    reasoningDeltaChars: 0,
    textDeltaChars: 0,
    toolCallCount: 0,
  };
}

export function recordStreamChunkDiagnostic(diagnostics: StreamDiagnostics, chunk: unknown): void {
  const record = asRecord(chunk);
  const chunkType = stringProperty(record, "type") ?? typeof chunk;
  diagnostics.lastChunkType = chunkType;
  diagnostics.chunkCounts[chunkType] = (diagnostics.chunkCounts[chunkType] ?? 0) + 1;

  if (chunkType === "text-delta") {
    diagnostics.textDeltaChars += stringProperty(record, "text")?.length ?? 0;
    return;
  }

  if (chunkType === "reasoning-delta") {
    diagnostics.reasoningDeltaChars += stringProperty(record, "text")?.length ?? 0;
    return;
  }

  if (chunkType === "tool-call") {
    diagnostics.toolCallCount += 1;
    return;
  }

  if (chunkType === "finish") {
    diagnostics.finishReason = stringProperty(record, "finishReason") ?? diagnostics.finishReason;
    diagnostics.rawFinishReason = record.rawFinishReason;
    diagnostics.lastFinishChunk = chunk;
    diagnostics.usage = normalizeUsage(
      (record.totalUsage ?? record.usage) as Partial<LanguageModelUsage> | undefined,
    );
    return;
  }

  if (chunkType === "error") {
    diagnostics.errorChunkCount += 1;
    diagnostics.lastErrorChunk = chunk;
  }
}

export function getGenerateTextResultMetadata(
  result?: AiSdkGenerateTextResult,
): GenerateTextResultWithMetadata | undefined {
  return result as GenerateTextResultWithMetadata | undefined;
}

export function logGenerateTextDiagnostics(input: {
  attempt: number;
  completedAt: number;
  logger?: Logger;
  result: AiSdkGenerateTextResult;
  startedAt: number;
  statusContext: ModelStatusContext;
  toolCallCount: number;
  usage: ModelUsage;
}): void {
  const resultWithMetadata = getGenerateTextResultMetadata(input.result);
  const textLength = input.result.text.length;
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    durationMs: input.completedAt - input.startedAt,
    event: "model.sdk.generate.completed",
    finishReason: input.result.finishReason,
    module: "adapters.model",
    providerMetadataKeys: objectKeys(input.result.providerMetadata),
    responseBody: summarizeProviderBody(resultWithMetadata?.response?.body),
    responseId: resultWithMetadata?.response?.id,
    status: "completed" as const,
    textLength,
    toolCallCount: input.toolCallCount,
    usage: summarizeModelUsage(input.usage),
  };

  input.logger?.info("AI SDK generateText resolved", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: input.result.finishReason,
      textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  ) {
    input.logger?.warn("AI SDK generateText returned an empty non-stop result", {
      ...context,
      event: "model.sdk.generate.suspicious_empty",
    });
  }
}

export function summarizeFinishChunkForDiagnostics(
  chunk: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(chunk);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  const response = asRecord(record.response);
  const providerMetadata = asRecord(record.providerMetadata);
  return {
    chunkKeys: objectKeys(record),
    finishReason: summarizeScalar(record.finishReason),
    rawFinishReason: summarizeScalar(record.rawFinishReason),
    providerMetadataKeys: objectKeys(providerMetadata),
    responseBody: summarizeProviderBody(response?.body ?? record.body),
    responseStatus: summarizeScalar(response?.status),
  };
}

function summarizeOutboundModelHeaders(
  headers: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!headers) {
    return { outboundHeaderKeys: [] };
  }

  return {
    outboundHeaderKeys: Object.keys(headers),
    ...summarizeRequestVerificationHeaders(headers),
  };
}

function summarizeFinishChunkBusinessScan(input: {
  providerId: string;
  providerKind?: string;
  diagnostics: StreamDiagnostics;
}): Record<string, unknown> {
  const finishSource =
    input.diagnostics.lastFinishChunk ??
    ({
      type: "finish",
      finishReason: input.diagnostics.finishReason,
      rawFinishReason: input.diagnostics.rawFinishReason,
    } satisfies Record<string, unknown>);

  const finishBusinessError = detectProviderBusinessFinishError({
    providerId: input.providerId,
    providerKind: input.providerKind,
    source: finishSource,
  });

  return {
    finishBusinessErrorCode: finishBusinessError?.providerCode ?? null,
    finishBusinessErrorMessage: finishBusinessError?.providerMessage ?? null,
    finishChunk: summarizeFinishChunkForDiagnostics(input.diagnostics.lastFinishChunk),
    finishChunkPreview: summarizeRawFinishChunkPreview(input.diagnostics.lastFinishChunk),
    lastErrorChunk: summarizeFinishChunkForDiagnostics(input.diagnostics.lastErrorChunk),
  };
}

function summarizeRawFinishChunkPreview(chunk: unknown): Record<string, unknown> | undefined {
  if (chunk === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(chunk);
    if (serialized.length <= 2_048) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
    return {
      truncated: true,
      preview: serialized.slice(0, 2_048),
    };
  } catch {
    return summarizeFinishChunkForDiagnostics(chunk);
  }
}

export function logStreamDiagnostics(input: {
  attempt: number;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  logger?: Logger;
  outboundHeaders?: Record<string, string>;
  statusContext: ModelStatusContext;
}): void {
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    event: "model.sdk.stream.completed",
    errorChunkCount: input.diagnostics.errorChunkCount,
    finishReason: input.diagnostics.finishReason,
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    rawFinishReason: summarizeScalar(input.diagnostics.rawFinishReason),
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    status: "completed" as const,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    usage: summarizeModelUsage(input.diagnostics.usage),
  };

  input.logger?.info("AI SDK stream completed", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: input.diagnostics.finishReason,
      textLength: input.diagnostics.textDeltaChars,
      toolCallCount: input.diagnostics.toolCallCount,
      usage: input.diagnostics.usage,
    })
  ) {
    input.logger?.warn("AI SDK stream returned an empty non-stop result", {
      ...context,
      event: "model.sdk.stream.suspicious_empty",
      ...summarizeOutboundModelHeaders(input.outboundHeaders),
      ...summarizeFinishChunkBusinessScan({
        providerId: String(input.statusContext.providerId),
        providerKind: input.statusContext.providerKind,
        diagnostics: input.diagnostics,
      }),
    });
  }
}

export function logStreamFailureDiagnostics(input: {
  attempt: number;
  canRetry: boolean;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  input.logger?.error("AI SDK stream failed", toLogError(input.error), {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    errorAfterFinish: input.diagnostics.finishReason !== undefined,
    errorChunkCount: input.diagnostics.errorChunkCount,
    event: "model.sdk.stream.failed",
    finishReason: input.diagnostics.finishReason,
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    rawFinishReason: summarizeScalar(input.diagnostics.rawFinishReason),
    reason: input.failure.reason,
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    retryable: input.canRetry,
    status: input.failure.reason === ModelFailureReasonValue.Cancelled ? "cancelled" : "failed",
    statusCode: input.failure.statusCode,
    statusMessage: input.failure.message,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    usage: summarizeModelUsage(input.diagnostics.usage),
  });
}

export function logIgnoredStreamChunk(input: {
  attempt: number;
  chunk: unknown;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  input.logger?.debug("AI SDK stream chunk was ignored", {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    ...summarizeStreamChunk(input.chunk),
    event: "model.sdk.stream.chunk_ignored",
    module: "adapters.model",
    status: "completed",
  });
}

function summarizeProviderBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (body === null) return { type: "null" };

  if (typeof body === "string") {
    return {
      length: body.length,
      preview: body.slice(0, 500),
      type: "string",
    };
  }

  if (typeof body !== "object") {
    return {
      type: typeof body,
      value: summarizeScalar(body),
    };
  }

  const record = body as Record<string, unknown>;
  return {
    code: summarizeScalar(record.code),
    error: summarizeProviderError(record.error),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    msg: summarizeScalar(record.msg),
    status: summarizeScalar(record.status),
    success: typeof record.success === "boolean" ? record.success : undefined,
    type: Array.isArray(body) ? "array" : "object",
  };
}

function summarizeProviderError(error: unknown): unknown {
  if (error === undefined || error === null || typeof error !== "object") {
    return summarizeScalar(error);
  }

  const record = error as Record<string, unknown>;
  return {
    code: summarizeScalar(record.code),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    type: summarizeScalar(record.type),
  };
}

function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  return {
    chunkKeys: objectKeys(record),
    chunkType: stringProperty(record, "type") ?? typeof chunk,
    finishReason: summarizeScalar(record.finishReason),
    rawFinishReason: summarizeScalar(record.rawFinishReason),
  };
}

function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

function summarizeScalar(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
}

function objectKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value).slice(0, 20);
}

export function isSuspiciousStreamDiagnostics(diagnostics: StreamDiagnostics): boolean {
  return isSuspiciousModelCompletion({
    finishReason: diagnostics.finishReason,
    textLength: diagnostics.textDeltaChars,
    toolCallCount: diagnostics.toolCallCount,
    usage: diagnostics.usage,
  });
}

export function isZeroOutputModelCompletion(input: {
  finishReason?: string;
  reasoningLength: number;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  return (
    input.finishReason !== undefined &&
    input.reasoningLength === 0 &&
    isSuspiciousModelCompletion({
      finishReason: input.finishReason,
      textLength: input.textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  );
}

function isSuspiciousModelCompletion(input: {
  finishReason?: string;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  return (
    input.textLength === 0 &&
    input.toolCallCount === 0 &&
    isNonStopFinish(input.finishReason) &&
    isZeroUsage(input.usage)
  );
}

function isNonStopFinish(finishReason?: string): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  const serverToolUse =
    (usage.serverToolUse?.webSearchRequests ?? 0) + (usage.serverToolUse?.webFetchRequests ?? 0);
  if (serverToolUse > 0) return false;
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

function toLogError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
