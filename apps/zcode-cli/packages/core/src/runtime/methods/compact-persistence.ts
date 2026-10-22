import {
  CompactTrigger,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  SessionEventType,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MessageId,
  MessageWithParts,
  Model,
  PartId,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  compactFailureReasonFromError,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { CompactTimelineContext } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  persistRuntimeReminderMessage,
  removeRuntimePersistenceMessagesBestEffort,
  resolvePersistedReminderModel,
} from "./runtime-reminder-persistence.js";

export function buildCompactTimelinePayload(
  this: AgentRuntimeInternal,
  timeline: CompactTimelineContext,
  update: {
    attempt?: number;
    boundaryId?: string;
    endedAt?: number;
    maxAttempts?: number;
    postCompactTokenCount?: number;
    reason?: string;
    replace?: boolean;
    status: CompactTimelineStatus;
    summaryMessageId?: MessageId;
    tailStartMessageId?: MessageId;
    truePostCompactTokenCount?: number;
  },
): CompactTimelinePayload {
  const payload: CompactTimelinePayload = {
    operationId: timeline.operationId,
    messageId: timeline.messageId,
    partId: timeline.partId,
    status: update.status,
    trigger: timeline.trigger,
    phase: timeline.phase,
    compactReason: timeline.compactReason,
    display: CompactTimelineDisplay.Separator,
    preCompactTokenCount: timeline.preCompactTokenCount,
    sourceCommandId: timeline.sourceCommandId,
    startedAt: timeline.startedAt,
  };
  if (update.replace !== undefined) payload.replace = update.replace;
  if (update.reason !== undefined) payload.reason = update.reason;
  if (update.attempt !== undefined) payload.attempt = update.attempt;
  if (update.maxAttempts !== undefined) payload.maxAttempts = update.maxAttempts;
  if (update.boundaryId !== undefined) payload.boundaryId = update.boundaryId;
  if (update.summaryMessageId !== undefined) payload.summaryMessageId = update.summaryMessageId;
  if (update.tailStartMessageId !== undefined) {
    payload.tailStartMessageId = update.tailStartMessageId;
  }
  if (update.postCompactTokenCount !== undefined) {
    payload.postCompactTokenCount = update.postCompactTokenCount;
  }
  if (update.truePostCompactTokenCount !== undefined) {
    payload.truePostCompactTokenCount = update.truePostCompactTokenCount;
  }
  if (update.endedAt !== undefined) payload.endedAt = update.endedAt;
  return payload;
}

export async function persistCompactTimeline(
  this: AgentRuntimeInternal,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  const created = payload.startedAt ?? Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: this.sessionId,
    messageID: payload.messageId,
    partID: compactTimelinePartId(payload),
    created,
    completed: payload.endedAt,
    finish: payload.status,
    timeline: {
      timelineType: "context_compaction",
      display: payload.display,
      status: payload.status,
      operationId: payload.operationId,
      sourceCommandId: payload.sourceCommandId,
      trigger: payload.trigger,
      phase: payload.phase,
      compactReason: payload.compactReason,
      boundaryId: payload.boundaryId,
      summaryMessageId: payload.summaryMessageId,
      preCompactTokenCount: payload.preCompactTokenCount,
      postCompactTokenCount: payload.postCompactTokenCount,
      truePostCompactTokenCount: payload.truePostCompactTokenCount,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      reason: payload.reason,
      time: {
        start: payload.startedAt,
        end: payload.endedAt,
      },
    },
    traceContext,
  });
  await this.persistPart(
    {
      id: payload.partId ?? createPartId(),
      sessionID: this.sessionId,
      messageID: payload.messageId,
      type: "compaction",
      auto: payload.trigger === CompactTrigger.Auto,
      trigger: payload.trigger,
      phase: payload.phase,
      compactReason: payload.compactReason,
      operationId: payload.operationId,
      timelineStatus: payload.status,
      timelineDisplay: payload.display,
      replace: payload.replace,
      reason: payload.reason,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      boundaryId: payload.boundaryId,
      summaryMessageId: payload.summaryMessageId,
      tail_start_id: payload.tailStartMessageId,
      preCompactTokenCount: payload.preCompactTokenCount,
      postCompactTokenCount: payload.postCompactTokenCount,
      truePostCompactTokenCount: payload.truePostCompactTokenCount,
      time: {
        start: payload.startedAt,
        end: payload.endedAt,
      },
    },
    traceContext,
  );
}

function compactTimelinePartId(payload: CompactTimelinePayload): PartId {
  return createPartId(`${String(payload.partId ?? payload.operationId)}_timeline`);
}

