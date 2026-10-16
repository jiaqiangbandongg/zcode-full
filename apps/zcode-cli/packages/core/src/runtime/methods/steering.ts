import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createMessageId,
  createQueryId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CollaborationMode,
  MessageId,
  ModelSelection,
  ModelSelectionOrigin,
  PendingSteerInputInfo,
  PendingTurnInput,
  QueryId,
  SessionEvent,
  TraceContext,
  TurnSteerInput,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  buildUserContentFromTurn,
  measureUtf8Bytes,
  MAX_TURN_STEER_INPUT_BYTES,
  previewInput,
  resolveTurnAttachments,
} from "../helpers/index.js";
import type {
  ActiveTurnKind,
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
} from "../types.js";
import {
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

function hasSteerInput(request: Pick<TurnSteerInput, "attachments" | "input" | "intent">): boolean {
  return (
    request.input.trim().length > 0 ||
    Boolean(request.attachments?.length) ||
    Boolean(request.intent?.conversationQuotes?.length)
  );
}

export async function steerTurn(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const activeTurn = this.activeTurn;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);

  // 附件输入可以没有正文；旧校验只看 input，导致已 accepted 的附件无法进入权威 queue。
  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn) {
    return await this.rejectTurnSteer("no_active_turn", {
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (request.expectedTurnId !== undefined && request.expectedTurnId !== activeTurn.turnId) {
    return await this.rejectTurnSteer("expected_turn_mismatch", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn.steerable) {
    return await this.rejectTurnSteer("turn_not_steerable", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery;
  const toolDisallowlist = request.toolDisallowlist;
  const queuePosition = activeTurn.pendingInputs.length;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: request.delivery ?? request.intent.admittedDelivery,
        queuePosition,
      }
    : undefined;
  const pendingInput: PendingTurnInput = {
    id:
      request.pendingInputId ??
      request.intent?.queueItemId ??
      this.createPendingInputId(activeTurn.turnId),
    input: request.input,
    queuedAt: new Date(),
    traceId: activeTurn.traceContext.traceId,
    queryId,
    ...(commandKind ? { commandKind } : {}),
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    ...(delivery ? { delivery } : {}),
    ...(intent ? { intent } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(toolDisallowlist ? { toolDisallowlist } : {}),
    turnId: activeTurn.turnId,
  };
  activeTurn.pendingInputs.push(pendingInput);
  const queueLength = activeTurn.pendingInputs.length;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      inputId: request.inputId,
      queryId,
      pendingInputId: pendingInput.id,
      input: pendingInput.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      ...(delivery ? { delivery } : {}),
      ...(intent ? { intent } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId: activeTurn.turnId,
      queueLength,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, activeTurn.traceContext);
  this.logger?.debug("Turn steer queued", {
    ...traceContextToLogContext(activeTurn.traceContext),
    activeTurnKind: activeTurn.kind,
    activeTurnSteerable: activeTurn.steerable,
    inputId: request.inputId,
    queryId,
    event: "turn.steer.queued",
    expectedTurnId: request.expectedTurnId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId: pendingInput.id,
    queueLength,
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    status: "waiting",
    targetTurnId: activeTurn.turnId,
  });

  return {
    kind: "queued",
    pendingInputId: pendingInput.id,
    queueLength,
    turnId: activeTurn.turnId,
  };
}

export async function enqueueDeferredInput(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);
  const traceContext = request.traceContext ?? this.rootTraceContext;

  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  const targetTurnId =
    this.activeTurn?.turnId ??
    this.latestAssistantTurnId ??
    traceContext.turnId ??
    ("deferred" as TurnId);
  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery ?? "queue";
  const toolDisallowlist = request.toolDisallowlist;
  const pendingInputId =
    request.pendingInputId ??
    request.intent?.queueItemId ??
    this.createPendingInputId(targetTurnId);
  const projection = await this.rebuildProjection();
  const queueLength = projection.pendingSteerInputs.length + 1;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: delivery,
        queuePosition: queueLength - 1,
      }
    : undefined;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      ...(request.inputId ? { inputId: request.inputId } : {}),
      queryId,
      pendingInputId,
      input: request.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      delivery,
      ...(intent ? { intent } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId,
      queueLength,
    },
    {
      traceId: traceContext.traceId,
      turnId: targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Deferred input queued", {
    ...traceContextToLogContext(traceContext),
    delivery,
    event: "turn.deferred_input.queued",
    inputId: request.inputId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId,
    queueLength,
    status: "waiting",
    targetTurnId,
  });

  return {
    kind: "queued",
    pendingInputId,
    queueLength,
    turnId: targetTurnId,
  };
}

export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
  }
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

function pendingInputDelivery(pendingInput: PendingTurnInput | undefined): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs 同时承载 future queue 与 current-turn guide，只检查
  // 数组队首，导致先入队的普通消息把后续显式 guide 永久挡住。delivery 才是消费车道；
  // 这里只在 guide 子序列内保持 admission FIFO，普通 queue 留在原位等待外层提升。
  return activeTurn.pendingInputs.findIndex(
    (pendingInput) =>
      pendingInput.commandKind !== "sendGoalCommand" &&
      pendingInput.commandKind !== "compact" &&
      pendingInputDelivery(pendingInput) === "guide",
  );
}

