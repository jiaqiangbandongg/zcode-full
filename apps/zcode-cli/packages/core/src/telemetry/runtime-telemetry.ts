import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentTelemetryActorKind,
  AgentTelemetryCausation,
  AgentTelemetryLaunchSurface,
  AgentTurnSpanWriter,
  CommandExecutionSpanWriter,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  MessageId,
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
  SessionId,
  SessionTaskType,
  SyntheticUserMessageSource,
  ToolExecutionSpanWriter,
  TraceContext,
} from "@zcode/contracts";

interface RuntimeTelemetryFacadeOptions {
  agentName?: string;
  causation?: AgentTelemetryCausation;
  causationMode?: "child" | "linked_root";
  launchSurface?: AgentTelemetryLaunchSurface;
  parentSessionId?: SessionId;
  port?: AgentExecutionTelemetryPort;
  sessionId: SessionId;
  taskType?: SessionTaskType;
}

export class RuntimeTelemetryFacade {
  readonly port: AgentExecutionTelemetryPort;
  readonly actorKind: AgentTelemetryActorKind;
  private readonly agentName?: string;
  private readonly causation?: AgentTelemetryCausation;
  private readonly causationMode?: "child" | "linked_root";
  private readonly launchSurface: AgentTelemetryLaunchSurface;
  private readonly parentSessionId?: string;
  private readonly parentTurnId?: string;
  private readonly sessionId: SessionId;

  constructor(options: RuntimeTelemetryFacadeOptions) {
    this.port = options.port ?? NOOP_AGENT_EXECUTION_TELEMETRY;
    this.actorKind = actorKindFromTaskType(options.taskType);
    this.agentName = options.agentName;
    this.causation = options.causation;
    this.causationMode = options.causationMode;
    this.launchSurface = options.launchSurface ?? "standalone_cli";
    this.parentSessionId = options.parentSessionId ?? options.causation?.sessionId;
    this.parentTurnId = options.causation?.turnId;
    this.sessionId = options.sessionId;
  }

  captureCausation(): AgentTelemetryCausation | undefined {
    return this.port.captureCausation();
  }

  turn(input: {
    inputSource?: SyntheticUserMessageSource;
    traceContext: TraceContext;
    turnNumber: number;
  }): AgentTurnSpanWriter {
    return this.port.startTurn({
      causation: this.causation,
      causationMode: this.causationMode,
      context: this.executionContext(input.traceContext),
      inputSource: normalizeInputSource(input.inputSource),
      turnNumber: input.turnNumber,
    });
  }

  step(input: { stepId: MessageId; stepIndex: number }): AgentStepSpanWriter {
    return this.port.startStep({
      stepId: input.stepId,
      stepIndex: input.stepIndex,
    });
  }

  compaction(
    input: CompactionTraceStart & { traceContext?: TraceContext },
  ): ContextCompactionSpanWriter {
    return this.port.startCompaction(input);
  }

  detached(
    input: Omit<DetachedOperationTraceStart, "causation" | "context"> & {
      causation?: AgentTelemetryCausation;
      traceContext: TraceContext;
    },
  ): DetachedOperationSpanWriter {
    return this.port.startDetachedOperation({
      ...input,
      causation: input.causation ?? this.captureCausation(),
      context: this.executionContext(input.traceContext),
    });
  }

  private executionContext(traceContext: TraceContext) {
    return {
      actorKind: this.actorKind,
      agentName: this.agentName,
      launchSurface: this.launchSurface,
      parentSessionId: this.parentSessionId,
      parentTurnId: this.parentTurnId,
      queryId: traceContext.queryId,
      sessionId: traceContext.sessionId ?? this.sessionId,
      turnId: traceContext.turnId,
    };
  }
}

const NOOP_SCOPE = {
  captureCausation: () => undefined,
  run: <T>(execute: () => T): T => execute(),
};

const NOOP_COMMAND: CommandExecutionSpanWriter = {
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

const NOOP_TOOL: ToolExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDenied() {},
  finishFailed() {},
  markPermissionRequested() {},
  setOutputBytes() {},
  setOutputTruncated() {},
  setPermissionDecision() {},
  startCommand: () => NOOP_COMMAND,
};

const NOOP_STEP: AgentStepSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
};

const NOOP_TURN: AgentTurnSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
};

const NOOP_COMPACTION: ContextCompactionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
  markFallbackSelected() {},
  setInputTokens() {},
  setOutputTokens() {},
};

const NOOP_DETACHED: DetachedOperationSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  setResultType() {},
};

const NOOP_ATTEMPT: ModelAttemptSpanWriter = {
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

const NOOP_CALL: ModelCallSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFallbackSelected() {},
  startAttempt: () => NOOP_ATTEMPT,
};

const NOOP_AGENT_EXECUTION_TELEMETRY: AgentExecutionTelemetryPort = {
  abandonSession() {},
  captureCausation() {
    return undefined;
  },
  startCompaction() {
    return NOOP_COMPACTION;
  },
  startDetachedOperation() {
    return NOOP_DETACHED;
  },
  startStep() {
    return NOOP_STEP;
  },
  startTool() {
    return NOOP_TOOL;
  },
  startTurn() {
    return NOOP_TURN;
  },
};

function actorKindFromTaskType(taskType: SessionTaskType | undefined): AgentTelemetryActorKind {
  if (taskType === "subagent_child") return "subagent";
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return "workflow_child";
  }
  return "main";
}

function normalizeInputSource(
  inputSource: SyntheticUserMessageSource | undefined,
): "user" | SyntheticUserMessageSource {
  return inputSource ?? "user";
}
