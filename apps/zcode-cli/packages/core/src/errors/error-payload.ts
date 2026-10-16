import type {
  ErrorAttribution,
  ModelApiErrorPhase,
  ModelFailureExceptionKind,
} from "@zcode/contracts";

export interface ExecutionErrorPayloadProjection {
  attribution?: ErrorAttribution;
  code?: string;
  detail?: string;
  underlyingErrorDetail?: string;
  underlyingErrorMessage?: string;
  message: string;
}

export const ErrorPayloadRole = {
  Primary: "primary",
  Wrapper: "wrapper",
} as const;

export type ErrorPayloadRole = (typeof ErrorPayloadRole)[keyof typeof ErrorPayloadRole];

export function withErrorPayloadRole(
  context: Record<string, unknown> | undefined,
  role: ErrorPayloadRole,
): Record<string, unknown> {
  return {
    ...context,
    errorPayloadRole: role,
  };
}

interface ErrorPayloadFrame {
  code?: string;
  context?: Record<string, unknown>;
  contextCode?: string;
  detail?: string;
  isWrapper: boolean;
  message?: string;
  originalMessage?: string;
  retryable?: boolean;
  role?: ErrorPayloadRole;
}

export function selectExecutionErrorMessage(
  error: unknown,
  fallbackMessage = "Turn execution failed",
): string {
  const primaryFrame = selectPrimaryErrorFrame(collectErrorPayloadFrames(error));
  return primaryFrame?.originalMessage ?? readOriginalText(fallbackMessage) ?? fallbackMessage;
}

export function projectExecutionErrorPayload(
  error: unknown,
  fallbackMessage = "Turn execution failed",
): ExecutionErrorPayloadProjection {
  const frames = collectErrorPayloadFrames(error);
  const primaryFrame = selectPrimaryErrorFrame(frames);
  const message = primaryFrame?.message ?? sanitizeText(fallbackMessage) ?? fallbackMessage;
  const code = selectErrorCode(primaryFrame, frames);
  const detail = buildErrorDetail(frames, message);
  // 保留最深层非 wrapper frame 的原始 message/detail，供 UI telemetry 定位具体失败原因；
  // 不改变既有 detail 的拼接结果或错误处理行为。
  const underlyingFrame =
    [...frames].reverse().find((frame) => !frame.isWrapper) ?? frames[frames.length - 1];
  const attribution = projectErrorAttribution(frames);

  return {
    ...(attribution ? { attribution } : {}),
    ...(code ? { code } : {}),
    message,
    ...(detail ? { detail } : {}),
    ...(underlyingFrame?.message
      ? { underlyingErrorMessage: underlyingFrame.message }
      : {}),
    ...(underlyingFrame?.detail
      ? { underlyingErrorDetail: underlyingFrame.detail }
      : {}),
  };
}

