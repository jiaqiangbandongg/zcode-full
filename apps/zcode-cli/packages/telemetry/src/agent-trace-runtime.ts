import { recordRequestObservation } from "./request-security-edition/index.js";
/* oxlint-disable eslint(max-lines) -- concrete Writer 在同一文件显式维护各自 canonical key，避免运行时 Schema/Registry 再造一层映射。 */
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentStepTraceStart,
  AgentTelemetryAbandonReason,
  AgentTelemetryCancellationReason,
  AgentTelemetryCausation,
  AgentTelemetryErrorCategory,
  AgentTelemetryExecutionContext,
  AgentTurnSpanWriter,
  AgentTurnTraceStart,
  CommandExecutionSpanWriter,
  CommandTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  ModelAttemptFailureStage,
  ModelAttemptSpanWriter,
  ModelAttemptTraceStart,
  ModelCallFailureStage,
  ModelCallSpanWriter,
  ModelCallTraceStart,
  ModelExecutionTelemetryPort,
  ModelFinishReason,
  ModelReasoningControlType,
  ModelReasoningState,
  ResponseModelTelemetryDescriptor,
  TelemetryIdentitySnapshot,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@zcode/contracts/telemetry";
import type { ModelRequestObservation } from "@zcode/contracts/model";
import {
  activeWriterContext,
  BaseSpanWriter,
  compactAttributes,
  executionProjection,
  finiteNonNegative,
  integer,
  isAbortLike,
  safeEnum,
  safeId,
  safeIdentifier,
  safeString,
  contextFromCausation,
  spanContextFromCausation,
  type ActiveWriterContext,
  type WriterHealth,
  type WriterLifecycleKeys,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";
import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
  type ModelTokenType,
} from "./agent-metrics.js";
import {
  commandCompatibilityAttributes,
  httpResponseCompatibilityAttributes,
  modelAttemptCompatibilityAttributes,
  modelResponseCompatibilityAttributes,
  toolCompatibilityAttributes,
} from "./compatibility-adapters.js";
import { sanitizeErrorMessage } from "./error-sanitizer.js";

export interface AgentTraceRuntimeOptions extends WriterHealth {
  identity?: TelemetryIdentitySnapshot;
  maxActiveWriters?: number;
  metrics?: AgentTelemetryMetricRecorder;
  tracer: Tracer;
}

interface StartWriterOptions {
  attributes?: Attributes;
  context?: Context;
  correlation?: AgentTelemetryExecutionContext;
  kind?: SpanKind;
  links?: Link[];
  parent?: ActiveWriterContext;
  spanName: string;
  toolCallId?: string;
}

type TrackedWriter = BaseSpanWriter & {
  abandon(reason: AgentTelemetryAbandonReason): void;
  readonly state: ActiveWriterContext;
};

