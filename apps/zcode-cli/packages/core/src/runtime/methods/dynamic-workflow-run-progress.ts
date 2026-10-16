import {
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type TraceContext,
} from "../deps.js";
import {
  formatWorkflowEscalationNotification,
  formatWorkflowStallNotification,
} from "../../runtime-task/notification.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { notifyHoleReached } from "./dynamic-workflow-run-hole-notification.js";

/**
 * 把一条 workflow run 进度事件追加到**父会话**（run 自己没有会话）。
 *
 * 这是一次**出回合追加**：run 在后台跑，事件到达时父会话可能正在跑一个回合，也可能完全空闲。
 * 两种都必须落地，而这条链路本来就两种都支持——BackgroundTask* 走的就是它（core 内部经
 * tool executor 的 emitEvent）。dwf 的事件源在 bootstrap 的 run service，那一层拿不到
 * AgentRuntimeInternal，所以需要这个公共方法；同形先例是 {@link recordTargetChanged}。
 *
 * 刻意用 `rootTraceContext` 而不是当前回合的 trace：turnId 因此为空，事件不冒领任何一轮。
 * 冷恢复的 merge 会把带 turnId 的内存事件按"所属未完结轮"插回该轮尾部，而一条 run 事件
 * 属于 run、不属于任何一轮——冒领会让它在冷恢复后出现在一轮已完结对话的末尾。
 */
export async function recordDynamicWorkflowRunProgress(
  this: AgentRuntimeInternal,
  input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
): Promise<void> {
  const { traceContext: provided, ...payload } = input;
  const traceContext = provided ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.DynamicWorkflowRunProgress,
      payload satisfies DynamicWorkflowRunProgressPayload,
      traceContext,
    ),
    traceContext,
  );
  notifyEscalationRaised.call(this, payload, traceContext);
  notifyRunStalled.call(this, payload, traceContext);
  // 留白（dynamic-workflow-run-hole-notification.ts）：要读一次快照补齐类型 / 草稿 / 前后阶段，所以是
  // 三条里唯一异步的一条；事件已经落库，等它只是等通知入队。
  await notifyHoleReached.call(this, payload, traceContext);
}

/** run 级停滞的事件种类（引擎的 `RunEvent.type`）。 */
const RUN_STALLED_EVENT_TYPE = "run-stalled";

/**
 * `run-stalled` → 一条模型可见的 run 中通知。与 {@link notifyEscalationRaised} 同一层、同三条
 * 纪律：每条事件恰好一条通知（driver 侧每个 stall 段只发一次，成功后重新上膛才会有下一条）；
 * 不催办；绝不抛异常——载荷形状不对就跳过并记一条日志。
 */
function notifyRunStalled(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== RUN_STALLED_EVENT_TYPE) return;
  const sinceMs = payload.payload.sinceMs;
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0) {
    this.logger?.warn?.("Dynamic workflow stall notification skipped: malformed payload", {
      event: "dynamic_workflow.stall.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const reason = stringField(payload.payload, "reason");
  const capValue = payload.payload.cap;
  const cap =
    typeof capValue === "number" && Number.isFinite(capValue) && capValue >= 0
      ? Math.floor(capValue)
      : undefined;
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      workId: payload.runId,
      workflowNotification: {
        kind: "stall",
        sinceMs: Math.floor(sinceMs),
        ...(reason === undefined ? {} : { reason: reason.slice(0, 64) }),
        ...(cap === undefined ? {} : { cap }),
      },
    },
    taskId: payload.runId,
    text: formatWorkflowStallNotification({
      runLabel,
      runId: payload.runId,
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    }),
    traceContext,
  });
}

/** 升级问答的事件种类（引擎的 `RunEvent.type`，经进度载荷的 `eventType` 到达）。 */
const ESCALATION_RAISED_EVENT_TYPE = "escalation-raised";