function projectErrorAttribution(
  frames: readonly ErrorPayloadFrame[],
): ErrorAttribution | undefined {
  const contexts = frames.flatMap((frame) => (frame.context ? [frame.context] : []));
  const reason = selectContextText(contexts, ["reason"]);
  const errorPhase = selectErrorPhase(contexts);
  const exceptionKind = selectExceptionKind(contexts);
  const providerId = selectContextText(contexts, ["providerId", "provider"]);
  const modelId = selectContextText(contexts, ["modelId", "model"]);
  const providerKind = selectContextText(contexts, ["providerKind"]);
  const transport = selectTransport(contexts);
  const statusCode = selectStatusCode(contexts);
  const providerErrorCode =
    selectContextCode(contexts, ["providerCode"]) ??
    frames.map((frame) => frame.code).find((code) => /^\d+$/.test(code ?? ""));
  const retryable =
    selectContextBoolean(contexts, "retryable") ?? selectFrameRetryable(frames);
  const source = selectSource(contexts);

  const attribution: ErrorAttribution = {
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    ...(errorPhase ? { errorPhase } : {}),
    ...(exceptionKind ? { exceptionKind } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(providerKind ? { providerKind } : {}),
    ...(transport ? { transport } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };

  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

function selectErrorPhase(
  contexts: readonly Record<string, unknown>[],
): ModelApiErrorPhase | undefined {
  const value = selectContextText(contexts, ["errorPhase"]);
  return value === "prepare" ||
    value === "configuration" ||
    value === "connect" ||
    value === "response" ||
    value === "stream" ||
    value === "parse" ||
    value === "validation" ||
    value === "unhandled"
    ? value
    : undefined;
}

function selectExceptionKind(
  contexts: readonly Record<string, unknown>[],
): ModelFailureExceptionKind | undefined {
  const value = selectContextText(contexts, ["exceptionKind"]);
  return value === "api_call" ||
    value === "generic" ||
    value === "protocol" ||
    value === "provider_business" ||
    value === "transport" ||
    value === "type_error" ||
    value === "validation"
    ? value
    : undefined;
}

function selectContextText(
  contexts: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const context of contexts) {
    for (const key of keys) {
      const value = sanitizeAttributionText(context[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function selectContextCode(
  contexts: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const context of contexts) {
    for (const key of keys) {
      const value = readCode(context[key]);
      if (value) return sanitizeAttributionText(value);
    }
  }
  return undefined;
}

function selectContextBoolean(
  contexts: readonly Record<string, unknown>[],
  key: string,
): boolean | undefined {
  for (const context of contexts) {
    if (typeof context[key] === "boolean") return context[key];
  }
  return undefined;
}

function selectFrameRetryable(frames: readonly ErrorPayloadFrame[]): boolean | undefined {
  return frames.find((frame) => !frame.isWrapper && frame.retryable !== undefined)?.retryable;
}

function selectStatusCode(contexts: readonly Record<string, unknown>[]): number | undefined {
  for (const context of contexts) {
    const value = context.statusCode ?? context.status;
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

function selectTransport(
  contexts: readonly Record<string, unknown>[],
): ErrorAttribution["transport"] | undefined {
  const value = selectContextText(contexts, ["transport"]);
  return value === "http" || value === "sse" || value === "websocket" ? value : undefined;
}

function selectSource(
  contexts: readonly Record<string, unknown>[],
): ErrorAttribution["source"] | undefined {
  const value = selectContextText(contexts, ["source"]);
  return value === "provider" || value === "runtime" || value === "tool" || value === "network"
    ? value
    : undefined;
}

function sanitizeAttributionText(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  return text.length <= 160 ? text : text.slice(0, 160);
}

function collectErrorPayloadFrames(error: unknown): ErrorPayloadFrame[] {
  const frames: ErrorPayloadFrame[] = [];
  const seen = new WeakSet<object>();
  let current = error;

  for (let depth = 0; depth < 12; depth += 1) {
    if (!isRecord(current) || seen.has(current)) {
      break;
    }
    seen.add(current);
    frames.push(toErrorPayloadFrame(current));

    const next = current.cause ?? current.lastError ?? current.error;
    if (!next || next === current) {
      break;
    }
    current = next;
  }

  return frames;
}

function toErrorPayloadFrame(entry: Record<string, unknown>): ErrorPayloadFrame {
  const context = isRecord(entry.context) ? entry.context : undefined;
  const originalMessage = readOriginalText(entry.message);
  const message = sanitizeText(originalMessage);
  const role =
    readErrorPayloadRole(entry.errorPayloadRole) ?? readErrorPayloadRole(context?.errorPayloadRole);
  const code =
    readCode(entry.providerCode) ?? readCode(context?.providerCode) ?? readCode(entry.code);
  const contextCode = readCode(context?.code);
  const detail =
    sanitizeText(readString(entry.detail)) ??
    sanitizeText(readString(entry.errorDetails)) ??
    sanitizeText(readString(entry.details));
  const isWrapper = role === ErrorPayloadRole.Wrapper;
  const retryable = typeof entry.retryable === "boolean" ? entry.retryable : undefined;

  return {
    ...(code ? { code } : {}),
    ...(context ? { context } : {}),
    ...(contextCode ? { contextCode } : {}),
    ...(detail ? { detail } : {}),
    isWrapper,
    ...(message ? { message } : {}),
    ...(originalMessage ? { originalMessage } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(role ? { role } : {}),
  };
}

function selectPrimaryErrorFrame(
  frames: readonly ErrorPayloadFrame[],
): ErrorPayloadFrame | undefined {
  return (
    frames.find((frame) => frame.message && !frame.isWrapper) ??
    frames.find((frame) => frame.message)
  );
}

function selectErrorCode(
  primaryFrame: ErrorPayloadFrame | undefined,
  frames: readonly ErrorPayloadFrame[],
): string | undefined {
  const primaryCandidates = primaryFrame?.isWrapper
    ? [primaryFrame.contextCode, primaryFrame.code]
    : [primaryFrame?.code, primaryFrame?.contextCode];
  const candidates = [
    ...primaryCandidates,
    ...frames.filter((frame) => !frame.isWrapper).map((frame) => frame.code),
    ...frames.map((frame) => frame.contextCode),
    ...frames.map((frame) => frame.code),
  ].filter((code): code is string => Boolean(code));

  return candidates[0];
}

function buildErrorDetail(
  frames: readonly ErrorPayloadFrame[],
  message: string,
): string | undefined {
  const detailLines = uniqueStrings(
    frames.flatMap((frame) => [frame.message, frame.detail, formatContextDetail(frame.context)]),
  ).filter((line) => line !== message);

  return detailLines.length > 0 ? detailLines.join("\n") : undefined;
}

function formatContextDetail(context: Record<string, unknown> | undefined): string | undefined {
  if (!context) {
    return undefined;
  }

  const detailParts = [
    formatContextPart("provider", context.providerId ?? context.provider),
    formatContextPart("provider_code", context.providerCode),
    formatContextPart("model", context.modelId ?? context.model),
    formatContextPart("request", context.requestId),
    formatContextPart("code", context.code),
    formatContextPart("reason", context.reason),
    formatContextPart("status", context.statusCode ?? context.status),
    formatContextPart("retryable", context.retryable),
  ].filter((part): part is string => Boolean(part));

  return detailParts.length > 0 ? detailParts.join(" ") : undefined;
}

function formatContextPart(label: string, value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return `${label}=${value.trim()}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${label}=${value}`;
  }
  if (typeof value === "boolean") {
    return `${label}=${value ? "true" : "false"}`;
  }
  return undefined;
}

function readCode(value: unknown): string | undefined {
  const asString = readString(value);
  if (asString) return asString;
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
    return String(value);
  }
  return undefined;
}

function readErrorPayloadRole(value: unknown): ErrorPayloadRole | undefined {
  if (value === ErrorPayloadRole.Primary || value === ErrorPayloadRole.Wrapper) {
    return value;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOriginalText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

function sanitizeText(message: string | undefined): string | undefined {
  const compact = message?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value && !result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