export class AgentExecutionTelemetryRuntime
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  private readonly activeWriters = new Set<TrackedWriter>();
  private capacityWarningActive = false;
  private identity: TelemetryIdentitySnapshot;
  private readonly maxActiveWriters: number;
  private readonly tracer: Tracer;
  private readonly health: WriterHealth;
  private readonly metrics: AgentTelemetryMetricRecorder;

  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
  }

  updateIdentity(snapshot: TelemetryIdentitySnapshot): void {
    this.identity = {
      identityState: snapshot.identityState,
      ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
    };
  }

  captureCausation() {
    const active = activeWriterContext();
    if (!active) return undefined;
    const spanContext = active.span.spanContext();
    if (!trace.isSpanContextValid(spanContext)) return undefined;
    return {
      isRemote: spanContext.isRemote ?? false,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
      ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
      sessionId: active.correlation?.sessionId,
      turnId: active.correlation?.turnId,
      toolCallId: active.toolCallId,
    };
  }

  startTurn(input: AgentTurnTraceStart): AgentTurnSpanWriter {
    const correlation: AgentTelemetryExecutionContext = {
      ...input.context,
      identityState: this.identity.identityState,
      ...(this.identity.userSubjectId ? { userSubjectId: this.identity.userSubjectId } : {}),
    };
    const linkedRoot = input.causationMode !== "child";
    const links =
      input.causation && linkedRoot ? [causationLink(input.causation, "spawned_by")] : undefined;
    return this.safeCreate(
      "agent_turn",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(correlation, {
              includeActor: true,
              includeAgent: true,
              includeIdentity: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.agent_turn.turn_number": integer(input.turnNumber),
            "zcode.agent_turn.input_source": safeEnum(input.inputSource),
          }),
          context: parentContext,
          correlation,
          links,
          spanName: "agent_turn",
        });
        return this.track(
          new TurnWriter(
            span,
            parentContext,
            {
              correlation,
              spanName: "agent_turn",
            },
            this.health,
            this.metrics,
            turnMetricLabels(correlation, input.inputSource),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_TURN_WRITER,
    );
  }

  startStep(input: AgentStepTraceStart): AgentStepSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "agent_step",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.agent_step.step_id": safeId(input.stepId),
            "zcode.agent_step.step_index": integer(input.stepIndex),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "agent_step",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new StepWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "agent_step"),
            this.health,
            this.metrics,
            stepMetricLabels(parent?.correlation),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_STEP_WRITER,
    );
  }

  startTool(input: ToolTraceStart): ToolExecutionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "tool_execution",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const toolName = safeString(input.registeredToolName, 128);
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, { includeActor: true }),
            "zcode.execution.tool_call_id": safeId(input.toolCallId),
            "zcode.tool_execution.tool_name": toolName,
            ...toolCompatibilityAttributes({
              toolCallId: input.toolCallId,
              toolName: input.registeredToolName,
            }),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "tool_execution",
          toolCallId: safeId(input.toolCallId),
        });
        return this.track(
          new ToolWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "tool_execution"),
              toolCallId: safeId(input.toolCallId),
            },
            this.health,
            this.metrics,
            toolMetricLabels(input.registeredToolName),
            (writer) => this.activeWriters.delete(writer),
            (command) => this.startCommand(command),
          ),
        );
      },
      NOOP_TOOL_WRITER,
    );
  }

  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "context_compaction",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.context_compaction.trigger": safeEnum(input.trigger),
            "zcode.context_compaction.phase": safeEnum(input.phase),
            "zcode.context_compaction.model_mode": safeEnum(input.modelMode),
            "zcode.context_compaction.outer_attempt": integer(input.outerAttempt),
            "zcode.context_compaction.max_attempts": integer(input.maxAttempts),
            "zcode.context_compaction.triggering_step_index": integer(input.triggeringStepIndex),
            "zcode.context_compaction.policy_context_window_tokens": finiteNonNegative(
              input.policyContextWindowTokens,
            ),
            "zcode.context_compaction.threshold_tokens": finiteNonNegative(input.thresholdTokens),
            "zcode.context_compaction.token_source": safeEnum(input.tokenSource),
            "zcode.context_compaction.recovered_from_logical_call_id": safeId(
              input.recoveredFromLogicalCallId,
            ),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "context_compaction",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new CompactionWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "context_compaction"),
            this.health,
            this.metrics,
            compactionMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMPACTION_WRITER,
    );
  }

  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {
    const linkedRoot = input.executionKind !== "foreground";
    const links =
      input.causation && linkedRoot
        ? [
            causationLink(
              input.causation,
              input.trigger === "recovery" ? "resumed_from" : "triggered_by",
            ),
          ]
        : undefined;
    return this.safeCreate(
      "detached_operation",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(input.context, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.detached_operation.operation": safeEnum(input.operation),
            "zcode.detached_operation.execution_kind": safeEnum(input.executionKind),
            "zcode.detached_operation.trigger": safeEnum(input.trigger),
            "zcode.detached_operation.target_kind": safeEnum(input.targetKind),
            "zcode.detached_operation.goal_iteration": integer(input.goalIteration),
            "zcode.detached_operation.chunk_index": integer(input.chunkIndex),
            "zcode.detached_operation.chunk_count": integer(input.chunkCount),
          }),
          context: parentContext,
          correlation: input.context,
          links,
          spanName: "detached_operation",
        });
        return this.track(
          new DetachedWriter(
            span,
            parentContext,
            {
              correlation: input.context,
              spanName: "detached_operation",
            },
            this.health,
            this.metrics,
            detachedMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_DETACHED_WRITER,
    );
  }

  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "model_call",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.logical_call_id": safeId(input.logicalCallId),
            "zcode.model_call.operation": safeEnum(input.operation),
            "zcode.model_call.streaming": input.streaming,
            "zcode.model_call.model_role": safeEnum(input.modelRole),
            "zcode.model_call.requested_provider_id": safeString(input.requested.providerId, 128),
            "zcode.model_call.requested_model": safeString(input.requested.requestedModel, 128),
            "zcode.model_call.reasoning_capability": safeEnum(input.requested.reasoning.capability),
            "zcode.model_call.reasoning_requested_state": safeEnum(
              input.requested.reasoning.requestedState,
            ),
            "zcode.model_call.reasoning_requested_control": safeEnum(
              input.requested.reasoning.requestedControl,
            ),
            "zcode.model_call.reasoning_requested_level": safeString(
              input.requested.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_call.reasoning_requested_budget_tokens": integer(
              input.requested.reasoning.requestedBudgetTokens,
            ),
            "zcode.model_call.call_cause": safeEnum(input.callCause),
            "zcode.model_call.previous_logical_call_id": safeId(input.previousLogicalCallId),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "model_call",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new ModelCallWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "model_call"),
            },
            this.health,
            this.metrics,
            modelCallMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
            (writer, attempt) => this.startAttempt(writer, attempt),
            safeId(input.logicalCallId),
            safeEnum(input.operation),
            safeEnum(input.modelRole),
          ),
        );
      },
      NOOP_MODEL_CALL_WRITER,
    );
  }

  abandonSession(sessionId: string): void {
    for (const writer of this.activeWriters) {
      if (writer.state.correlation?.sessionId === sessionId) {
        writer.abandon("session_shutdown");
      }
    }
  }

  abandonProcess(): void {
    for (const writer of this.activeWriters) writer.abandon("process_shutdown");
  }

  private startCommand(
    input: CommandTraceStart & { parent: ToolWriter },
  ): CommandExecutionSpanWriter {
    const parent = input.parent.state;
    return this.safeCreate(
      "command_execution",
      () => {
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.command_execution.safe_name": safeString(input.safeName, 128),
            "zcode.command_execution.category": safeEnum(input.category),
            "zcode.command_execution.command_count": integer(input.commandCount),
            "zcode.command_execution.shell_kind": safeEnum(input.shellKind),
            "zcode.command_execution.sandboxed": input.sandboxed,
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          parent,
          spanName: "command_execution",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new CommandWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "command_execution"),
            this.health,
            this.metrics,
            commandMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMMAND_WRITER,
    );
  }

  private startAttempt(
    parentWriter: ModelCallWriter,
    input: ModelAttemptTraceStart,
  ): ModelAttemptSpanWriter {
    const parent = parentWriter.state;
    return this.safeCreate(
      "model_attempt",
      () => {
        const target = input.target;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.execution.logical_call_id": parentWriter.logicalCallId,
            "zcode.execution.model_operation": parentWriter.operation,
            "zcode.execution.model_role": parentWriter.modelRole,
            "zcode.model_attempt.request_id": safeId(input.requestId),
            "zcode.model_attempt.attempt_number": integer(input.attemptNumber),
            "zcode.model_attempt.max_attempts": integer(input.maxAttempts),
            "zcode.model_attempt.attempt_cause": safeEnum(input.attemptCause),
            "zcode.model_attempt.previous_request_id": safeId(input.previousRequestId),
            "zcode.model_attempt.retry_delay_ms": finiteNonNegative(input.retryDelayMs),
            "zcode.model_attempt.provider_id": safeString(target.providerId, 128),
            "zcode.model_attempt.provider_kind": safeEnum(target.providerKind),
            "zcode.model_attempt.provider_origin": safeString(target.providerOrigin),
            "zcode.model_attempt.provider_route": safeString(target.providerRoute),
            "zcode.model_attempt.requested_model": safeString(target.requestedModel, 128),
            "zcode.model_attempt.transport": safeEnum(input.transport),
            "zcode.model_attempt.api_operation": safeEnum(input.apiOperation),
            "zcode.model_attempt.reasoning_capability": safeEnum(target.reasoning.capability),
            "zcode.model_attempt.reasoning_requested_state": safeEnum(
              target.reasoning.requestedState,
            ),
            "zcode.model_attempt.reasoning_requested_control": safeEnum(
              target.reasoning.requestedControl,
            ),
            "zcode.model_attempt.reasoning_requested_level": safeString(
              target.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_attempt.reasoning_requested_budget_tokens": integer(
              target.reasoning.requestedBudgetTokens,
            ),
            ...modelAttemptCompatibilityAttributes(target),
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          kind: SpanKind.CLIENT,
          parent,
          spanName: "model_attempt",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new ModelAttemptWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "model_attempt"),
            this.health,
            this.metrics,
            modelAttemptMetricLabels(input, parentWriter),
            () => parentWriter.recordAttemptFailed(),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_MODEL_ATTEMPT_WRITER,
    );
  }

  private startSpan(options: StartWriterOptions): Span {
    return this.tracer.startSpan(
      options.spanName,
      {
        attributes: options.attributes,
        kind: options.kind ?? SpanKind.INTERNAL,
        links: options.links,
      },
      options.context ?? context.active(),
    );
  }

  private track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      try {
        this.health.onWarning?.("Telemetry metric operation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Metric 与健康回调都属于旁路。
      }
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function terminalMetricLabels(
  labels: Attributes,
  observation: WriterTerminalObservation,
): Attributes {
  return compactAttributes({
    ...labels,
    error_category: observation.errorCategory,
  });
}

function turnMetricLabels(
  correlation: AgentTelemetryExecutionContext,
  inputSource: AgentTurnTraceStart["inputSource"],
): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation.actorKind),
    input_source: safeEnum(inputSource),
    launch_surface: safeEnum(correlation.launchSurface),
  });
}

