import type {
  ModelNetworkStatusEvent,
  ModelRequestCompletedStatusEvent,
  ModelRequestFailedStatusEvent,
  ModelStatusSink,
} from "@zcode/contracts/model";
import { ModelFailureReason, ModelTransportKind } from "@zcode/contracts/model";
import type {
  AgentTelemetryErrorCategory,
  ModelApiOperationKind,
  ModelAttemptFailureStage,
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
  ModelExecutionTelemetryPort,
  ResolvedModelTelemetryDescriptor,
} from "@zcode/contracts/telemetry";
import { ProviderEndpointIdentityCache } from "./provider-endpoint.js";

interface ModelApiTelemetryStatusSinkOptions {
  maxActiveCallAgeMs?: number;
  maxActiveCalls?: number;
  modelExecution: ModelExecutionTelemetryPort;
  now?: () => number;
  onWarning?: (message: string, context: Record<string, unknown>) => void;
}

interface AttemptState {
  requestId: string;
  writer: ModelAttemptSpanWriter;
}

interface CallState {
  lastRequestId?: string;
  logicalCallId: string;
  lastActivityAtMs: number;
  pendingRetryDelayMs?: number;
  sessionId?: string;
  attempts: Map<string, AttemptState>;
  writer: ModelCallSpanWriter;
}

/**
 * 把 Transport 的实时事实直接写入仍然活动的 Model Call/Attempt Span。
 * 不创建终态 Record、不保存开始/结束时间，也不在导出阶段重建 Span。
 */
export class ModelApiTelemetryStatusSink implements ModelStatusSink {
  private readonly calls = new Map<string, CallState>();
  private readonly endpointCache = new ProviderEndpointIdentityCache();
  private readonly maxActiveCallAgeMs: number;
  private readonly maxActiveCalls: number;
  private readonly modelExecution: ModelExecutionTelemetryPort;
  private readonly now: () => number;
  private nextCapacityWarningAtMs = 0;
  private nextSweepAtMs = 0;
  private readonly onWarning?: ModelApiTelemetryStatusSinkOptions["onWarning"];

  constructor(options: ModelApiTelemetryStatusSinkOptions) {
    this.maxActiveCallAgeMs = positiveInteger(options.maxActiveCallAgeMs, 30 * 60_000);
    this.maxActiveCalls = positiveInteger(options.maxActiveCalls, 1_000);
    this.modelExecution = options.modelExecution;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
  }

  publish(event: ModelNetworkStatusEvent): void {
    this.publishObserved(event);
  }

  publishFailure(event: ModelRequestFailedStatusEvent, error: unknown): void {
    this.publishObserved(event, error);
  }

