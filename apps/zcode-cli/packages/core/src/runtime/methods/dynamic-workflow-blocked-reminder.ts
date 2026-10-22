// ============================================================
// 「run 还欠着决定、主代理闲着」的提醒：runtime 侧的宿主与接线
// ============================================================
// docs/dynamic-workflow/transcript-and-notifications.md「Reminding an idle main agent」。规则（空闲钟、
// 两次、谁给新的一对）在 runtime-task/workflow-blocked-reminder.ts 的钟里；本文件只做两件事：
//
//   1. 把钟要的四样东西接到 runtime 上：在飞的 run 来自任务注册表，开集来自端口快照
//      （`pendingQuestions` 与 `waiting` 的 `holes`——与 GetWorkflowRun 念的是同一份投影），空闲与否来自
//      命令队列，发出走既有的后台通知入口（同一条队列、账本、分支围栏与关闭丢弃，不新增投递路径）。
//   2. 接线点只在调用方留一行：命令开始与 run 的开集事件各有一个函数在这里；队列排空（空闲沿）与
//      用户 steer 直接调钟，分别在 runtime-command-queue.ts 与 steering.ts。
//
// 与 `run-stalled` 的差别：停滞是 run 自己的事实，由 driver 的钟发现、进 journal；这里的「闲」是**父会话**
// 的事实，run 与 journal 都不知道，所以它不是一条 run 事件，也不随进程重启恢复——进程没了，在飞的 run
// 结算为 interrupted，resume 会让每个开着的决定带着自己的通知重新出现。

import type { RuntimeCommand } from "../command-queue.js";
import type { DynamicWorkflowRunProgressPayload } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  WorkflowBlockedReminderClock,
  type WorkflowBlockedReminder,
  type WorkflowOpenDecisions,
} from "../../runtime-task/workflow-blocked-reminder.js";
import { formatWorkflowBlockedNotification } from "../../runtime-task/workflow-notification-copy.js";

/** workflow run 在任务注册表里的类型。 */
const WORKFLOW_RUN_TASK_TYPE = "local_dynamic_workflow";
/** 注册表里「还在飞」的状态词。 */
const RUNNING_TASK_STATUS = "running";

/** 改变一个 run 开集的四种事件（引擎的 `RunEvent.type`）。 */
const OPEN_SET_EVENT_TYPES: ReadonlySet<string> = new Set([
  "escalation-raised",
  "escalation-resolved",
  "hole-reached",
  "hole-filled",
]);

/** 造这个 runtime 的提醒钟（构造函数里调一次）。 */
export function createWorkflowBlockedReminder(
  runtime: AgentRuntimeInternal,
): WorkflowBlockedReminderClock {
  return new WorkflowBlockedReminderClock({
    isIdle: () => !runtime.shuttingDown && !runtime.hasActiveOrQueuedTurnWork(),
    liveRunIds: () => liveWorkflowRunIds(runtime),
    onReadError: (runId, error) => {
      runtime.logger?.warn?.("Dynamic workflow blocked reminder: snapshot read failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.blocked.snapshot_failed",
        module: "core.runtime",
        runId,
      });
    },
    readOpen: (runId) => readOpenDecisions(runtime, runId),
    remind: (reminder) => {
      enqueueBlockedReminder(runtime, reminder);
    },
  });
}

/**
 * 本会话在飞的 workflow run。注册表是 per-runtime 的，所以这里看到的都是本会话发起的；被 rewind 掉的
 * 分支上的 run 不算——它的通知会被入口的分支围栏丢掉，提醒它只会白烧一次次数。
 */
function liveWorkflowRunIds(runtime: AgentRuntimeInternal): string[] {
  const live: string[] = [];
  for (const task of Object.values(runtime.runtimeTaskRegistry.all())) {
    if (task.type !== WORKFLOW_RUN_TASK_TYPE || task.status !== RUNNING_TASK_STATUS) continue;
    if ((task.branchGeneration ?? runtime.branchGeneration) !== runtime.branchGeneration) continue;
    live.push(task.taskId);
  }
  return live;
}