function stepMetricLabels(correlation: AgentTelemetryExecutionContext | undefined): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation?.actorKind),
  });
}

function toolMetricLabels(toolName: string): Attributes {
  return {
    tool_name: safeString(toolName, 128),
  };
}

function commandMetricLabels(input: CommandTraceStart): Attributes {
  return compactAttributes({
    command_category: safeEnum(input.category),
    command_safe_name: safeString(input.safeName, 128),
  });
}

function compactionMetricLabels(input: CompactionTraceStart): Attributes {
  return compactAttributes({
    model_mode: safeEnum(input.modelMode),
    trigger: safeEnum(input.trigger),
  });
}

function detachedMetricLabels(input: DetachedOperationTraceStart): Attributes {
  return compactAttributes({
    execution_kind: safeEnum(input.executionKind),
    operation: safeEnum(input.operation),
  });
}

function modelCallMetricLabels(input: ModelCallTraceStart): Attributes {
  return compactAttributes({
    call_cause: safeEnum(input.callCause ?? "initial"),
    model_operation: safeEnum(input.operation),
    model_role: safeEnum(input.modelRole),
  });
}

function modelAttemptMetricLabels(
  input: ModelAttemptTraceStart,
  parent: ModelCallWriter,
): Attributes {
  return compactAttributes({
    model: safeString(input.target.requestedModel, 128),
    model_operation: parent.operation,
    model_role: parent.modelRole,
    provider_kind: safeEnum(input.target.providerKind),
    transport: safeEnum(input.transport),
  });
}

