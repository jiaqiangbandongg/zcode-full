// ============================================================
// workflow run 的 run 中通知与 provider 停下文案表
// ============================================================
// 从 notification.ts 拆出（eslint max-lines 400 行门）：那个文件承载四种任务的终态通知骨架，
// 这里是 dwf 专属的几段文案——升级问答、留白、run 级停滞、欠着决定的提醒与
// provider 停下；后者由终态通知与 GetWorkflowRun 共用。

import type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunHole,
  DynamicWorkflowRunPendingQuestion,
} from "@zcode/contracts";
import { escapeXml, truncateTaskNotification } from "./notification.js";

/** run 中通知共用的抬头：让模型不把系统通知读成用户输入。 */
const SYSTEM_NOTIFICATION_BANNER = [
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This is an automated workflow event, NOT a message from the user.",
  "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
  "",
] as const;

/**
 * `stopped(provider)` 的 `<error>` 块：
 * 按 `providerStop.kind` 选两句（什么错了 / 做什么），后接固定的事实行与 provider 原文行。
 * 文案里的每个占位都有兜底（provider 显示名缺席用 providerId，再缺席用 "the provider"）——
 * 一条通知绝不因为少一个字段就退化成空句。GetWorkflowRun 的 `<error>` 块共用同一函数。
 */
export function formatWorkflowProviderStopError(
  failure: DynamicWorkflowRunError,
  runId: string,
): string {
  const details = failure.providerStop;
  if (details === undefined) return failure.message;
  const provider = details.providerLabel ?? details.providerId ?? "the provider";
  const providerRef =
    details.providerLabel !== undefined && details.providerId !== undefined
      ? `${details.providerLabel} (${details.providerId})`
      : provider;
  const subagent = details.subagentName ?? details.subagent ?? "a subagent";
  const phase = details.phase === undefined ? "" : ` (phase "${details.phase}")`;
  const model = details.modelId ?? "the current model";
  const code = details.providerCode ?? details.reason;
  const resume = `then call ResumeWorkflowRun with run_id="${runId}"`;
  const sentences = ((): [string, string] => {
    switch (details.kind) {
      case "auth":
        return [
          `Sign-in to ${providerRef} expired while subagent ${subagent}${phase} was running.`,
          `Ask the user to sign in to ${provider} again, ${resume}. Finished steps are kept.`,
        ];
      case "not_configured":
        return [
          `Provider ${details.providerId ?? provider} is not configured on this machine, so subagent ${subagent}${phase} could not send its request.`,
          `Ask the user to configure the provider or switch this session to another model, ${resume}.`,
        ];
      case "model_unavailable":
        return [
          `Model ${model} is not available on ${provider} (not in the user's plan, or retired).`,
          `Ask the user to switch this session to a model the plan includes, ${resume}. Subagents follow the session's model.`,
        ];
      case "invalid_request":
        return [
          `${provider} rejected subagent ${subagent}${phase}'s request as invalid (code ${code}).`,
          `Switching the session to another model usually clears this; ${resume}. If it stops again with the same code, show the raw message to the user.`,
        ];
      case "quota":
        return details.resetAt === undefined
          ? [
              `${provider} reports the user's quota is exhausted (code ${code}).`,
              `Ask the user to top up or upgrade the plan, or switch to another provider, ${resume}.`,
            ]
          : [
              `${provider} reports the user's usage cap is reached (code ${code}); it resets at ${new Date(details.resetAt).toISOString()}.`,
              `Tell the user; after the reset, call ResumeWorkflowRun with run_id="${runId}". Do not rebuild the workflow.`,
            ];
      default:
        return [
          `${provider} refused subagent ${subagent}${phase}'s request with a permanent error (code ${code}).`,
          `Resolve it with the user (the raw message below says what the provider wants), ${resume}.`,
        ];
    }
  })();
  const facts = [
    `provider=${details.providerId ?? "unknown"}`,
    `model=${details.modelId ?? "unknown"}`,
    `subagent=${details.subagent ?? "unknown"}`,
    ...(details.phase === undefined ? [] : [`phase=${details.phase}`]),
    `code=${code}`,
  ].join(" ");
  return [
    sentences[0],
    sentences[1],
    facts,
    ...(details.rawMessage === undefined ? [] : [`raw: ${details.rawMessage}`]),
  ].join("\n");
}