export async function finishCompactTimelineFailure(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    attempt?: number;
    error: unknown;
    events: SessionEvent[];
    maxAttempts?: number;
    timeline: CompactTimelineContext;
    traceContext: TraceContext;
  },
): Promise<void> {
  const status = isTurnCancellationError(options.error, options.abortSignal)
    ? CompactTimelineStatus.Interrupted
    : CompactTimelineStatus.Failed;
  const payload = this.buildCompactTimelinePayload(options.timeline, {
    attempt: options.attempt,
    endedAt: Date.now(),
    maxAttempts: options.maxAttempts,
    reason: compactFailureReasonFromError(options.error),
    replace: true,
    status,
  });

  try {
    await this.persistCompactTimeline(payload, options.traceContext);
    const event = this.createEvent(SessionEventType.CompactFailed, payload, options.traceContext);
    await this.appendEvent(event, options.traceContext);
    options.events.push(event);
  } catch (timelineError) {
    this.logger?.warn("Compact timeline failure state could not be persisted", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: timelineError instanceof Error ? timelineError.message : String(timelineError),
      event: "compact.timeline.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function recoverInterruptedCompactTimelines(
  this: AgentRuntimeInternal,
  messages: MessageWithParts[],
  traceContext: TraceContext,
): Promise<number> {
  if (!this.sessionStore) return 0;

  const boundaryByOperationId = new Map<string, CompactBoundaryPayload>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction" || !part.operationId || !part.compactBoundary) continue;
      boundaryByOperationId.set(part.operationId, part.compactBoundary);
    }
  }

  let recovered = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type !== "compaction" ||
        !isRecoverableRunningCompactTimelineStatus(part.timelineStatus) ||
        !part.operationId
      ) {
        continue;
      }

      const boundary = boundaryByOperationId.get(part.operationId);
      const status = boundary ? CompactTimelineStatus.Completed : CompactTimelineStatus.Interrupted;
      const timeline: CompactTimelineContext = {
        operationId: part.operationId,
        messageId: part.messageID,
        partId: part.id,
        trigger: part.trigger ?? CompactTrigger.Manual,
        phase:
          part.phase ??
          boundary?.phase ??
          defaultCompactPhaseForTrigger(part.trigger ?? CompactTrigger.Manual),
        compactReason:
          part.compactReason ??
          boundary?.compactReason ??
          defaultCompactReasonForTrigger(part.trigger ?? CompactTrigger.Manual),
        startedAt: part.time?.start ?? message.info.time.created,
        preCompactTokenCount: part.preCompactTokenCount,
      };
      const payload = this.buildCompactTimelinePayload(timeline, {
        attempt: part.attempt,
        boundaryId: boundary?.boundaryId,
        endedAt: Date.now(),
        maxAttempts: part.maxAttempts,
        postCompactTokenCount: boundary?.postCompactTokenCount,
        replace: true,
        status,
        summaryMessageId: boundary?.summaryMessageIds[0],
        tailStartMessageId: boundary?.lastSummarizedMessageId,
        truePostCompactTokenCount: boundary?.truePostCompactTokenCount,
      });
      await this.persistCompactTimeline(payload, traceContext);
      Object.assign(part, {
        timelineStatus: payload.status,
        phase: payload.phase,
        compactReason: payload.compactReason,
        replace: payload.replace,
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        boundaryId: payload.boundaryId,
        summaryMessageId: payload.summaryMessageId,
        tail_start_id: payload.tailStartMessageId,
        postCompactTokenCount: payload.postCompactTokenCount,
        truePostCompactTokenCount: payload.truePostCompactTokenCount,
        time: {
          start: payload.startedAt,
          end: payload.endedAt,
        },
      });
      recovered += 1;
    }
  }

  return recovered;
}

function isRecoverableRunningCompactTimelineStatus(
  status: CompactTimelineStatus | undefined,
): boolean {
  // 自动 compact retry 会把同一个 timeline 持久化成 retrying；
  // 进程在 retry 间隔退出时，resume 必须把它和 started 一样收敛为 interrupted/completed。
  return status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying;
}

export async function persistCompactSummary(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  content: string,
  summary: string,
  compactBoundary: CompactBoundaryPayload,
  traceContext: TraceContext,
  options?: {
    model?: Model;
    operationId?: string;
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
  },
): Promise<void> {
  if (!this.sessionStore) return;

  const created = Date.now();
  const persistedModel = resolvePersistedReminderModel(this, options?.model);
  // compact summary 和后续 reminder 是同一次历史替换；任一步失败都要一起回滚。
  const persistedMessageIds: MessageId[] = [messageID];
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: {
          created,
        },
        summary: {
          title: "Compact summary",
          body: summary,
          diffs: [],
        },
        agent: this.config.agentName ?? "zcode-agent",
        modelSelection: persistedModel,
        semantics: {
          origin: "agent_runtime",
          kind: "compact_summary",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "compaction",
        auto: compactBoundary.trigger === "auto",
        trigger: compactBoundary.trigger,
        phase: compactBoundary.phase,
        compactReason: compactBoundary.compactReason,
        tail_start_id: compactBoundary.lastSummarizedMessageId,
        compactBoundary,
        operationId: options?.operationId,
      },
      traceContext,
    );
    for (const entry of options?.postCompactReminderEntries ?? []) {
      const reminderMessageId = await persistRuntimeReminderMessage.call(
        this,
        entry,
        traceContext,
        {
          created,
          model: options?.model,
        },
      );
      if (reminderMessageId) persistedMessageIds.push(reminderMessageId);
    }
  } catch (error) {
    await removeRuntimePersistenceMessagesBestEffort.call(this, persistedMessageIds, traceContext);
    throw error;
  }
}
