import {
  context,
  createContextKey,
  createTraceState,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import type {
  AgentTelemetryAbandonReason,
  AgentTelemetryCausation,
  AgentTelemetryExecutionContext,
  AgentTelemetryScope,
} from "@zcode/contracts/telemetry";
import { claimSanitizedTelemetryError } from "./error-sanitizer.js";

const ACTIVE_WRITER_CONTEXT_KEY = createContextKey("@zcode/telemetry/active-writer-v4");
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_ENUM_PATTERN = /^[a-z0-9_./:-]{1,128}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;

export interface ActiveWriterContext {
  activeContext: Context;
  correlation?: AgentTelemetryExecutionContext;
  parent?: ActiveWriterContext;
  span: Span;
  spanName: string;
  toolCallId?: string;
}

export interface WriterHealth {
  onWarning?: (message: string, context: Record<string, unknown>) => void;
}

export interface WriterLifecycleKeys {
  abandonReason: string;
  cancelReason: string;
  errorCategory: string;
  errorCode: string;
  errorMessage: string;
  errorType: string;
  failureStage: string;
  outcome: string;
}

export interface WriterTerminalObservation {
  abandonReason?: string;
  errorCategory?: string;
}

export abstract class BaseSpanWriter implements AgentTelemetryScope {
  private ended = false;
  private readonly startedAtMs = monotonicNowMs();
  readonly state: ActiveWriterContext;

  protected constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    private readonly lifecycle: WriterLifecycleKeys,
    private readonly health: WriterHealth,
    private readonly onTerminal?: (
      outcome: string,
      durationMs: number,
      observation: WriterTerminalObservation,
    ) => void,
  ) {
    this.state = {
      ...metadata,
      activeContext: parentContext,
      span,
    };
    this.state.activeContext = trace
      .setSpan(parentContext, span)
      .setValue(ACTIVE_WRITER_CONTEXT_KEY, this.state);
  }

  captureCausation(): AgentTelemetryCausation | undefined {
    return causationFromState(this.state);
  }

  run<T>(execute: () => T): T {
    let entered = false;
    let businessReturned = false;
    let businessValue: T | undefined;
    let businessError: unknown;

    const invokeBusinessOnce = (): T => {
      if (entered) {
        if (businessReturned) return businessValue as T;
        throw businessError;
      }
      entered = true;
      try {
        businessValue = execute();
        businessReturned = true;
        return businessValue;
      } catch (error) {
        businessError = error;
        throw error;
      }
    };

    let value: T;
    try {
      value = context.with(this.state.activeContext, invokeBusinessOnce);
    } catch (error) {
      if (!entered) {
        this.warn("Telemetry context activation failed", error);
        value = invokeBusinessOnce();
      } else if (businessReturned) {
        // Bug 根因：观测 Context Manager 理论上不应在业务返回后抛错；若第三方实现违反
        // 契约，不能因此重跑或覆盖已经成功执行一次的业务回调。
        this.warn("Telemetry context teardown failed", error);
        value = businessValue as T;
      } else {
        this.finishThrownIfOpen(error);
        throw error;
      }
    }

    if (!isPromiseLike(value)) {
      this.finishAbandonedIfOpen("missing_terminal");
      return value;
    }

    return Promise.resolve(value).then(
      (result) => {
        this.finishAbandonedIfOpen("missing_terminal");
        return result;
      },
      (error: unknown) => {
        this.finishThrownIfOpen(error);
        throw error;
      },
    ) as T;
  }

  protected abstract finishUnhandled(error: unknown): void;

  protected addEvent(name: string, attributes?: Attributes): void {
    this.safe(() => this.state.span.addEvent(name, compactAttributes(attributes ?? {})));
  }

  protected elapsedMs(): number {
    return Math.max(0, monotonicNowMs() - this.startedAtMs);
  }

  protected finishAbandonedIfOpen(reason: AgentTelemetryAbandonReason): void {
    if (!this.claimTerminal()) return;
    this.setAttribute(this.lifecycle.outcome, "abandoned");
    this.setAttribute(this.lifecycle.abandonReason, reason);
    this.endSpan("abandoned", { abandonReason: reason });
  }

  protected finishCancelledIfOpen(reason: string): void {
    if (!this.claimTerminal()) return;
    this.setAttribute(this.lifecycle.outcome, "cancelled");
    this.setAttribute(this.lifecycle.cancelReason, safeEnum(reason));
    this.endSpan("cancelled");
  }

  protected finishCompletedIfOpen(extra?: () => void): void {
    if (!this.claimTerminal()) return;
    this.safe(extra);
    this.setAttribute(this.lifecycle.outcome, "completed");
    this.safe(() => this.state.span.setStatus({ code: SpanStatusCode.OK }));
    this.endSpan("completed");
  }

  protected finishDomainOutcomeIfOpen(outcome: string, extra?: () => void): void {
    if (!this.claimTerminal()) return;
    this.safe(extra);
    this.setAttribute(this.lifecycle.outcome, safeEnum(outcome));
    this.endSpan(outcome);
  }

  protected finishFailedIfOpen(stage: string, category: string, error?: unknown): void {
    if (!this.claimTerminal()) return;
    this.setAttribute(this.lifecycle.outcome, "failed");
    this.setAttribute(this.lifecycle.failureStage, safeEnum(stage));
    this.setAttribute(this.lifecycle.errorCategory, safeEnum(category));
    if (error !== undefined) this.recordSanitizedError(error);
    this.safe(() =>
      this.state.span.setStatus({
        code: SpanStatusCode.ERROR,
      }),
    );
    this.endSpan("failed", { errorCategory: safeEnum(category) });
  }

  protected isOpen(): boolean {
    return !this.ended;
  }

  protected recordSanitizedError(error: unknown): void {
    const sanitized = claimSanitizedTelemetryError(error);
    if (!sanitized) return;
    this.setAttribute(this.lifecycle.errorType, sanitized.type);
    this.setAttribute(this.lifecycle.errorCode, sanitized.code);
    this.setAttribute(this.lifecycle.errorMessage, sanitized.message);
    this.setAttribute("error.type", sanitized.type);
    this.setAttribute("error.message", sanitized.message);
    if (sanitized.cause) {
      this.setAttribute("error.cause.type", sanitized.cause.type);
      this.setAttribute("error.cause.code", sanitized.cause.code);
      this.setAttribute("error.cause.message", sanitized.cause.message);
    }
  }

  protected setAttribute(key: string, value: unknown): void {
    const normalized = normalizeAttributeValue(value);
    if (normalized === undefined) return;
    this.safe(() => this.state.span.setAttribute(key, normalized));
  }

  protected setAttributes(attributes: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
  }

  protected safe(run: (() => void) | undefined): void {
    if (!run) return;
    try {
      run();
    } catch (error) {
      this.warn("Telemetry writer operation failed", error);
    }
  }

  private claimTerminal(): boolean {
    if (this.ended) return false;
    // 先关闭内存闩锁，再触碰任何 SDK/Adapter；即使后续抛错也不会重复终结。
    this.ended = true;
    return true;
  }

  private endSpan(outcome: string, observation: WriterTerminalObservation = {}): void {
    const durationMs = this.elapsedMs();
    this.safe(() => this.onTerminal?.(outcome, durationMs, observation));
    this.safe(() => this.state.span.end());
  }

  private finishThrownIfOpen(error: unknown): void {
    if (!this.isOpen()) return;
    this.finishUnhandled(error);
  }

  private warn(message: string, error: unknown): void {
    try {
      this.health.onWarning?.(message, {
        errorType: error instanceof Error ? error.name : typeof error,
        spanName: this.state.spanName,
      });
    } catch {
      // Telemetry 的健康回调也属于旁路，绝不能覆盖业务返回或异常。
    }
  }
}