abstract class TrackedBaseWriter extends BaseSpanWriter {
  protected readonly metricLabels: Attributes;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    lifecycle: WriterLifecycleKeys,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    const terminalTarget: { writer?: TrackedBaseWriter } = {};
    super(span, parentContext, metadata, lifecycle, health, (outcome, durationMs, observation) => {
      const writer = terminalTarget.writer;
      if (writer) {
        // 终态 Metric 从 Writer 已记录的实时事实投影，覆盖显式 finish、业务异常、
        // missing_terminal 和进程回收；不能只埋在各 finishXxx 分支里留下缺口。
        writer.safe(() => onRemoved(writer));
        writer.safe(() => writer.recordTerminalDetailMetrics(outcome, observation));
        writer.safe(() =>
          metrics.recordSpanTerminal(
            metadata.spanName as AgentMetricSpanName,
            outcome,
            durationMs,
            terminalMetricLabels(metricLabels, observation),
            observation.abandonReason,
          ),
        );
      }
    });
    terminalTarget.writer = this;
    this.metricLabels = metricLabels;
  }

  abandon(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  protected recordTerminalDetailMetrics(
    _outcome: string,
    _observation: WriterTerminalObservation,
  ): void {}
}

function causationLink(
  causation: AgentTelemetryCausation,
  relation: "spawned_by" | "triggered_by" | "resumed_from",
): Link {
  return {
    attributes: {
      "zcode.link.relation": relation,
    },
    context: spanContextFromCausation(causation),
  };
}

