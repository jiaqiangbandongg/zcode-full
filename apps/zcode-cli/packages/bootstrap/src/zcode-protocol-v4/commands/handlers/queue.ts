// queue 命令组：deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / sendQueuedNow（原生重做，组文件样板见 session-flow.ts）。
// 决策逻辑直驱 core（app 层 queue API，批1 已搬运）；queueItemId ≡ core 的
// pendingInputId（同一 id 空间，无需翻译）。queue 变更的事件由 core runtime 自发，
// 经 gateway ingest 推进 v4 投影——本组不需要 legacy 广播钩子。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../zcode-protocol/model-execution.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  startManualCompact,
  V4GoalCompactRejectedError,
} from "./goal-compact.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow 在投影里查不到该项原文（已被 drain/删除或 id 无效）→ 拒绝。 */
export class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

export class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

export class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

export class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  // 未命中（并发 drain/重复删除的竞态）= noop，不算失败；留 warn 供观测。
  const removed = await record.app.removeQueueItem(payload.queueItemId);
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // 未命中曾返回 undefined，gateway 会把并发 drain/重复删除误报为 accepted；
    // queue 撤回编辑因此可能把已消费的旧投影再次恢复到 composer。
    throw new V4CommandNoopError("queue.itemMissing");
  }
  if (queueItem) {
    host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  return undefined;
}

async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") {
    // compact 是 typed maintenance intent；允许改文本会把它伪装成普通输入，
    // 但 commandKind 仍是 compact，消费时产生与 UI 文案不一致的压缩副作用。
    throw new V4QueueItemNotEditableError(payload.queueItemId);
  }
  // core reducer 同 id 原地更新（保位）；未命中 = noop + warn（同 delete 的竞态语义）。
  const edited = await record.app.editQueueItem(payload.queueItemId, payload.newText);
  if (!edited) {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  // beforeQueueItemId = null → 移到队尾（协议与 app API 同形，直传）。
  const moved = await record.app.reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setQueueAutoDrain(payload.autoDrain);
  if (payload.autoDrain) {
    // 不能只翻授权位：idle 暂停队列没有 active turn 可替它启动队首。复用 CLI
    // 权威 ready hook，busy 时只武装，idle 时立即按 sendQueuedNow 原子路径提升。
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setFollowupMode(payload.mode);
  return undefined;
}

/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - 必须读取完整 QueueItem；text-only fallback 会丢 sourceCommandId/附件/client/order，禁止使用。
 * - stop 复用 session-flow 的语义：goal-pause barrier（否则 verifier 未收 abort 时
 *   queue 无法 drain）→ abort；只 abort 不 await。
 * - 等 idle 语义：锁由后台 turn 的 finally 释放（见 prompt-turn 文件头 3），
 *   abort 后立刻重发会撞 "A prompt is already running"，必须轮询等锁释放。
 * - start 之前任一步失败都 release reservation，原项原位保留；start 成功后才 remove。
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (!(await record.app.reserveQueueItem(payload.queueItemId, reservationId, traceOptions))) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments =
      queueItem.kind === "compact"
        ? undefined
        : await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    let preempted = false;
    if (!autoDrainPromotion) {
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    }
    if (
      !(await record.app.markQueueItemPromoting(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    if (queueItem.kind === "compact") {
      await startManualCompact(host, record, queueItem.sourceCommandId, foregroundPromotionLeaseId);
      leaseReleaseOwnedByBackground = true;
    } else if (queueItem.kind === "sendGoalCommand") {
      const intent = inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text);
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        record.app.runtime?.getPlanEnabled?.() ??
        record.app.getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      // 手动提升允许 Renderer 为同一张卡补一份新执行材料；卡不同一律忽略，避免跨卡换凭据。
      const refreshedHighspeedMatchesQueue =
        payload.highspeedMeta !== undefined &&
        queueItem.highspeed !== undefined &&
        payload.highspeedMeta.cardId === queueItem.highspeed.cardId &&
        payload.highspeedMeta.taskId === queueItem.highspeed.taskId;
      if (refreshedHighspeedMatchesQueue && payload.highspeedMeta) {
        intent.highspeed = payload.highspeedMeta;
        // Selection 与执行材料必须同批替换（协议已用 superRefine 保证成对到达）。
        if (payload.modelSelection) intent.modelSelection = payload.modelSelection;
      }
      // 凭据不入队列持久化面：先用本次补供的材料，其次取 CLI 内存按 sourceCommandId 的暂存。
      const stagedExecution =
        (refreshedHighspeedMatchesQueue ? payload.modelExecution : undefined) ??
        host.readQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      const highspeedSelected = isHighspeedProviderId(intent.modelSelection?.providerId);
      // 规则 9：卡在排队期间可能过期。提升前重新判定有效性，过期或凭据缺失都退回会话模型。
      const highspeedStillValid =
        highspeedSelected &&
        intent.highspeed !== undefined &&
        intent.highspeed.expiresAt > Date.now() &&
        stagedExecution !== undefined;
      if (highspeedSelected && !highspeedStillValid) {
        if (intent.highspeed && intent.highspeed.expiresAt > Date.now()) {
          // Bug 原因：现场出现有效卡的队列项在手动提升时静默退回普通模型，原日志只覆盖
          // provider 安装失败，无法区分「凭据暂存缺失」与「卡本身已过期」。
          host.logger?.warn?.("v4 queued Highspeed execution unavailable; using session model", {
            cardId: intent.highspeed.cardId,
            queueItemId: queueItem.queueItemId,
            reason: "execution_missing",
            sessionId: record.app.sessionId,
          });
        }
        // 退回必须同时改写 Selection：只删卡标记会让本轮带着加速 provider 却没有任何凭据。
        // 与 retry/edit 重发共用同一 fallback resolver（spec §3 规则 13）。
        delete intent.highspeed;
        intent.modelSelection = resolveSessionFallbackModelSelection(record);
        host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      }
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
        inputId: queueItem.sourceCommandId,
        // 手动提升若实际抢占旧执行，同样是 human steer；自动 drain 不产生此标记。
        ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
        intent,
        requireIdle: true,
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(highspeedStillValid && stagedExecution
          ? { modelExecution: createModelExecutionContext(stagedExecution) }
          : {}),
        ...(attachments ? { attachments } : {}),
      });
      // 旧 fake app/兼容命令可能不返回 admission receipt；真实 app 已在 Core admission
      // 处完成 started 校验。只有明确 queued/rejected 才能判定 promotion 未启动。
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
      // 凭据已随本轮冻结进 Core；启动成功后立刻销毁暂存副本，失败路径保留以便重试仍能加速。
      host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
    }
    startAdmitted = true;
    const removed = await record.app.removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    if (queueItem.kind === "compact") {
      // no-op compact 可能在 promoting 项删除前就完成；它的 ready hook 此时看见的
      // 仍是 dispatch=promoting，无法继续消费下一条 typed intent。删除后再过一次 mutation
      // 边界可关闭这个竞态；正常慢 compact 因 active controller 存在不会重复 drain。
      await host.afterLegacyStateMutation?.(record, "queue_compact_promoted");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // start 一旦 admitted 就不能 release，否则 remove 异常时另一端会重复执行；此时保持
    // promoting 供显式 resync/故障处理。start 前失败则安全回滚到 queued。
    if (queueItemReserved && !startAdmitted) {
      await record.app.releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

export const queueHandlers = {
  deleteQueueItem,
  editQueueItem,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  sendQueuedNow,
};
