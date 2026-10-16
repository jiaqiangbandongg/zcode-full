import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  ModelNetworkStatusEvent,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface ModelStatusSinkOptions {
  /** Sampling 不投影到主会话；保留网络日志和内存用量事件。 */
  persist?: boolean;
  onStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
}

export function createModelStatusSink(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  events: SessionEvent[],
  options: ModelStatusSinkOptions = {},
): ModelStatusSink {
  return {
    publish: async (statusEvent: ModelNetworkStatusEvent): Promise<void> => {
      const eventPayload = options.streamRecovery
        ? { ...statusEvent, streamRecovery: options.streamRecovery }
        : statusEvent;
      options.onStatus?.(eventPayload);
      this.logModelNetworkStatus(eventPayload, traceContext);
      const event = this.createEvent(
        SessionEventType.ModelNetworkStatus,
        eventPayload,
        traceContext,
      );
      if (options.persist !== false) await this.appendEvent(event, traceContext);
      events.push(event);
    },
  };
}

export function logModelNetworkStatus(
  this: AgentRuntimeInternal,
  statusEvent: ModelNetworkStatusEvent,
  traceContext: TraceContext,
): void {
  const baseContext = {
    ...traceContextToLogContext(traceContext),
    attempt: statusEvent.attempt,
    baseURL: statusEvent.baseURL,
    maxAttempts: statusEvent.maxAttempts,
    modelId: statusEvent.modelId,
    providerId: statusEvent.providerId,
    providerKind: statusEvent.providerKind,
    requestId: statusEvent.requestId,
    streamRecoveryAnchorId: statusEvent.streamRecovery?.anchorId,
    streamRecoveryFromRequestId: statusEvent.streamRecovery?.recoveredFromRequestId,
    streamRecoveryMaxRetries: statusEvent.streamRecovery?.maxRetries,
    streamRecoveryRetryNumber: statusEvent.streamRecovery?.retryNumber,
    transport: statusEvent.transport,
  };

  switch (statusEvent.type) {
    case "model_request_queued":
      this.logger?.debug("Model network request queued for admission", {
        ...baseContext,
        event: "model.network.queued",
        module: "core.runtime",
        status: "waiting",
      });
      return;

    case "model_request_admitted":
      this.logger?.debug("Model network request admitted", {
        ...baseContext,
        event: "model.network.admitted",
        module: "core.runtime",
        queuedMs: statusEvent.queuedMs,
        status: "started",
      });
      return;

    case "model_request_started":
      this.logger?.debug("Model network request started", {
        ...baseContext,
        event: "model.network.started",
        module: "core.runtime",
        status: "started",
      });
      return;

    case "model_request_completed":
      this.logger?.info("Model network request completed", {
        ...baseContext,
        durationMs: statusEvent.durationMs,
        event: "model.network.completed",
        finishReason: statusEvent.finishReason,
        module: "core.runtime",
        status: "completed",
      });
      return;

    case "model_request_failed":
      this.logger?.warn("Model network request failed", {
        ...baseContext,
        durationMs: statusEvent.durationMs,
        event: "model.network.failed",
        module: "core.runtime",
        reason: statusEvent.reason,
        retryable: statusEvent.retryable,
        status: statusEvent.reason === "cancelled" ? "cancelled" : "failed",
        statusCode: statusEvent.statusCode,
        statusMessage: statusEvent.message,
      });
      return;

    case "model_retry_scheduled":
      this.logger?.warn("Model network retry scheduled", {
        ...baseContext,
        delayMs: statusEvent.delayMs,
        event: "model.network.retry_scheduled",
        module: "core.runtime",
        nextAttempt: statusEvent.nextAttempt,
        reason: statusEvent.reason,
        status: "waiting",
        statusCode: statusEvent.statusCode,
        statusMessage: statusEvent.message,
      });
      return;

    case "model_stream_stalled":
      this.logger?.warn("Model network stream stalled", {
        ...baseContext,
        event: "model.network.stream_stalled",
        idleMs: statusEvent.idleMs,
        module: "core.runtime",
        status: "waiting",
        statusMessage: statusEvent.message,
        timeoutMs: statusEvent.timeoutMs,
      });
  }
}