async function readOpenDecisions(
  runtime: AgentRuntimeInternal,
  runId: string,
): Promise<WorkflowOpenDecisions | undefined> {
  const snapshot = await runtime.dynamicWorkflowRunPort?.getTask(runId);
  if (snapshot === undefined) return undefined;
  const questions = snapshot.pendingQuestions ?? [];
  const holes = (snapshot.holes ?? []).filter((hole) => hole.state === "waiting");
  if (questions.length + holes.length === 0) return undefined;
  return {
    questions,
    holes,
    ...(snapshot.scriptPath === undefined ? {} : { draftPath: snapshot.scriptPath }),
  };
}

function enqueueBlockedReminder(
  runtime: AgentRuntimeInternal,
  reminder: WorkflowBlockedReminder,
): void {
  const { runId, open, now } = reminder;
  // 展示名的兜底链与其余 run 通知同源：registry 条目的 description → runId。
  const runLabel = runtime.runtimeTaskRegistry.get(runId)?.description ?? runId;
  const sinceMs = Math.max(
    0,
    ...open.questions.map((question) => Math.floor(now - question.askedAt)),
    ...open.holes.map((hole) => (hole.since === undefined ? 0 : Math.floor(now - hole.since))),
  );
  // 生产也留的一条：每个停住的 run 在一段空闲里至多两条，出问题时要能在日志里看见「提醒过了」。
  runtime.logger?.info?.("Dynamic workflow blocked reminder sent", {
    event: "dynamic_workflow.blocked.reminder_sent",
    holes: open.holes.length,
    module: "core.runtime",
    ordinal: reminder.ordinal,
    questions: open.questions.length,
    runId,
    sinceMs,
  });
  runtime.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId ≡ runId：与该 run 的其余通知同一个展示锚点。
      workId: runId,
      // 载荷只带计数与最久的等待：每个决定的原文在它自己那条通知行上，这一行不重复。
      // 走自己的键而不是 `workflowNotification` 的一个 kind：那个 union 在线上是闭集，多一个成员会让
      // 不认识它的客户端拒掉整帧（contracts 的 WorkflowBlockedMeta 上有来由）。
      workflowBlocked: {
        questions: open.questions.length,
        holes: open.holes.length,
        sinceMs,
      },
    },
    // taskId 让通知继承该 run 的 branchGeneration（迟到通知的 fencing）。
    taskId: runId,
    text: formatWorkflowBlockedNotification({
      runLabel,
      runId,
      ordinal: reminder.ordinal,
      total: reminder.total,
      now,
      questions: open.questions,
      holes: open.holes,
      ...(open.draftPath === undefined ? {} : { draftPath: open.draftPath }),
    }),
    traceContext: runtime.rootTraceContext,
  });
}

/**
 * 命令队列开始跑一条命令（或一批通知）：钟停。带合成来源的 prompt（提醒类注入、goal 续跑等）不是
 * 用户发话；没有来源的 prompt 才是用户自己敲的那一条，它给每个 run 新的一对提醒。
 */
export function noteWorkflowReminderCommandStarted(
  runtime: AgentRuntimeInternal,
  command: RuntimeCommand,
): void {
  const clock = runtime.workflowBlockedReminder;
  if (clock === undefined) return;
  clock.sessionBusy();
  if (command.mode === "prompt" && command.options?.inputSource === undefined) clock.userSpoke();
}

/** 一条 run 进度事件：改变开集的那四种让该 run 重新得到一对提醒，其余不理会。 */
export function noteWorkflowReminderRunEvent(
  runtime: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
): void {
  if (!OPEN_SET_EVENT_TYPES.has(payload.eventType)) return;
  runtime.workflowBlockedReminder?.openSetChanged(payload.runId);
}