export function activeWriterContext(): ActiveWriterContext | undefined {
  return context.active().getValue(ACTIVE_WRITER_CONTEXT_KEY) as ActiveWriterContext | undefined;
}

export function causationFromState(
  state: ActiveWriterContext | undefined,
): AgentTelemetryCausation | undefined {
  if (!state) return undefined;
  const spanContext = state.span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return undefined;
  return {
    isRemote: spanContext.isRemote ?? false,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
    ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
    sessionId: state.correlation?.sessionId,
    turnId: state.correlation?.turnId,
    toolCallId: state.toolCallId,
  };
}

export function contextFromCausation(causation: AgentTelemetryCausation): Context {
  // 显式 Causation 只传播保存下来的 SpanContext。不能以执行时碰巧活跃的 Context
  // 为底，否则会把另一个异步任务的 Baggage 或 ZCode Writer 私有状态夹带进来。
  return trace.setSpanContext(ROOT_CONTEXT, spanContextFromCausation(causation));
}

export function spanContextFromCausation(causation: AgentTelemetryCausation): SpanContext {
  return {
    isRemote: causation.isRemote,
    spanId: causation.spanId,
    traceFlags: causation.traceFlags,
    traceId: causation.traceId,
    ...(causation.traceState ? { traceState: createTraceState(causation.traceState) } : {}),
  };
}

