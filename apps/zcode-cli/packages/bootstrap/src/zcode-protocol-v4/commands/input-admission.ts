// V4 用户输入准入共用件：正文/附件非空校验、held 队列裁决、以及旧发送端的
// Selection/Mode 固定。这些原语被 session-flow / goal-compact / session-mgmt /
// queue / fork-edit-retry 五个命令组共同消费，属于 commands 层的横向能力，
// 因此与 prompt-turn.ts、record-access.ts 并列放在 commands/ 下，
// 而不是寄居在某一个 handler 文件里。
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { resolveExecutionState, type ModelSelection } from "@zcode/shared";
import type { TurnAttachment } from "@zcode/core";
import type { SteerTurnOptions } from "../../app/types.js";
import { parseProviderQualifiedModelSelection } from "../../app/provider-registry-selection.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

export class V4InputAdmissionRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "V4InputAdmissionRejectedError";
  }
}

/** V4 用户输入统一准入：正文或附件至少存在一个。 */
export function hasPromptInput(text: string, attachments: readonly unknown[] | undefined): boolean {
  return text.trim().length > 0 || Boolean(attachments && attachments.length > 0);
}

/** held（inputRouting.mode=choice）下 sendText/sendGoalCommand 缺 disposition → 拒绝（10 §6.4）。 */
export class V4HeldQueueDispositionRequiredError extends Error {
  readonly reasonCode = "heldQueueDispositionRequired";
  constructor() {
    super("held queue requires heldQueueDisposition (clearQueueAndSend | keepQueueAndSend)");
    this.name = "V4HeldQueueDispositionRequiredError";
  }
}

/** 确认框打开后队列被另一端增删：旧确认不能继续清空/保留并发送。 */
export class V4HeldQueueConfirmationStaleError extends Error {
  readonly reasonCode = "guard.heldQueueConfirmationStale";
  constructor() {
    super("paused queue changed after send confirmation opened");
    this.name = "V4HeldQueueConfirmationStaleError";
  }
}

export async function enqueueDeferredInputForBusyWork(
  record: V4SessionRecordView,
  text: string,
  options: {
    commandKind?: SteerTurnOptions["commandKind"];
    inputId: string;
    queryId: SteerTurnOptions["queryId"];
    intent?: SteerTurnOptions["intent"];
    attachments?: TurnAttachment[];
    toolDisallowlist?: SteerTurnOptions["toolDisallowlist"];
  },
): Promise<boolean> {
  if (!record.app.enqueueDeferredInput) return false;
  const result = await record.app.enqueueDeferredInput(text, {
    ...(options.commandKind ? { commandKind: options.commandKind } : {}),
    delivery: "queue",
    inputId: options.inputId,
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.toolDisallowlist ? { toolDisallowlist: options.toolDisallowlist } : {}),
    queryId: options.queryId,
  });
  if (result.kind === "queued") return true;
  throw new V4InputAdmissionRejectedError(
    result.reason === "input_too_large"
      ? "proto.payloadTooLarge"
      : result.reason === "empty_input"
        ? "proto.invalidPayload"
        : "fault.command.inputRejected",
    `deferred input rejected: ${result.reason}`,
  );
}

/**
 * held choice 裁决共用件（catalog B06/B07，2026-07-05 裁决）：completed + queue>0 +
 * autoDrain=false（投影 inputRouting.mode=choice）时输入不静默入队——
 * clear → 先清空 queue 再 startNow；keep → 保留 queue 直接 startNow；缺省 → reject。
 */
export async function applyHeldQueueDisposition(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  disposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
  expectedQueueItemIds?: readonly string[],
): Promise<void> {
  const routing = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (routing !== "choice") return;
  if (!disposition) {
    throw new V4HeldQueueDispositionRequiredError();
  }
  if (expectedQueueItemIds) {
    const expected = new Set(expectedQueueItemIds);
    const sameItems =
      expected.size === expectedQueueItemIds.length &&
      host.getQueueLength?.(record.app.sessionId) === expected.size &&
      expectedQueueItemIds.every(
        (queueItemId) => host.getQueueItem?.(record.app.sessionId, queueItemId) !== null,
      );
    if (!sameItems) {
      throw new V4HeldQueueConfirmationStaleError();
    }
  }
  if (disposition === "clearQueueAndSend") {
    await record.app.clearQueueItems();
    host.clearQueuedTurnExecutions?.(record.app.sessionId);
  }
}

/**
 * M3 兼容 admission：新发送端显式提交 Selection/Mode/Plan；旧发送端在 CLI 接收边界把
 * 当前 Session 值固定进 canonical intent。固定完成后 Queue/Guide 不再读取可变 Session。
 */
export function resolveSubmittedExecutionState(
  record: V4SessionRecordView,
  payload: {
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
  },
): { modelSelection: ModelSelection; mode: SubmissionMode; planEnabled: boolean } {
  let modelSelection = payload.modelSelection;
  if (!modelSelection) {
    const runtimeSelection = record.app.runtime?.getSessionModelSelection?.();
    const entrySelection = runtimeSelection
      ? undefined
      : parseProviderQualifiedModelSelection(record.app.getModel());
    if (!runtimeSelection && !entrySelection) {
      throw new Error(`Session model must be provider-qualified: ${record.app.getModel()}`);
    }
    // 修复原因：getThoughtLevel() 是 Active Model 的 effective 展示事实。把它补回
    // canonical intent 会把 Config 默认值伪装成显式 pin；旧发送端只能固定 Session
    // 已经持有的稀疏 Selection，不能在 admission 时重新解释它。
    modelSelection = runtimeSelection
      ? {
          providerId: runtimeSelection.providerId,
          modelId: runtimeSelection.modelId,
          ...(runtimeSelection.options ? { options: { ...runtimeSelection.options } } : {}),
        }
      : {
          providerId: entrySelection!.providerId,
          modelId: entrySelection!.modelId,
          ...(entrySelection!.options ? { options: { ...entrySelection!.options } } : {}),
        };
  }
  const current = resolveExecutionState({
    mode: record.app.getMode?.(),
    planEnabled: record.app.runtime?.getPlanEnabled?.(),
  });
  const state = resolveExecutionState(payload, current);
  return {
    modelSelection,
    mode: state.mode === "auto" ? "build" : state.mode,
    planEnabled: state.planEnabled,
  };
}

/**
 * Highspeed Selection 只有与同一轮 execution 材料成对出现才有效。retry、edit 重发、卡过期与
 * queue promotion 在没有本轮有效执行材料时，统一经这个 resolver 退回会话常驻 Selection；
 * 禁止只删 modelExecution 却保留 account:*-highspeed-card Selection（spec §3 规则 13）。
 * 只读会话当前值，不改写 session 常驻模型。
 */
export function resolveSessionFallbackModelSelection(record: V4SessionRecordView): ModelSelection {
  return resolveSubmittedExecutionState(record, {}).modelSelection;
}