export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 * 当前 product turn 被 stop/interrupted，或 FIFO barrier 阻止安全 inline 时，把尚未消费的
 * guide 原地改投普通 queue。正常可消费的 text-only guide 仍在当前 active turn 内续跑。
 */
export async function fallbackPendingGuidesToQueue(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  },
): Promise<number> {
  if (this.activeTurn !== options.activeTurn) return 0;
  let changed = 0;
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (pendingInputDelivery(pendingInput) !== "guide") continue;
    const intent = pendingInput.intent
      ? {
          ...pendingInput.intent,
          admittedDelivery: "queue" as const,
          fallbackReasonCode: options.reasonCode,
        }
      : undefined;
    const event = this.createEvent(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        admittedDelivery: "queue",
        fallbackReasonCode: options.reasonCode,
        ...(intent ? { intent } : {}),
        pendingInputId: pendingInput.id,
        requestedDelivery: "guide",
        targetTurnId: options.activeTurn.turnId,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events?.push(event);
    pendingInput.delivery = "queue";
    if (intent) pendingInput.intent = intent;
    changed += 1;
    this.logger?.debug("Guide input fell back to ordinary queue", {
      ...traceContextToLogContext(options.traceContext),
      event: "turn.guide.fell_back",
      fallbackReasonCode: options.reasonCode,
      module: "core.runtime",
      pendingInputId: pendingInput.id,
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }
  return changed;
}

async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // 只删内存 queue/event 会留下 admitted 的 durable session_input。
  // LRU 淘汰后 commands/query 会退成 unknown，CLI restart 又会把用户主动删除误报为
  // inputDiscardedOnRestart。先写 cancelled 终态，失败时不允许 UI queue 先消失。
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}

export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.permissionFullAccessPending || this.pendingInputReservations.has(options.pendingInputId))
    return false;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // rebuildProjection 上方有 await；落锁前必须复查，避免两端同时读到未占用。
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // 事件写失败时 reservation 仍必须保持，不能让第二端重复执行。
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}

/**
 * （v4 queue 单项管理）：按 id 从当前 active turn 的 pendingInputs 移除一条，
 * 发 TurnSteerDiscarded([id])。v4 ProductProjection 已消费该事件移除对应 queue row。
 * 旧架构 queue 是 renderer-local，无单项 op；v4 queue 移入 CLI 投影后需此原生能力。
 * 返回是否移除（未命中 id / 无 active turn → false）。
 */
export async function removePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const reservationId = this.pendingInputReservations.get(options.pendingInputId);
  if (reservationId && reservationId !== options.reservationId) return false;
  const activeTurn = this.activeTurn;
  const index =
    activeTurn?.pendingInputs.findIndex(
      (pendingInput) => pendingInput.id === options.pendingInputId,
    ) ?? -1;
  if (!activeTurn || index < 0) {
    // held 回落（stop/完成后 queue 保留成 held）：held 项只存在于
    // 事件日志/投影（active turn 已结束），按投影定位后补 TurnSteerDiscarded。
    return this.discardHeldPendingInputById(
      options.pendingInputId,
      options.traceContext,
      options.reservationId,
      options.reason,
    );
  }
  await settleRemovedSessionInput(this, options.pendingInputId, options.reason);
  activeTurn.pendingInputs.splice(index, 1);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [options.pendingInputId],
      reason: options.reason,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  this.pendingInputReservations.delete(options.pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(options.traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId: options.pendingInputId,
    status: "completed",
    targetTurnId: activeTurn.turnId,
  });
  return true;
}

/**
 * held 项按 id 丢弃（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * active turn 结束后 pendingInputs 内存态即消亡，held queue 的权威在事件日志——
 * 经投影反查该项仍未 drain/discard 后补 TurnSteerDiscarded(user_removed)。
 */