/**
 * run 级停滞的 run 中通知。与升级问答同族：
 * 播报的不是终态而是一个正在发生的事实——run 还在跑、只是 20 分钟没有一次模型请求成功。
 * 文案必须把两件事说死：它**不需要**模型做任何事（尤其不要取消 / 重建），以及用户若在等
 * 就该被告知。每个 stall 段恰好一条，不催办。
 */
export interface WorkflowStallNotificationInput {
  runLabel: string;
  runId: string;
  sinceMs: number;
  reason?: string;
  cap?: number;
}

export function formatWorkflowStallNotification(input: WorkflowStallNotificationInput): string {
  const minutes = Math.max(1, Math.round(input.sinceMs / 60_000));
  const lines = [
    ...SYSTEM_NOTIFICATION_BANNER,
    "<workflow-stall>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <since-ms>${Math.max(0, Math.floor(input.sinceMs))}</since-ms>`,
  ];
  if (input.reason !== undefined) {
    lines.push(`  <dominant-reason>${escapeXml(input.reason)}</dominant-reason>`);
  }
  if (input.cap !== undefined) lines.push(`  <cap>${input.cap}</cap>`);
  const reasonClause =
    input.reason === undefined
      ? "the provider keeps failing requests"
      : `the provider keeps answering ${input.reason}`;
  const capClause = input.cap === undefined ? "" : ` (current fan-out ${input.cap})`;
  lines.push(
    "</workflow-stall>",
    "",
    `Workflow run ${input.runLabel} (${input.runId}) has not completed a model request in ${minutes} minutes; ${reasonClause} and the run is retrying with backoff${capClause}.`,
    "It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

/**
 * 一个 actor 从**正在跑的** run 里升级上来的阻塞问题。
 *
 * 与上面几个 formatter 的关键差别：它们播报的是**终态**（活干完了，读一下结果），这条播报的
 * 是**一个还没被满足的义务**——有一个 actor 此刻正停在那儿等回答，而且没有超时会替它兜底。
 * 所以文案必须把三件事说死：问题是什么、逐字的下一步（带 qid 的工具调用）、以及 run 并没有
 * 因此停下（否则模型会误以为整条工作流在等它，从而放下手上一切事）。
 *
 * 结构化那半用 XML-ish 节（与 `<task-notification>` 同族，字段可被人和模型稳定定位），
 * 散文那半给下一步与边界条件。这一条自己**不重发**：一直没人答时由
 * {@link formatWorkflowBlockedNotification} 那条提醒接手，它是按 run 的状态另铸的，不是这条的副本。
 */
export interface WorkflowEscalationNotificationInput {
  /** run 的展示名（registry 里的 description；缺席时调用方已回落到 runId）。 */
  runLabel: string;
  runId: string;
  qid: string;
  /** actor 的人类可读名；匿名 actor 缺席，调用方给结构化 ref 作兜底。 */
  actor: string;
  question: string;
  context?: string;
}

export function formatWorkflowEscalationNotification(
  input: WorkflowEscalationNotificationInput,
): string {
  const lines = [
    ...SYSTEM_NOTIFICATION_BANNER,
    "<workflow-escalation>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <question-id>${escapeXml(input.qid)}</question-id>`,
    `  <subagent>${escapeXml(input.actor)}</subagent>`,
    `  <question>${escapeXml(input.question)}</question>`,
  ];
  if (input.context !== undefined && input.context.length > 0) {
    lines.push(`  <context>${escapeXml(input.context)}</context>`);
  }
  lines.push(
    "</workflow-escalation>",
    "",
    `Subagent ${input.actor} in workflow run ${input.runLabel} (${input.runId}) escalated a blocking question and is parked on that call waiting for your answer.`,
    `Next step: call ResolveWorkflowQuestion with question_id="${input.qid}" and your answer.`,
    "The run is still running: only the subagent that asked is parked — every other subagent and the script's control flow keep going. So do not drop what you are doing, but do not leave it unanswered either: nothing times out on its behalf.",
    "If this notification is ever lost, GetWorkflowRun lists the questions this run still owes an answer to.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

/**
 * 脚本到达一处留白、等主代理还它代码（docs/dynamic-workflow/transcript-and-notifications.md「What the
 * model reads」的 `<workflow-hole>`）。与升级问答同族：播报的是一件**还没被满足的义务**，没有超时替它
 * 兜底。文案把这几件事说死：去读草稿（函数体在留白处编译、看得见它之前的绑定）、只写语句、返回留白
 * 的类型、带 hole_id 调 FillWorkflowHole；只有这一支停着、run 其余照跑；通知丢了去 GetWorkflowRun。
 */
export interface WorkflowHoleNotificationInput {
  runLabel: string;
  runId: string;
  holeId: string;
  name: string;
  type: string;
  prompt?: string;
  draftPath?: string;
  line?: number;
  before?: string;
  after?: string;
}

export function formatWorkflowHoleNotification(input: WorkflowHoleNotificationInput): string {
  const lines = [
    ...SYSTEM_NOTIFICATION_BANNER,
    "<workflow-hole>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <hole-id>${escapeXml(input.holeId)}</hole-id>`,
    `  <name>${escapeXml(input.name)}</name>`,
    `  <type>${escapeXml(input.type)}</type>`,
  ];
  if (input.prompt !== undefined && input.prompt.length > 0) {
    lines.push(`  <prompt>${escapeXml(input.prompt)}</prompt>`);
  }
  if (input.draftPath !== undefined) lines.push(`  <draft>${escapeXml(input.draftPath)}</draft>`);
  if (input.line !== undefined) lines.push(`  <line>${input.line}</line>`);
  if (input.before !== undefined) lines.push(`  <before>${escapeXml(input.before)}</before>`);
  if (input.after !== undefined) lines.push(`  <after>${escapeXml(input.after)}</after>`);
  const where =
    input.before !== undefined && input.after !== undefined
      ? ` between phases "${input.before}" and "${input.after}"`
      : input.before !== undefined
        ? ` after phase "${input.before}"`
        : input.after !== undefined
          ? ` before phase "${input.after}"`
          : "";
  const draft =
    input.draftPath === undefined
      ? "Read the run's script with GetWorkflowRun for the context"
      : `Read the draft at ${input.draftPath}${input.line === undefined ? "" : ` (the hole is on line ${input.line})`} for the context`;
  lines.push(
    "</workflow-hole>",
    "",
    `Workflow run ${input.runLabel} (${input.runId}) reached the hole "${input.name}" (${input.holeId})${where} and is waiting for you to write its body.`,
    `Next step: ${draft}, write the statements of the hole's function, and call FillWorkflowHole with run_id="${input.runId}" and hole_id="${input.holeId}" and the body as \`script\`.`,
    `The body is compiled where the hole stands and sees every binding declared before it; it must return a value of type \`${input.type}\` — or, when the next step is not known yet, do one step and end with a new tail hole of the same type named for the next step (\`return await hole<${input.type}>("…", …)\`); the last fill returns. Write only the statements — not the hole call, not an arrow, not the script around it.`,
    "Only this branch of the script is parked — every other subagent and the rest of the control flow keep going. So do not drop what you are doing, but do not leave it unfilled either: nothing times out on its behalf.",
    "If this notification is ever lost, GetWorkflowRun lists the holes this run is still waiting at.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

/**
 * 主代理闲着、run 还欠着决定时的提醒（docs/dynamic-workflow/transcript-and-notifications.md
 * 「Reminding an idle main agent」与「What the model reads」的 `<workflow-blocked>`）。
 *
 * 与升级 / 留白那两条的差别：它们各播报**一个**新出现的义务，这条按 run 汇总**此刻仍开着的全部**
 * 义务——因为发它的前提正是「先前那一轮没有把事办了」（请求失败、没作答就收尾、一轮里漏了一条）。
 * 文案除了逐字的下一步，还必须给模型一条不靠瞎答就能让提醒停下的出路（需要用户就明说、然后收尾），
 * 并如实说还有没有下一次。
 */
export interface WorkflowBlockedNotificationInput {
  runLabel: string;
  runId: string;
  /** 第几次提醒（1 起）与上限。 */
  ordinal: number;
  total: number;
  /** 铸造时刻（epoch ms）；每个决定的等待时长都以它为准。 */
  now: number;
  questions: readonly DynamicWorkflowRunPendingQuestion[];
  /** 只含还在等的留白。 */
  holes: readonly DynamicWorkflowRunHole[];
  draftPath?: string;
}

/** 提醒里各列多少个决定；超出的经 `count` ≠ `shown` 说真话，全量在 GetWorkflowRun。 */
const WORKFLOW_BLOCKED_MAX_LISTED = 8;
/** 提醒里问题 / 上下文正文的界（原通知是 4000；这里是汇总，原文已在历史里）。 */
const WORKFLOW_BLOCKED_TEXT_MAX_CHARS = 2_000;
const MS_PER_MINUTE = 60_000;

function boundBlockedText(value: string): string {
  if (value.length <= WORKFLOW_BLOCKED_TEXT_MAX_CHARS) return value;
  return `${value.slice(0, WORKFLOW_BLOCKED_TEXT_MAX_CHARS - 1)}…`;
}

function waitedMs(now: number, since: number | undefined): number {
  return since === undefined ? 0 : Math.max(0, Math.floor(now - since));
}

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatWorkflowBlockedNotification(input: WorkflowBlockedNotificationInput): string {
  const { questions, holes, now, runId } = input;
  const lines: string[] = [
    ...SYSTEM_NOTIFICATION_BANNER,
    "<workflow-blocked>",
    `  <run-id>${escapeXml(runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <reminder>${input.ordinal} of ${input.total}</reminder>`,
  ];
  const shownQuestions = questions.slice(0, WORKFLOW_BLOCKED_MAX_LISTED);
  if (questions.length > 0) {
    lines.push(`  <open-questions count="${questions.length}" shown="${shownQuestions.length}">`);
    for (const question of shownQuestions) {
      // 匿名子代理落到结构化引用，与升级通知同一条兜底链。
      const subagent = question.actorName ?? question.actor;
      lines.push(
        `    <question id="${escapeXml(question.qid)}" subagent="${escapeXml(subagent)}" waited-ms="${waitedMs(now, question.askedAt)}">`,
        `      <text>${escapeXml(boundBlockedText(question.question))}</text>`,
      );
      if (question.context !== undefined && question.context.length > 0) {
        lines.push(`      <context>${escapeXml(boundBlockedText(question.context))}</context>`);
      }
      lines.push("    </question>");
    }
    lines.push("  </open-questions>");
  }
  const shownHoles = holes.slice(0, WORKFLOW_BLOCKED_MAX_LISTED);
  if (holes.length > 0) {
    lines.push(`  <open-holes count="${holes.length}" shown="${shownHoles.length}">`);
    for (const hole of shownHoles) {
      const line = hole.line === undefined ? "" : ` line="${hole.line}"`;
      lines.push(
        `    <hole id="${escapeXml(hole.siteId)}" name="${escapeXml(hole.name)}" type="${escapeXml(hole.type)}"${line} waited-ms="${waitedMs(now, hole.since)}"/>`,
      );
    }
    lines.push("  </open-holes>");
  }
  if (input.draftPath !== undefined) lines.push(`  <draft>${escapeXml(input.draftPath)}</draft>`);
  lines.push("</workflow-blocked>", "");

  const total = questions.length + holes.length;
  const oldest = Math.max(
    0,
    ...questions.map((question) => waitedMs(now, question.askedAt)),
    ...holes.map((hole) => waitedMs(now, hole.since)),
  );
  const minutes = Math.max(1, Math.round(oldest / MS_PER_MINUTE));
  const what = [
    ...(questions.length > 0 ? [countNoun(questions.length, "question")] : []),
    ...(holes.length > 0 ? [countNoun(holes.length, "hole")] : []),
  ].join(" and ");
  lines.push(
    total === 1
      ? `Workflow run ${input.runLabel} (${runId}) is still waiting on you: ${what} is open, for ${minutes} minutes, and you have not acted on it since your last turn ended.`
      : `Workflow run ${input.runLabel} (${runId}) is still waiting on you: ${what} are open, the oldest for ${minutes} minutes, and you have not acted on them since your last turn ended.`,
  );
  if (questions.length > 0) {
    lines.push(
      "Next step for each question: call ResolveWorkflowQuestion with its id as question_id and your answer.",
    );
  }
  if (holes.length > 0) {
    const context =
      input.draftPath === undefined
        ? `read the run's script with GetWorkflowRun (run_id="${runId}")`
        : `read the draft at ${input.draftPath}`;
    lines.push(
      `Next step for each hole: ${context} for the context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id="${runId}" and its id as hole_id and the body as \`script\`.`,
    );
  }
  if (questions.length > shownQuestions.length || holes.length > shownHoles.length) {
    lines.push(`GetWorkflowRun lists the ones not shown here (run_id="${runId}").`);
  }
  lines.push(
    "If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop.",
    input.ordinal < input.total
      ? "One more reminder follows if nothing changes."
      : "This is the last reminder: nothing further is sent until the user writes or this run's open decisions change.",
    "Either way the parked branches keep waiting; nothing times out on their behalf.",
  );
  return truncateTaskNotification(lines.join("\n"));
}
