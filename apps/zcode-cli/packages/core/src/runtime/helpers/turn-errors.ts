import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createModelUsageSummaryFromEvents,
  isCoreError,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  ErrorPayloadRole,
  projectExecutionErrorPayload,
  withErrorPayloadRole,
} from "../../errors/error-payload.js";
import { isModelContextExceededError } from "./model-errors.js";

export { projectExecutionErrorPayload } from "../../errors/error-payload.js";

interface TurnAbortScope {
  dispose: () => void;
  signal: AbortSignal;
}

const EXTERNAL_TURN_FAULT_MARKER = "zcode.externalTurnFault";

interface ExternalTurnFaultError extends Error {
  code: string;
  zcodeTurnFault: typeof EXTERNAL_TURN_FAULT_MARKER;
}

/** 宿主用此窄入口中止 turn，同时要求 core 持久化 TurnError 而不是用户取消。 */
export function createExternalTurnFaultError(code: string, message = code): Error {
  return Object.assign(new Error(message), {
    code,
    zcodeTurnFault: EXTERNAL_TURN_FAULT_MARKER as typeof EXTERNAL_TURN_FAULT_MARKER,
  }) satisfies ExternalTurnFaultError;
}

function findExternalTurnFault(error: unknown): ExternalTurnFaultError | null {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.zcodeTurnFault === EXTERNAL_TURN_FAULT_MARKER &&
      typeof record.code === "string" &&
      current instanceof Error
    ) {
      return current as ExternalTurnFaultError;
    }
    current = record.cause;
  }
  return null;
}

export function createTurnAbortScope(parentSignal?: AbortSignal): TurnAbortScope {
  const controller = new AbortController();

  const abortTurn = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal?.aborted) {
    abortTurn();
    return { dispose: () => {}, signal: controller.signal };
  }

  parentSignal?.addEventListener("abort", abortTurn, { once: true });

  return {
    dispose: () => {
      parentSignal?.removeEventListener("abort", abortTurn);
    },
    signal: controller.signal,
  };
}

export function throwIfTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createTurnCancelledError(signal.reason);
}

export function createTurnFailureError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  fallbackMessage: string,
) {
  const externalFault = findExternalTurnFault(abortSignal?.reason) ?? findExternalTurnFault(error);
  if (externalFault) {
    return createCoreError(CoreErrorType.UnknownError, externalFault.message, {
      cause: externalFault,
      recoverable: true,
    });
  }
  if (isTurnCancellationError(error, abortSignal)) {
    return createTurnCancelledError(error);
  }

  if (
    isCoreError(error) &&
    (error.type === CoreErrorType.ModelContextExceeded ||
      (fallbackMessage === "Turn execution failed" && error.type === CoreErrorType.ModelError))
  ) {
    return error;
  }

  if (isModelContextExceededError(error)) {
    return createCoreError(
      CoreErrorType.ModelContextExceeded,
      "Model request exceeded the provider context window.",
      { cause: error instanceof Error ? error : undefined, recoverable: true, retryable: true },
    );
  }

  return createCoreError(CoreErrorType.UnknownError, fallbackMessage, {
    cause: error instanceof Error ? error : undefined,
    // turn 级 UnknownError 只是统一生命周期包装；UI/error payload
    // 需要展示下层 provider/tool 给出的用户可读根因，不能让泛化文案抢占摘要。
    context: withErrorPayloadRole(undefined, ErrorPayloadRole.Wrapper),
  });
}

export function createTurnCancelledError(error: unknown) {
  if (isCoreError(error) && error.type === CoreErrorType.TurnCancelled) {
    return error;
  }

  return createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.", {
    cause: error instanceof Error ? error : undefined,
    recoverable: true,
  });
}

// 用户主动中断（TurnCancelled）属于正常结束，不应记为错误。turn/compact/rewind 三处 catch
// 之前都无条件 emit TurnError，会被 reducer/UI/桌面统一映射成 turn.failed（status:error、追加错误消息）。
// 这里统一收口：取消时改发 TurnComplete(resultType:"cancelled") 让状态干净回到 idle，真实错误才发 TurnError。
// 调用方仍负责向上 throw coreError 与记录 usage。
export async function appendTurnOutcomeEvent(
  runtime: AgentRuntimeInternal,
  params: {
    coreError: ReturnType<typeof createTurnFailureError>;
    events: SessionEvent[];
    durationMs: number;
    turnPhase: string;
    inputId?: string;
    highspeedCardId?: string;
    highspeedFallbackUnavailable?: boolean;
    traceContext: TraceContext;
    fallbackMessage: string;
    logEvent: string;
    logLabel: string;
    preserveQueueAutoDrainOnCancel?: boolean;
    backgroundSubagentResultConsumed?: boolean;
    workflowResultConsumed?: boolean;
    historyRoundCount?: number;
  },
): Promise<void> {
  const { coreError, events, traceContext, turnPhase, inputId } = params;
  const cancelled = coreError.type === CoreErrorType.TurnCancelled;
  const externalFault = findExternalTurnFault(coreError);
  const projectedError = projectExecutionErrorPayload(coreError, params.fallbackMessage);

  const outcomeEvent = cancelled
    ? runtime.createEvent(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          usage: createModelUsageSummaryFromEvents(events),
          toolCallCount: 0,
          historyRoundCount: params.historyRoundCount ?? 0,
          duration: params.durationMs,
          resultType: "cancelled",
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          ...(params.preserveQueueAutoDrainOnCancel
            ? { preserveQueueAutoDrainOnCancel: true }
            : {}),
        },
        traceContext,
      )
    : runtime.createEvent(
        SessionEventType.TurnError,
        {
          error: {
            type: externalFault?.code ?? coreError.type,
            // coreError.message 常是泛化文案，真实 provider/network 原因藏在 cause 链里；
            // 写入可读 payload fields 让桌面端和恢复链路都能展示根因。
            ...projectedError,
            attribution: {
              ...projectedError.attribution,
              // Bug 根因：创建期尚无 userInput 行。每个新错误都发布 string/null，
              // 让 Renderer 区分“普通轮”与“旧 Agent 没有该字段”。
              highspeedCardId: params.highspeedCardId ?? null,
              // 无处可退时没有 fallback 事件，且请求期失败的 code 是 provider 错误码（如 3402），
              // Renderer 不能按错误码推断退卡；由 Core 把“已归因且无处可退”作为结构化事实发布。
              ...(params.highspeedFallbackUnavailable
                ? { highspeedFallbackUnavailable: true }
                : {}),
            },
            stack: coreError.stack,
          },
          turnPhase,
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        },
        traceContext,
      );
  await runtime.appendEvent(outcomeEvent, traceContext);
  events.push(outcomeEvent);

  runtime.logger?.error(`${params.logLabel} failed`, coreError, {
    ...traceContextToLogContext(traceContext),
    event: params.logEvent,
    module: "core.runtime",
    status: cancelled ? "cancelled" : "failed",
    turnPhase,
  });
}

export function isTurnCancellationError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (findExternalTurnFault(abortSignal?.reason) || findExternalTurnFault(error)) return false;
  if (abortSignal?.aborted) return true;

  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.TurnCancelled) {
      return true;
    }

    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const code = typeof record.code === "string" ? record.code : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (
      type === CoreErrorType.TurnCancelled ||
      code === CoreErrorType.TurnCancelled ||
      code === "MODEL_REQUEST_CANCELLED" ||
      code === "model_request_cancelled" ||
      code === "ABORT_ERR" ||
      name === "AbortError"
    ) {
      return true;
    }

    current = record.cause;
  }

  return false;
}