export async function discardHeldPendingInputById(
  this: AgentRuntimeInternal,
  pendingInputId: string,
  traceContext: TraceContext,
  reservationId?: string,
  reason: "user_removed" | "promoted" = "user_removed",
): Promise<boolean> {
  const currentReservation = this.pendingInputReservations.get(pendingInputId);
  if (currentReservation && currentReservation !== reservationId) return false;
  const projection = await this.rebuildProjection();
  const held = projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId);
  if (!held) return false;
  await settleRemovedSessionInput(this, pendingInputId, reason);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [pendingInputId],
      reason,
      targetTurnId: held.targetTurnId,
    },
    {
      traceId: traceContext.traceId,
      turnId: held.targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.pendingInputReservations.delete(pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId,
    status: "completed",
    targetTurnId: held.targetTurnId,
  });
  return true;
}

/**
 * 清空全部排队输入（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * 先摘 active turn 内存项（防后续 roundtrip drain），再按投影清扫 held 残留。
 * 返回丢弃条数。
 */
export async function clearAllPendingInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  let cleared = 0;
  const activeTurn = this.activeTurn;
  if (activeTurn && activeTurn.pendingInputs.length > 0) {
    for (const item of activeTurn.pendingInputs) {
      await settleRemovedSessionInput(this, item.id, "user_removed");
    }
    const removed = activeTurn.pendingInputs.splice(0);
    cleared += removed.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: removed.map((item) => item.id),
        reason: "user_removed",
        targetTurnId: activeTurn.turnId,
      },
      {
        traceId: activeTurn.traceContext.traceId,
        turnId: activeTurn.turnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  const projection = await this.rebuildProjection();
  const heldByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const item of projection.pendingSteerInputs) {
    const group = heldByTurn.get(item.targetTurnId) ?? [];
    group.push(item);
    heldByTurn.set(item.targetTurnId, group);
  }
  for (const [targetTurnId, group] of heldByTurn) {
    for (const item of group) {
      await settleRemovedSessionInput(this, item.pendingInputId, "user_removed");
    }
    cleared += group.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: group.map((item) => item.pendingInputId),
        reason: "user_removed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  return cleared;
}

