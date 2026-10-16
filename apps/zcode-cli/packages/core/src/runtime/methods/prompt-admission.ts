import { createChildTraceContext, createQueryId, createTurnId } from "../deps.js";
import type { QueryId, TurnInputIntentMetadata } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "../types.js";

/**
 * 每个 AgentRuntime 自己完成 prompt 的 admission：检查 busy 边界、建立 reservation、
 * 把 command 放进该 runtime 的 FIFO。Bootstrap 不应把这些步骤拆开，否则 reservation
 * 建立前的异步窗口会让同一 session 产生第二条 turn。
 */
export async function admitPrompt(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: Parameters<AgentRuntimeInternal["executeTurn"]>[1],
  options?: PromptAdmissionOptions,
): Promise<PromptAdmissionReceipt> {
  if (options?.requireQueue === true) {
    // Bug 根因：Highspeed 临时 provider 只能在独立 turn 的提升边界安装。如果仅依据
    // Bootstrap 的 busy 快照决定是否排队，状态在跨层 await 期间转为空闲会误用普通模型启动。
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options.commandKind,
      delivery: "queue",
      input,
      inputId: options.inputId,
      intent: admissionIntent(options.intent, "queue"),
      queryId: options.queryId,
      toolDisallowlist: options.toolDisallowlist,
      traceContext: options.traceContext,
    });
  }
  const promotionLeaseOnly =
    options?.requireIdle === true &&
    this.foregroundPromotionLease !== undefined &&
    this.activeForegroundExecution === undefined &&
    this.runtimeCommandDrainActive === false &&
    this.runtimeCommandQueue.hasPending() === false &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined;
  const busy = this.hasActiveOrQueuedTurnWork() && !promotionLeaseOnly;
  if (busy) {
    if (options?.requireIdle === true || options?.modelExecution !== undefined) {
      return {
        activeTurnId: this.activeTurn?.turnId,
        kind: "rejected",
        reason: this.activeTurn ? "turn_not_steerable" : "no_active_turn",
      };
    }

    const activeTurn = this.activeTurn;
    const canSteer =
      attachments === undefined &&
      activeTurn?.steerable === true &&
      (options?.queueDelivery === "guide" ||
        options?.delivery === "auto" ||
        options?.delivery === "steer_active_turn") &&
      options?.queueDelivery !== "queue";
    if (canSteer) {
      const delivery = options?.queueDelivery === "guide" ? "guide" : undefined;
      return await this.steerTurn({
        commandKind: options?.commandKind,
        delivery,
        expectedTurnId: options?.expectedTurnId,
        input,
        inputPresentation:
          options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
        inputId: options?.inputId,
        intent: admissionIntent(options?.intent, delivery ?? "queue"),
        queryId: options?.queryId,
        toolDisallowlist: options?.toolDisallowlist,
        traceContext: options?.traceContext,
      });
    }

    const delivery =
      options?.queueDelivery === "guide" && attachments === undefined ? "guide" : "queue";
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
  }

  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    queryId,
    sessionId: this.sessionId,
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  const reservation: ActiveTurnStartReservation = {
    kind: "regular",
    traceContext: turnTraceContext,
    turnId,
  };
  this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const executeOptions = options as ExecuteTurnOptions | undefined;
  const completion = enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandCancelled: () => this.releaseTurnStart(turnId),
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options: {
        ...executeOptions,
        queryId,
        traceContext: options?.traceContext ?? this.rootTraceContext,
      },
      priority: "next",
      reject,
      resolve,
      startReservation: reservation,
      traceContext: turnTraceContext,
    }),
  });
  // admission 已经完成；执行失败由现有 turn 事件/调用方消费，不制造 unhandled rejection。
  void completion.catch(() => undefined);
  return { completion, kind: "started", turnId };
}

function admissionIntent(
  intent: TurnInputIntentMetadata | undefined,
  admittedDelivery: "guide" | "queue",
): TurnInputIntentMetadata | undefined {
  return intent ? { ...intent, admittedDelivery } : undefined;
}