  private publishObserved(event: ModelNetworkStatusEvent, failureError?: unknown): void {
    try {
      this.publishSafely(event, failureError);
    } catch (error) {
      // Bug 根因：Telemetry Sink 位于模型状态 fan-out 内，任何同步异常都会阻断 Provider
      // 状态持久化和模型主链路；这里必须完全旁路。
      try {
        this.onWarning?.("Model telemetry status processing failed", {
          eventType: event.type,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // 观测健康回调也不能反向污染模型链路。
      }
    }
  }

  shutdown(): void {
    for (const call of this.calls.values()) {
      this.abandonCall(call, "process_shutdown");
    }
  }

  abandonSession(sessionId: string): void {
    for (const call of this.calls.values()) {
      if (call.sessionId === sessionId) {
        this.abandonCall(call, "session_shutdown");
      }
    }
  }

  get activeCallCount(): number {
    return this.calls.size;
  }

  private publishSafely(event: ModelNetworkStatusEvent, failureError?: unknown): void {
    const now = this.now();
    this.sweepExpiredCalls(now);
    const modelCall = event.modelCall;
    if (!modelCall) return;
    let call = this.calls.get(modelCall.logicalCallId);

    if (event.type === "model_request_started") {
      if (!call) {
        this.ensureCapacity(now);
        const target = this.resolveTarget(event);
        const callCause = modelCall.callCause ?? "initial";
        const writer = this.modelExecution.startCall(
          callCause === "initial" || !modelCall.previousLogicalCallId
            ? {
                callCause: "initial",
                logicalCallId: modelCall.logicalCallId,
                operation: modelCall.operation,
                requested: target,
                streaming: event.transport !== ModelTransportKind.Http,
              }
            : {
                callCause,
                logicalCallId: modelCall.logicalCallId,
                operation: modelCall.operation,
                previousLogicalCallId: modelCall.previousLogicalCallId,
                requested: target,
                streaming: event.transport !== ModelTransportKind.Http,
              },
        );
        call = {
          attempts: new Map(),
          lastActivityAtMs: now,
          logicalCallId: modelCall.logicalCallId,
          sessionId: event.sessionId,
          writer,
        };
        this.calls.set(modelCall.logicalCallId, call);
      }
      call.lastActivityAtMs = now;
      this.startAttempt(call, event);
      return;
    }

    if (!call) return;
    call.lastActivityAtMs = now;
    const attempt = call.attempts.get(event.requestId);

    switch (event.type) {
      case "model_first_provider_event":
        attempt?.writer.markFirstProviderEvent();
        return;
      case "model_first_content":
        attempt?.writer.markFirstContent();
        return;
      case "model_first_text":
        attempt?.writer.markFirstText();
        return;
      case "model_stream_stalled":
        attempt?.writer.markStreamStalled(event.idleMs);
        return;
      case "model_request_observation":
        attempt?.writer.recordRequestObservation(event.observation);
        return;
      case "model_retry_scheduled":
        call.pendingRetryDelayMs = event.delayMs;
        return;
      case "model_request_failed":
        if (!attempt) return;
        this.finishFailedAttempt(call, attempt, event, failureError);
        call.attempts.delete(event.requestId);
        if (!event.retryable) this.finishFailedCall(call, event, failureError);
        return;
      case "model_request_completed":
        if (!attempt) return;
        this.finishCompletedAttempt(attempt.writer, event);
        call.attempts.delete(event.requestId);
        call.writer.finishCompleted();
        this.calls.delete(call.logicalCallId);
    }
  }

  private startAttempt(
    call: CallState,
    event: Extract<ModelNetworkStatusEvent, { type: "model_request_started" }>,
  ): void {
    if (call.attempts.has(event.requestId)) return;
    const target = this.resolveTarget(event);
    const previousRequestId = call.lastRequestId;
    const isInitial = event.attempt <= 1 || !previousRequestId;
    const writer = call.writer.startAttempt(
      isInitial
        ? {
            apiOperation: apiOperationFromRoute(target.providerRoute),
            attemptCause: "initial",
            attemptNumber: event.attempt,
            maxAttempts: event.maxAttempts,
            requestId: event.requestId,
            target,
            transport: event.transport,
          }
        : {
            apiOperation: apiOperationFromRoute(target.providerRoute),
            attemptCause: "retry",
            attemptNumber: event.attempt,
            maxAttempts: event.maxAttempts,
            previousRequestId,
            requestId: event.requestId,
            retryDelayMs: call.pendingRetryDelayMs,
            target,
            transport: event.transport,
          },
    );
    setEffectiveReasoning(writer, target);
    call.attempts.set(event.requestId, { requestId: event.requestId, writer });
    call.lastRequestId = event.requestId;
    call.pendingRetryDelayMs = undefined;
  }

  private finishCompletedAttempt(
    writer: ModelAttemptSpanWriter,
    event: ModelRequestCompletedStatusEvent,
  ): void {
    if (event.providerRequestId) writer.setProviderRequestId(event.providerRequestId);
    if (event.finishReason) writer.setFinishReason(event.finishReason);
    if (event.usage) {
      if (event.usage.inputTokens !== undefined) {
        writer.setInputTokens(event.usage.inputTokens);
      }
      if (event.usage.outputTokens !== undefined) {
        writer.setOutputTokens(event.usage.outputTokens);
      }
      if (event.usage.reasoningTokens !== undefined) {
        writer.setReasoningTokens(event.usage.reasoningTokens);
      }
      if (event.usage.cacheReadTokens !== undefined) {
        writer.setCacheReadTokens(event.usage.cacheReadTokens);
      }
      if (event.usage.cacheWriteTokens !== undefined) {
        writer.setCacheWriteTokens(event.usage.cacheWriteTokens);
      }
    }
    writer.setStreamOutputCommitted(event.streamOutputCommitted ?? false);
    writer.finishCompleted();
  }

  private finishFailedAttempt(
    call: CallState,
    attempt: AttemptState,
    event: ModelRequestFailedStatusEvent,
    failureError: unknown,
  ): void {
    if (event.statusCode !== undefined) attempt.writer.setHttpStatusCode(event.statusCode);
    if (event.providerRequestId) {
      attempt.writer.setProviderRequestId(event.providerRequestId);
    }
    if (event.providerErrorCode) {
      attempt.writer.setProviderErrorCode(event.providerErrorCode);
    }
    if (event.providerErrorMessage) {
      attempt.writer.setProviderErrorMessage(event.providerErrorMessage);
    }
    if (event.retryAfterMs !== undefined) {
      attempt.writer.setRetryAfterMs(event.retryAfterMs);
    }
    attempt.writer.setStreamOutputCommitted(event.streamOutputCommitted ?? false);

    if (event.reason === ModelFailureReason.Cancelled) {
      attempt.writer.finishCancelled("abort_signal");
      return;
    }
    attempt.writer.finishFailed(
      failureStage(event),
      errorCategory(event),
      failureError ?? {
        code: event.providerErrorCode ?? event.errorCode,
        message: event.providerErrorMessage ?? event.message,
        name: event.exceptionType ?? "ModelProviderError",
        statusCode: event.statusCode,
      },
    );
  }

  private finishFailedCall(
    call: CallState,
    event: ModelRequestFailedStatusEvent,
    failureError: unknown,
  ): void {
    if (event.reason === ModelFailureReason.Cancelled) {
      call.writer.finishCancelled("abort_signal");
    } else {
      call.writer.finishFailed(
        "attempts",
        errorCategory(event),
        failureError ?? {
          code: event.providerErrorCode ?? event.errorCode,
          message: event.providerErrorMessage ?? event.message,
          name: event.exceptionType ?? "ModelProviderError",
        },
      );
    }
    this.calls.delete(call.logicalCallId);
  }

  private resolveTarget(event: ModelNetworkStatusEvent): ResolvedModelTelemetryDescriptor {
    const endpoint = this.endpointCache.resolve(event.providerKind, event.baseURL);
    const reasoning = event.modelCall?.reasoning ?? {
      capability: "unknown",
      effectiveControl: "unknown",
      effectiveState: "unknown",
      requestedControl: "unknown",
      requestedState: "unknown",
    };
    return {
      providerId: String(event.providerId),
      providerKind: event.providerKind?.trim() || "unknown",
      providerOrigin: endpoint?.origin,
      providerRoute: endpoint?.route,
      reasoning,
      requestedModel: String(event.modelId),
    };
  }

  private sweepExpiredCalls(now: number): void {
    if (now < this.nextSweepAtMs) return;
    this.nextSweepAtMs = now + Math.min(this.maxActiveCallAgeMs, 60_000);
    let abandonedCount = 0;
    for (const call of this.calls.values()) {
      if (now - call.lastActivityAtMs < this.maxActiveCallAgeMs) continue;
      this.abandonCall(call, "missing_terminal");
      abandonedCount += 1;
    }
    if (abandonedCount > 0) {
      this.warn("Expired model telemetry calls were abandoned", {
        abandonedCount,
        maxActiveCallAgeMs: this.maxActiveCallAgeMs,
      });
    }
  }

  private ensureCapacity(now: number): void {
    let abandonedCount = 0;
    while (this.calls.size >= this.maxActiveCalls) {
      const oldest = [...this.calls.values()].reduce<CallState | undefined>(
        (candidate, call) =>
          !candidate || call.lastActivityAtMs < candidate.lastActivityAtMs ? call : candidate,
        undefined,
      );
      if (!oldest) return;
      this.abandonCall(oldest, "missing_terminal");
      abandonedCount += 1;
    }
    if (abandonedCount > 0 && now >= this.nextCapacityWarningAtMs) {
      this.nextCapacityWarningAtMs = now + 60_000;
      this.warn("Model telemetry active call capacity was reached", {
        abandonedCount,
        maxActiveCalls: this.maxActiveCalls,
      });
    }
  }

  private abandonCall(
    call: CallState,
    reason: "missing_terminal" | "session_shutdown" | "process_shutdown",
  ): void {
    for (const attempt of call.attempts.values()) {
      attempt.writer.finishAbandoned(reason);
    }
    call.attempts.clear();
    call.writer.finishAbandoned(reason);
    this.calls.delete(call.logicalCallId);
  }

  private warn(message: string, context: Record<string, unknown>): void {
    try {
      this.onWarning?.(message, context);
    } catch {
      // Telemetry 健康回调也必须旁路。
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function setEffectiveReasoning(
  writer: ModelAttemptSpanWriter,
  target: ResolvedModelTelemetryDescriptor,
): void {
  writer.setEffectiveReasoningState(target.reasoning.effectiveState);
  writer.setEffectiveReasoningControl(target.reasoning.effectiveControl);
  if (target.reasoning.effectiveLevel) {
    writer.setEffectiveReasoningLevel(target.reasoning.effectiveLevel);
  }
  if (target.reasoning.effectiveBudgetTokens !== undefined) {
    writer.setEffectiveReasoningBudgetTokens(target.reasoning.effectiveBudgetTokens);
  }
}

function apiOperationFromRoute(route: string | undefined): ModelApiOperationKind {
  const normalized = route?.toLowerCase() ?? "";
  if (normalized.includes("/chat/completions")) return "chat_completions";
  if (normalized.includes("/responses")) return "responses";
  if (normalized.includes("/messages")) return "messages";
  if (normalized.includes(":generatecontent") || normalized.includes(":streamgeneratecontent")) {
    return "generate_content";
  }
  return "unknown";
}

function failureStage(event: ModelRequestFailedStatusEvent): ModelAttemptFailureStage {
  return event.errorPhase === "prepare" ? "configuration" : (event.errorPhase ?? "unhandled");
}

function errorCategory(event: ModelRequestFailedStatusEvent): AgentTelemetryErrorCategory {
  switch (event.reason) {
    case ModelFailureReason.AuthFailed:
      return "authentication";
    case ModelFailureReason.ProviderNotConfigured:
    case ModelFailureReason.InvalidRequest:
      return "configuration";
    case ModelFailureReason.RateLimited:
      return "rate_limit";
    case ModelFailureReason.Timeout:
    case ModelFailureReason.StreamIdleTimeout:
      return "timeout";
    case ModelFailureReason.NetworkError:
    case ModelFailureReason.StaleConnection:
    case ModelFailureReason.TlsError:
      return "network";
    case ModelFailureReason.Cancelled:
      return "cancelled";
    case ModelFailureReason.ContextExceeded:
    case ModelFailureReason.ProviderOverloaded:
    case ModelFailureReason.ServerError:
    case ModelFailureReason.ProxyError:
    case ModelFailureReason.AuthRefresh:
    case ModelFailureReason.OffpeakQueued:
      return "provider";
    default:
      return "unknown";
  }
}