export function compactAttributes(attributes: Attributes): Attributes {
  const compacted: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = normalizeAttributeValue(value);
    if (normalized !== undefined) compacted[key] = normalized;
  }
  return compacted;
}

export function executionProjection(
  correlation: AgentTelemetryExecutionContext | undefined,
  options: {
    includeActor?: boolean;
    includeAgent?: boolean;
    includeIdentity?: boolean;
    includeQuery?: boolean;
    includeSession?: boolean;
  } = {},
): Record<string, unknown> {
  if (!correlation) return {};
  return {
    "zcode.execution.session_id": options.includeSession
      ? safeId(correlation.sessionId)
      : undefined,
    "zcode.execution.parent_session_id": options.includeSession
      ? safeId(correlation.parentSessionId)
      : undefined,
    "zcode.execution.turn_id": safeId(correlation.turnId),
    "zcode.execution.parent_turn_id": options.includeSession
      ? safeId(correlation.parentTurnId)
      : undefined,
    "zcode.execution.query_id": options.includeQuery ? safeId(correlation.queryId) : undefined,
    "zcode.execution.actor_kind": options.includeActor
      ? safeEnum(correlation.actorKind)
      : undefined,
    "zcode.execution.agent_name": options.includeAgent
      ? safeIdentifier(correlation.agentName)
      : undefined,
    "zcode.execution.identity_state": options.includeIdentity
      ? safeEnum(correlation.identityState)
      : undefined,
    "zcode.execution.user_subject_id": options.includeIdentity
      ? safeId(correlation.userSubjectId)
      : undefined,
    "zcode.execution.launch_surface": safeEnum(correlation.launchSurface),
  };
}

export function safeEnum(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return SAFE_ENUM_PATTERN.test(normalized) ? normalized : undefined;
}

export function safeId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && SAFE_ID_PATTERN.test(normalized) ? normalized : undefined;
}

export function safeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, 128);
  return SAFE_IDENTIFIER_PATTERN.test(normalized) ? normalized : undefined;
}

export function safeString(value: string | undefined, maxLength = 256): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
  return normalized || undefined;
}

export function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function integer(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    ("code" in error && (error as Error & { code?: unknown }).code === "ABORT_ERR")
  );
}

function normalizeAttributeValue(
  value: unknown,
): string | number | boolean | string[] | number[] | boolean[] | undefined {
  if (typeof value === "string") return safeString(value, 1_024);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    if (strings.length === value.length) return strings;
    const numbers = value.filter(
      (item): item is number => typeof item === "number" && Number.isFinite(item),
    );
    if (numbers.length === value.length) return numbers;
    const booleans = value.filter((item): item is boolean => typeof item === "boolean");
    if (booleans.length === value.length) return booleans;
    return undefined;
  }
  return undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}