class TurnWriter extends TrackedBaseWriter implements AgentTurnSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("agent_turn"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    resultType: "assistant_message" | "tool_request" | "no_output" | "other" = "other",
  ): void {
    this.finishCompletedIfOpen(() => this.setAttribute("zcode.agent_turn.result_type", resultType));
  }

  finishFailed(
    stage: "setup" | "agent_loop" | "finalize" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

class StepWriter extends TrackedBaseWriter implements AgentStepSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("agent_step"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    terminalReason:
      | "model_completed"
      | "tool_requested"
      | "turn_completed"
      | "compaction_requested",
  ): void {
    this.metricLabels.terminal_reason = terminalReason;
    this.finishCompletedIfOpen(() =>
      this.setAttribute("zcode.agent_step.terminal_reason", terminalReason),
    );
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "tool" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

class ToolWriter extends TrackedBaseWriter implements ToolExecutionSpanWriter {
  private permissionRequested = false;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createCommand: (
      input: CommandTraceStart & { parent: ToolWriter },
    ) => CommandExecutionSpanWriter,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("tool_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  markPermissionRequested(): void {
    if (this.permissionRequested) return;
    this.permissionRequested = true;
    this.addEvent("permission_requested");
  }

  setPermissionDecision(decision: "granted" | "denied" | "not_required"): void {
    this.setAttribute("zcode.tool_execution.permission_decision", decision);
    if (this.permissionRequested && decision !== "not_required") {
      this.addEvent("permission_decided", { decision });
    }
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.tool_execution.output_bytes", finiteNonNegative(bytes));
  }

  setOutputTruncated(truncated: boolean): void {
    this.setAttribute("zcode.tool_execution.output_truncated", truncated);
  }

  startCommand(input: CommandTraceStart): CommandExecutionSpanWriter {
    return this.createCommand({ ...input, parent: this });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDenied(reason: "user_denied" | "policy_denied" | "unavailable" | "unknown"): void {
    this.finishDomainOutcomeIfOpen("denied", () =>
      this.setAttribute("zcode.tool_execution.permission_denial_reason", reason),
    );
  }

  finishFailed(
    stage:
      | "lookup"
      | "validation"
      | "permission"
      | "pre_hook"
      | "handler"
      | "post_hook"
      | "serialize"
      | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

class CommandWriter extends TrackedBaseWriter implements CommandExecutionSpanWriter {
  private firstOutput = false;
  private firstOutputMs: number | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("command_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  markFirstOutput(): void {
    if (this.firstOutput) return;
    this.firstOutput = true;
    const elapsed = this.elapsedMs();
    this.firstOutputMs = elapsed;
    this.setAttribute("zcode.command_execution.first_output_ms", elapsed);
    this.addEvent("first_output");
  }

  markTerminationRequested(reason: "cancelled" | "timeout" | "shutdown"): void {
    this.addEvent("termination_requested", { reason });
  }

  setExitCode(exitCode: number): void {
    const normalized = integer(exitCode);
    this.setAttribute("zcode.command_execution.exit_code", normalized);
    this.setAttributes(commandCompatibilityAttributes({ exitCode: normalized }));
  }

  setSignal(signal: string): void {
    const normalized = safeIdentifier(signal);
    this.setAttribute("zcode.command_execution.signal", normalized);
    this.setAttributes(commandCompatibilityAttributes({ signal: normalized }));
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.command_execution.output_bytes", finiteNonNegative(bytes));
  }

  setTimedOut(timedOut: boolean): void {
    this.setAttribute("zcode.command_execution.timed_out", timedOut);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "prepare" | "spawn" | "execute" | "timeout" | "collect_output" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  finishBackgrounded(): void {
    this.finishDomainOutcomeIfOpen("backgrounded");
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    if (this.firstOutputMs === undefined) return;
    this.metrics.recordCommandFirstOutput(
      this.firstOutputMs,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
    );
  }
}

class CompactionWriter extends TrackedBaseWriter implements ContextCompactionSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("context_compaction"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setInputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.input_tokens", finiteNonNegative(tokens));
  }

  setOutputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.output_tokens", finiteNonNegative(tokens));
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeEnum(reason) });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "parse" | "commit" | "fallback" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

class DetachedWriter extends TrackedBaseWriter implements DetachedOperationSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("detached_operation"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setResultType(resultType: "text" | "boolean" | "metadata" | "other"): void {
    this.setAttribute("zcode.detached_operation.result_type", resultType);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "schedule" | "execute" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

class ModelCallWriter extends TrackedBaseWriter implements ModelCallSpanWriter {
  private attemptCount = 0;
  private hadFailedAttempt = false;
  readonly logicalCallId: string | undefined;
  readonly modelRole: string | undefined;
  readonly operation: string | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createAttempt: (
      writer: ModelCallWriter,
      input: ModelAttemptTraceStart,
    ) => ModelAttemptSpanWriter,
    logicalCallId: string | undefined,
    operation: string | undefined,
    modelRole: string | undefined,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_call"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
    this.logicalCallId = logicalCallId;
    this.operation = operation;
    this.modelRole = modelRole;
  }

  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter {
    this.attemptCount += 1;
    return this.createAttempt(this, input);
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeString(reason, 128) });
  }

  recordAttemptFailed(): void {
    this.hadFailedAttempt = true;
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    const retryState =
      this.attemptCount <= 1
        ? "not_needed"
        : outcome === "completed" && this.hadFailedAttempt
          ? "recovered"
          : "not_recovered";
    this.metrics.recordModelCallAttempts(
      this.attemptCount,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
        retry_state: retryState,
      }),
    );
  }
}

class ModelAttemptWriter extends TrackedBaseWriter implements ModelAttemptSpanWriter {
  private firstContent = false;
  private firstContentMs: number | undefined;
  private firstProviderEvent = false;
  private firstProviderEventMs: number | undefined;
  private firstText = false;
  private firstTextMs: number | undefined;
  private stallCount = 0;
  private streamMaxIdleMs = 0;
  private readonly usage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    private readonly onAttemptFailed: () => void,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_attempt"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setProviderRequestId(requestId: string): void {
    this.setAttribute("zcode.model_attempt.provider_request_id", safeString(requestId, 256));
  }

  setResponseModel(model: ResponseModelTelemetryDescriptor): void {
    const value = safeString(model.model, 128);
    this.setAttribute("zcode.model_attempt.response_model", value);
    this.setAttributes(modelResponseCompatibilityAttributes({ responseModel: value }));
  }

  setEffectiveReasoningState(state: ModelReasoningState): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_state", safeEnum(state));
  }

  setEffectiveReasoningControl(control: ModelReasoningControlType): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_control", safeEnum(control));
  }

  setEffectiveReasoningLevel(level: string): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_level", safeString(level, 128));
  }

  setEffectiveReasoningBudgetTokens(tokens: number): void {
    this.setAttribute(
      "zcode.model_attempt.reasoning_effective_budget_tokens",
      finiteNonNegative(tokens),
    );
  }

  setFinishReason(reason: ModelFinishReason): void {
    const value = safeString(reason, 128);
    this.setAttribute("zcode.model_attempt.finish_reason", value);
    this.setAttributes(modelResponseCompatibilityAttributes({ finishReason: value }));
  }

  setInputTokens(tokens: number): void {
    this.setUsage("inputTokens", "input", tokens, "zcode.model_attempt.input_tokens");
    this.setAttributes(modelResponseCompatibilityAttributes({ inputTokens: tokens }));
  }

  setOutputTokens(tokens: number): void {
    this.setUsage("outputTokens", "output", tokens, "zcode.model_attempt.output_tokens");
    this.setAttributes(modelResponseCompatibilityAttributes({ outputTokens: tokens }));
  }

  setReasoningTokens(tokens: number): void {
    this.setUsage("reasoningTokens", "reasoning", tokens, "zcode.model_attempt.reasoning_tokens");
  }

  setCacheReadTokens(tokens: number): void {
    this.setUsage("cacheReadTokens", "cache_read", tokens, "zcode.model_attempt.cache_read_tokens");
  }

  setCacheWriteTokens(tokens: number): void {
    this.setUsage(
      "cacheWriteTokens",
      "cache_write",
      tokens,
      "zcode.model_attempt.cache_write_tokens",
    );
  }

  setStreamOutputCommitted(committed: boolean): void {
    this.setAttribute("zcode.model_attempt.stream_output_committed", committed);
  }

  setHttpStatusCode(statusCode: number): void {
    const normalized = integer(statusCode);
    this.setAttribute("zcode.model_attempt.http_status_code", normalized);
    this.setAttributes(httpResponseCompatibilityAttributes(statusCode));
  }

  setProviderErrorCode(code: string): void {
    this.setAttribute("zcode.model_attempt.provider_error_code", safeString(code, 128));
  }

  setProviderErrorMessage(message: string): void {
    this.setAttribute("zcode.model_attempt.provider_error_message", sanitizeErrorMessage(message));
  }

  setRetryAfterMs(delayMs: number): void {
    this.setAttribute("zcode.model_attempt.retry_after_ms", finiteNonNegative(delayMs));
  }

  markFirstProviderEvent(): void {
    if (this.firstProviderEvent) return;
    this.firstProviderEvent = true;
    const elapsed = this.elapsedMs();
    this.firstProviderEventMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_provider_event_ms", elapsed);
    this.addEvent("first_provider_event");
  }

  markFirstContent(): void {
    if (this.firstContent) return;
    this.firstContent = true;
    const elapsed = this.elapsedMs();
    this.firstContentMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_content_ms", elapsed);
    this.addEvent("first_content");
  }

  markFirstText(): void {
    if (this.firstText) return;
    this.firstText = true;
    const elapsed = this.elapsedMs();
    this.firstTextMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_text_ms", elapsed);
    this.addEvent("first_text");
  }

  markStreamStalled(idleMs: number): void {
    const normalized = finiteNonNegative(idleMs);
    if (normalized === undefined) return;
    this.stallCount += 1;
    this.streamMaxIdleMs = Math.max(this.streamMaxIdleMs, normalized);
    this.addEvent("stream_stalled", { idle_ms: normalized });
  }

  recordRequestObservation(observation: ModelRequestObservation): void {
    recordRequestObservation(
      {
        setAttribute: (name, value) => this.setAttribute(name, value),
        addEvent: (name, attributes) => this.addEvent(name, attributes),
      },
      observation,
    );
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelAttemptFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.onAttemptFailed();
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.onAttemptFailed();
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  private setUsage(
    field: keyof ModelAttemptWriter["usage"],
    tokenType: ModelTokenType,
    value: number,
    attribute: string,
  ): void {
    const normalized = finiteNonNegative(value);
    if (normalized === undefined) return;
    const delta = normalized - this.usage[field];
    if (delta < 0) return;
    this.usage[field] = normalized;
    this.safe(() => this.metrics.recordModelTokenDelta(tokenType, delta, this.metricLabels));
    this.setAttribute(attribute, normalized);
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    this.metrics.recordModelAttemptDetail(
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
      {
        firstContentMs: this.firstContentMs,
        firstProviderEventMs: this.firstProviderEventMs,
        firstTextMs: this.firstTextMs,
        stallCount: this.stallCount,
        streamMaxIdleMs: this.streamMaxIdleMs,
      },
    );
  }
}