/**
 * `escalation-raised` → 一条模型可见的 run 中通知。
 *
 * 为什么在这一层而不是新开一条端口：进度汇已经把每一条 RunEvent 送到这里，这是**唯一**一个
 * 同时看得见 run 事件与 AgentRuntime 的地方。再加一个端口只会让同一条事实走两条路。
 *
 * 三条纪律：
 *   - **每个 raised 恰好一条通知**，不重发、不催办。通知被丢弃（stale branch / shutdown）
 *     后的兜底是查询——GetWorkflowRun 的 pendingQuestions，不是重试。
 *   - **`escalation-resolved` 不发通知**：作答方就是主代理自己，回执已经是那次工具调用的结果。
 *   - **绝不抛异常**：这是观察面，而 run 的真相在 journal。载荷形状不对就跳过并记一条日志——
 *     它跨了端口边界又被有界化裁剪过，防御性读取是它应得的待遇。
 */
function notifyEscalationRaised(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== ESCALATION_RAISED_EVENT_TYPE) return;

  const qid = stringField(payload.payload, "qid");
  const question = stringField(payload.payload, "question");
  if (qid === undefined || question === undefined) {
    this.logger?.warn?.("Dynamic workflow escalation notification skipped: malformed payload", {
      event: "dynamic_workflow.escalation.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }

  // 展示名的兜底链与终态通知同源：registry 条目的 description（CreateWorkflow 的 name /
  // 脚本首行派生）→ runId。刻意不去查端口——通知是同步产出的，而这条路径不做 I/O。
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const context = stringField(payload.payload, "context");
  // 匿名 actor 没有 actorName（引擎刻意不合成兜底标签，见 RunEvent 的注释）：这里落到
  // 结构化 ref `site@ordinal`，它在 run 内唯一定位，读成句子也还过得去。通知文本与 manifest
  // 载荷共用同一条兜底链——两处若各兜各的，同一个 actor 会在两处显示不同的名字。
  const actor = stringField(payload.payload, "actorName") ?? actorRefLabel(payload.payload);
  // askedAt 是 epoch ms，可能缺席（stringField 读不出数字，只能防御性直读）。
  const askedAt = payload.payload.askedAt;

  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId ≡ runId：与该 run 的终态通知同一个展示锚点，两条通知因此落在同一条后台工作上。
      workId: payload.runId,
      // manifest 载荷（escalation 判别分支）：GUI 折叠成「Subagent X has a question」，
      // 展开显示问题全文。发射侧铸造、有界（question / context ≤4000，同步 shared schema）。
      workflowNotification: {
        kind: "escalation",
        qid,
        actor,
        question: question.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS),
        ...(context === undefined
          ? {}
          : { context: context.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS) }),
        ...(typeof askedAt === "number" && Number.isFinite(askedAt) ? { askedAt } : {}),
      },
    },
    // taskId 让通知继承该 run 的 branchGeneration（迟到通知的 fencing）；兜底是快照查询。
    taskId: payload.runId,
    text: formatWorkflowEscalationNotification({
      runLabel,
      runId: payload.runId,
      qid,
      actor,
      question,
      ...(context === undefined ? {} : { context }),
    }),
    traceContext,
  });
}

/** manifest 载荷里 question / context 的界（shared schema：≤4000 字符）。 */
const WORKFLOW_ESCALATION_TEXT_MAX_CHARS = 4_000;

/** `{siteId, ordinal}` → `site@ordinal`（引擎 `refToString` 的形状）；读不出来就说「未知 actor」。 */
function actorRefLabel(payload: Record<string, unknown>): string {
  const actor = payload.actor;
  if (typeof actor === "string") return actor;
  if (typeof actor !== "object" || actor === null) return "unknown actor";
  const siteId = stringField(actor as Record<string, unknown>, "siteId");
  const ordinal = (actor as Record<string, unknown>).ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return "unknown actor";
  return `${siteId}@${ordinal}`;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