/**
 * （v4 queue 单项编辑）：按 id 替换某排队输入的文本，重发 TurnSteerQueued（同 id）。
 * v4 reducer 的 onTurnSteerQueued 对同 id 原地更新（保位）。未命中 / 无 active turn → false。
 */
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    newText: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // held 回落：held 项只在事件日志/投影，经投影定位后
    // 重发同 id TurnSteerQueued（v4 reducer 原地更新，保位）。
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    if (!held) return false;
    await persistSessionInputUpdates(this, [{ id: held.pendingInputId, text: options.newText }]);
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input: options.newText,
        inputPreview: previewInput(options.newText),
        inputSize: measureUtf8Bytes(options.newText),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(held.intent ? { intent: { ...held.intent, text: options.newText } } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  await persistSessionInputUpdates(this, [{ id: pendingInput.id, text: options.newText }]);
  pendingInput.input = options.newText;
  // 编辑正文后必须同步 canonical text，否则结构化引用恢复时会显示旧正文。
  if (pendingInput.intent) pendingInput.intent = { ...pendingInput.intent, text: options.newText };
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: options.newText,
      inputPreview: previewInput(options.newText),
      inputSize: measureUtf8Bytes(options.newText),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 queue 重排）：把 pendingInputId 移到 beforePendingInputId 之前（null = 移到队尾），
 * 发 TurnSteerReordered(新序)。v4 reducer 按新序重排 queue rows。未命中 → false。
 */
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // held 回落：在投影序上重排后发 TurnSteerReordered（v4 reducer 按新序重排）。
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // 目标锚点已消失 → 退回队尾，不丢项。
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // 只重排数组而不更新 intent.queuePosition，会让 live queue 顺序正确，
  // 但 drain 后 transcript 又写回 admission 时的旧位置，造成冷热投影事实分叉。
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 setAutoDrain）：翻转 queue autoDrain 授权位（会话级配置，与 active turn 无关）。
 * 仅追加 QueueAutoDrainChanged 事件供 v4 投影消费；held 派生（completed+queue>0+autoDrain=false
 * → choice 路由）与后续 heldQueueDisposition 命令闭合发送语义。
 */
export async function setQueueAutoDrain(
  this: AgentRuntimeInternal,
  options: {
    autoDrain: boolean;
    traceContext: TraceContext;
  },
): Promise<void> {
  // false -> true 表示用户从暂停队列恢复。旧暂停项只存在于事件投影，不在新
  // activeTurn.pendingInputs 中；恢复期间改由 CLI 外层按完整投影 FIFO 逐项提升。
  if (options.autoDrain && !this.queueAutoDrain) {
    this.queueExternalDrainActive = true;
  } else if (!options.autoDrain) {
    this.queueExternalDrainActive = false;
  }
  // 授权位同时进 runtime（drain 门）与事件日志（投影派生暂停队列）。
  this.queueAutoDrain = options.autoDrain;
  const event = createSessionEvent(
    SessionEventType.QueueAutoDrainChanged,
    this.sessionId,
    { autoDrain: options.autoDrain },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/** CLI 投影确认恢复队列已空后，重新允许 core 在后续 tool batch 边界消费 guide。 */
export function completeExternalQueueDrain(this: AgentRuntimeInternal): void {
  this.queueExternalDrainActive = false;
}

/**
 * （v4 setFollowupMode）：翻转 followup 路由模式（会话级配置）。
 * 仅追加 FollowupModeChanged 事件供 v4 投影消费；running 时 computeInputRouting 依此在
 * enqueue（queue）与 guide 之间选择。
 */
export async function setFollowupMode(
  this: AgentRuntimeInternal,
  options: {
    mode: "queue" | "guide";
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.FollowupModeChanged,
    this.sessionId,
    { mode: options.mode },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 * （v4 switchModelConfig）：模型选型变化后追加 ModelSelected 事件供投影消费。
 * v4 reducer 的 onModelSelected 依此更新 config.provider/model/thought 和实际 context window，
 * 并（中途切换时）产出 modelChange marker。实际 provider client 切换由 app.setModel 完成，
 * 此处把切换后的完整模型能力元组写入同一个事件。
 */
export async function emitModelSelected(
  this: AgentRuntimeInternal,
  options: {
    modelSelection: ModelSelection;
    model?: import("../deps.js").Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  const model = options.model ?? createRuntimeModel(this, { selection: options.modelSelection });
  const event = createSessionEvent(
    SessionEventType.ModelSelected,
    this.sessionId,
    {
      // 模型切换事件必须从本次创建的 Active Model 读取窗口，不能再复制 Runtime Config。
      contextWindow: model.properties.contextWindow,
      modelSelection: cloneModelSelection(options.modelSelection),
      ...(options.effectiveReasoningLevel
        ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
        : {}),
      // previousModelSelection=null 是显式 ∅→X 模型边界，不能按 truthy 判断丢失。
      ...(options.previousModelSelection !== undefined
        ? {
            previousModelSelection: options.previousModelSelection
              ? cloneModelSelection(options.previousModelSelection)
              : null,
          }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.supportedThoughtLevels
        ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
        : {}),
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 * （v4 switchCollaborationMode）：命令面切换协作模式后追加 SessionModeChanged 事件。
 * app.setMode 只更新 runtime config + 持久化偏好、不产事件（session-mode-port 的
 * enterPlanMode/exitPlanMode 仅覆盖 plan 工具路径），v4 投影的 config.mode 更新靠这条补发。
 */
export async function emitModeChanged(
  this: AgentRuntimeInternal,
  options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.SessionModeChanged,
    this.sessionId,
    {
      mode: this.getMode(),
      planEnabled: this.getPlanEnabled(),
      previousMode: options.previousMode,
      source: "command",
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

export async function drainPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  },
): Promise<DrainedPendingInputDiagnostics | undefined> {
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // Guide 出队先移除内存、后落事件；完整消费期间不能从旧投影捕获授权目标。
  this.pendingInputDrains = (this.pendingInputDrains ?? 0) + 1;
  try {
    return await drainPendingInputUnlocked.call(this, options);
  } finally {
    this.pendingInputDrains -= 1;
  }
}

async function drainPendingInputUnlocked(
  this: AgentRuntimeInternal,
  options: Parameters<typeof drainPendingInput>[0],
): Promise<DrainedPendingInputDiagnostics | undefined> {
  const guideIndex = firstInlineGuideIndex(options.activeTurn);
  const pendingInput = guideIndex >= 0 ? options.activeTurn.pendingInputs[guideIndex] : undefined;
  if (!pendingInput) return undefined;
  // sendQueuedNow 已 reserve 的队首只能由 reservation owner 提升；普通 roundtrip drain
  // 必须暂停，避免 stop barrier 期间同一输入又被当前 turn 消费一次。
  if (this.pendingInputReservations.has(pendingInput.id)) return undefined;
  // 普通 queue 只能由 bootstrap 在 session-ready + goal gate 后提升；runtime 行内 drain
  // 从 guide 子序列取最早一项，不能让 future queue 偷跑，也不能让它阻塞当前轮引导。
  options.activeTurn.pendingInputs.splice(guideIndex, 1);
  const pendingInputs = [pendingInput];
  const queryIds = pendingInput.queryId ? [pendingInput.queryId] : undefined;
  // steer 是新的真实用户 query。drain 后的下一次模型请求必须切到该 queryId，
  // 不能继续沿用原始 turn query，否则 tool 后续请求会被归因到上一条用户消息。
  const drainTraceContext = pendingInput.queryId
    ? { ...options.traceContext, queryId: pendingInput.queryId }
    : options.traceContext;

  const drainedAt = Date.now();
  const inputPreviews = pendingInputs.map((pendingInput) => previewInput(pendingInput.input));
  const inputSizes = pendingInputs.map((pendingInput) => measureUtf8Bytes(pendingInput.input));
  const queuedDurationsMs = pendingInputs.map(
    (pendingInput) => drainedAt - pendingInput.queuedAt.getTime(),
  );
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];
  const drainedInputs: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: "guide" | "queue";
    intent?: NonNullable<PendingTurnInput["intent"]>;
    toolDisallowlist?: readonly string[];
  }> = [];
  for (const pendingInput of pendingInputs) {
    const messageId = createMessageId();
    // 投递语义缺省按 queue（排队消费=独立轮）；guide 由 v4 命令面
    // 按 inputRouting 显式标注。落到持久 metadata 供冷恢复还原同一切分。
    const delivery = pendingInput.delivery ?? "queue";
    const resolvedAttachments = await resolveTurnAttachments(pendingInput.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: drainTraceContext,
      turnId: options.activeTurn.turnId,
      workingDirectory: this.workingDirectory,
    });
    // 只在实际 guide 消费且无附件时固化新标记；审批反馈仍走原合同。
    const inputPresentation =
      delivery === "guide" && !pendingInput.source && !pendingInput.attachments?.length
        ? parseRuntimeInputPresentation(pendingInput.inputPresentation)
        : undefined;
    const runtimeEntry = createRuntimeUserEntry(
      buildUserContentFromTurn(
        withConversationQuotes(
          pendingInput.input,
          pendingInput.intent?.conversationQuotes,
          pendingInput.intent?.botGroupSource,
        ),
        resolvedAttachments,
      ),
      runtimeInputMetadata(inputPresentation) ?? realUserRuntimeMetadata(),
    );
    this.messageHistory.addEntries([runtimeEntry]);
    runtimeEntries.push(runtimeEntry);
    await this.persistUserPrompt(
      messageId,
      pendingInput.input,
      resolvedAttachments,
      drainTraceContext,
      {
        steerDelivery: delivery,
        inputPresentation,
        sessionInputId: pendingInput.id,
        sourceCommandId:
          pendingInput.intent?.sourceCommandId ?? String(pendingInput.queryId ?? pendingInput.id),
        clientId: pendingInput.intent?.clientId,
        intent: pendingInput.intent,
      },
    );
    messageIds.push(messageId);
    drainedInputs.push({
      pendingInputId: pendingInput.id,
      messageId,
      text: pendingInput.input,
      delivery,
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
    });
  }

  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);
  const toolDisallowlist = [
    ...new Set(pendingInputs.flatMap((pendingInput) => pendingInput.toolDisallowlist ?? [])),
  ];
  const event = this.createEvent(
    SessionEventType.TurnSteerDrained,
    {
      injectedMessageIds: messageIds,
      pendingInputIds,
      drainedInputs,
      ...(queryIds ? { queryIds } : {}),
      targetTurnId: options.activeTurn.turnId,
    },
    drainTraceContext,
  );
  await this.appendEvent(event, drainTraceContext);
  options.events.push(event);
  this.logger?.debug("Turn steer drained", {
    ...traceContextToLogContext(drainTraceContext),
    drainedCount: pendingInputs.length,
    event: "turn.steer.drained",
    injectedMessageIds: messageIds,
    inputPreviews,
    inputSizes,
    module: "core.runtime",
    pendingInputIds,
    queryIds,
    queuedDurationsMs,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
  return {
    injectedMessageIds: messageIds,
    ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
    latestMessageId: messageIds.at(-1),
    pendingInputIds,
    queryIds,
    runtimeEntries,
    ...(toolDisallowlist.length > 0 ? { toolDisallowlist } : {}),
  };
}

export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  if (this.activeTurn !== options.activeTurn) return;
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // （重启不保留队列）：先清扫账本残留 admitted——事件日志是
  // 内存的，崩溃后投影里什么都没有，账本是唯一痕迹（含 background wake：后台
  // 子进程随 CLI 重启已死，其未消费通知不可恢复）。留痕（discarded/session_resumed）
  // 不静默，用户/诊断可查「这条输入去哪了」。
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}