function inheritedMetadata(
  parent: ActiveWriterContext | undefined,
  spanName: string,
): Omit<ActiveWriterContext, "activeContext" | "span"> {
  return {
    correlation: parent?.correlation,
    parent,
    spanName,
    toolCallId: parent?.toolCallId,
  };
}

function lifecycleKeys(spanName: string): WriterLifecycleKeys {
  const prefix = `zcode.${spanName}`;
  return {
    abandonReason: `${prefix}.abandon_reason`,
    cancelReason: `${prefix}.cancel_reason`,
    errorCategory: `${prefix}.error_category`,
    errorCode: `${prefix}.error_code`,
    errorMessage: `${prefix}.error_message`,
    errorType: `${prefix}.error_type`,
    failureStage: `${prefix}.failure_stage`,
    outcome: `${prefix}.outcome`,
  };
}

function classifyErrorCategory(error: unknown): AgentTelemetryErrorCategory {
  if (isAbortLike(error)) return "cancelled";
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  const code = String(record.code ?? "").toLowerCase();
  if (code.includes("timeout")) return "timeout";
  if (
    code.includes("network") ||
    code.includes("econn") ||
    code.includes("enotfound") ||
    code.includes("tls")
  ) {
    return "network";
  }
  return "unknown";
}

const NOOP_SCOPE = {
  captureCausation: () => undefined,
  run: <T>(execute: () => T): T => execute(),
};

const NOOP_COMMAND_WRITER: CommandExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishBackgrounded() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstOutput() {},
  markTerminationRequested() {},
  setExitCode() {},
  setOutputBytes() {},
  setSignal() {},
  setTimedOut() {},
};

const NOOP_TOOL_WRITER: ToolExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDenied() {},
  finishFailed() {},
  markPermissionRequested() {},
  setOutputBytes() {},
  setOutputTruncated() {},
  setPermissionDecision() {},
  startCommand: () => NOOP_COMMAND_WRITER,
};

const NOOP_STEP_WRITER: AgentStepSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
};

const NOOP_TURN_WRITER: AgentTurnSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
};

const NOOP_COMPACTION_WRITER: ContextCompactionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
  markFallbackSelected() {},
  setInputTokens() {},
  setOutputTokens() {},
};

const NOOP_DETACHED_WRITER: DetachedOperationSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  setResultType() {},
};

const NOOP_MODEL_ATTEMPT_WRITER: ModelAttemptSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstContent() {},
  markFirstProviderEvent() {},
  markFirstText() {},
  markStreamStalled() {},
  recordRequestObservation() {},
  setCacheReadTokens() {},
  setCacheWriteTokens() {},
  setEffectiveReasoningBudgetTokens() {},
  setEffectiveReasoningControl() {},
  setEffectiveReasoningLevel() {},
  setEffectiveReasoningState() {},
  setFinishReason() {},
  setHttpStatusCode() {},
  setInputTokens() {},
  setOutputTokens() {},
  setProviderErrorCode() {},
  setProviderErrorMessage() {},
  setProviderRequestId() {},
  setReasoningTokens() {},
  setResponseModel() {},
  setRetryAfterMs() {},
  setStreamOutputCommitted() {},
};

const NOOP_MODEL_CALL_WRITER: ModelCallSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFallbackSelected() {},
  startAttempt: () => NOOP_MODEL_ATTEMPT_WRITER,
};

export class NoopAgentExecutionTelemetry
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  abandonSession(): void {}
  captureCausation() {
    return undefined;
  }
  startCall(): ModelCallSpanWriter {
    return NOOP_MODEL_CALL_WRITER;
  }
  startCompaction(): ContextCompactionSpanWriter {
    return NOOP_COMPACTION_WRITER;
  }
  startDetachedOperation(): DetachedOperationSpanWriter {
    return NOOP_DETACHED_WRITER;
  }
  startStep(): AgentStepSpanWriter {
    return NOOP_STEP_WRITER;
  }
  startTool(): ToolExecutionSpanWriter {
    return NOOP_TOOL_WRITER;
  }
  startTurn(): AgentTurnSpanWriter {
    return NOOP_TURN_WRITER;
  }
}
