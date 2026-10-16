// ============================================================
// GetWorkflowRun 的模型面：TaskOutput 式的 XML-ish 块
// ============================================================
// 从 handler 拆出（那份文件已到 400 行
// 上限），情势三块又从这里再拆到 get-workflow-run-format-roster.ts。
//
// 这是一个**纯函数** `(output) => text`：所有时钟读数都已经由 handler 放进 `generatedAt`，
// 格式器自己不碰 `Date.now()`。一次输出因此只有一把尺——同一份输出里的两个「多久以前」
// 永远可比，测试也能逐字钉住整段文本。
//
// 块序是契约（固定顺序）：先一句话说清处境，再是身份与生命周期，再是
// **此刻等着模型做的事**（停驻的问题），然后才是 run 过得怎么样、叙事、收场与路由。

import {
  GetWorkflowRunOutputSchema,
  type GetWorkflowRunOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import { formatWorkflowProviderStopError } from "../../runtime-task/notification.js";
import { formatPublishedArtifactLine } from "../executor/workflow-published-artifacts.js";
import {
  formatWorkflowRunHealthBlock,
  formatWorkflowRunLogTailBlock,
  formatWorkflowRunPhasesBlock,
  formatWorkflowRunSubagentsBlock,
} from "./get-workflow-run-format-roster.js";
import {
  escapeWorkflowRunText,
  formatRelativeAge,
  formatWorkflowRunInstant,
  formatWorkflowRunTimestamp,
  workflowRunAttribute,
} from "./workflow-run-introspection.js";

/** 终态三词：run 已经没有下一步动作了（与摘要侧同集）。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "errored", "stopped"]);

/**
 * 停驻的问题**查不到**时的那一句。这是本工具仅有的两处「把不知道说出口」之一：
 * 沉默会被读成「没有人在等」，而那正是最危险的误读——有 actor 停在那儿，没有超时替它兜底。
 */
const PENDING_QUESTIONS_UNKNOWN =
  "Unknown: pending questions are tracked only by the process that owns the run, and this session does not. Resuming the run will re-ask any question its subagent still needs answered.";

const PENDING_QUESTIONS_INSTRUCTION =
  "Each of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.";

export function formatGetWorkflowRunModelContent(output: unknown): ModelMessageContent {
  const parsed = GetWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return "GetWorkflowRun returned an invalid result.";
  const run = parsed.data;
  const terminal = TERMINAL_STATUSES.has(run.status);

  const blocks = [
    // 情势的一句话排在最前：后面每一块都是它的展开，读者先要知道自己在看什么。
    `<summary>${escapeWorkflowRunText(run.summary)}</summary>`,
    ...identityBlocks(run),
    ...pendingQuestionBlocks(run),
    ...holeBlocks(run),
    formatWorkflowRunHealthBlock(run, terminal),
    ...optionalBlock(formatWorkflowRunPhasesBlock(run, terminal)),
    formatWorkflowRunSubagentsBlock(run),
    formatWorkflowRunLogTailBlock(run),
    usageBlock(run),
    ...outcomeBlocks(run),
    ...routingBlocks(run),
  ];
  return blocks.join("\n\n");
}

function optionalBlock(block: string | undefined): string[] {
  return block === undefined ? [] : [block];
}

/** 身份与生命周期：一个事实一个标签，缺席的事实不留空标签。 */
function identityBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks = [
    `<run_id>${escapeWorkflowRunText(run.runId)}</run_id>`,
    `<label ${workflowRunAttribute("source", run.labelSource)}>${escapeWorkflowRunText(run.label)}</label>`,
    `<status>${escapeWorkflowRunText(run.status)}</status>`,
    ...(run.stopReason === undefined
      ? []
      : [`<stop_reason>${escapeWorkflowRunText(run.stopReason)}</stop_reason>`]),
    ...(run.resumedFrom === undefined
      ? []
      : [`<resumed_from>${escapeWorkflowRunText(run.resumedFrom)}</resumed_from>`]),
    // 只在这个 run 自己压低了并发时在场（端口的「无则缺席」）。一次 AmendWorkflow 省略
    // `max_concurrency` 沿用的就是这个数——模型据此知道修订会继承什么。
    ...(run.maxConcurrency === undefined
      ? []
      : [`<max_concurrency>${run.maxConcurrency}</max_concurrency>`]),
    // 与上一行同一族的 run 级设定：只在这个 run 自己选过子代理模型时在场。
    ...(run.subagentModel === undefined
      ? []
      : [`<subagent_model>${escapeWorkflowRunText(run.subagentModel)}</subagent_model>`]),
    // 同一族：脚本点名的模型，一行一个 `"名字" = 规范串`，只在脚本点名过模型时在场。
    ...(run.modelBindings === undefined || Object.keys(run.modelBindings).length === 0
      ? []
      : [
          `<script_models>\n${Object.entries(run.modelBindings)
            .map(
              ([name, canonical]) =>
                `"${escapeWorkflowRunText(name)}" = ${escapeWorkflowRunText(canonical)}`,
            )
            .join("\n")}\n</script_models>`,
        ]),
    ...(run.supersededBy === undefined
      ? []
      : [`<superseded_by>${escapeWorkflowRunText(run.supersededBy)}</superseded_by>`]),
    `<owned_by_this_session>${run.ownedByThisSession}</owned_by_this_session>`,
  ];
  if (run.possiblyInterrupted) {
    blocks.push(
      "<possibly_interrupted>true — this session cannot confirm the run is still alive</possibly_interrupted>",
    );
  }
  // ISO + 年龄：前者是可核对的事实，后者是读者真正要的那个量。
  blocks.push(
    `<created_at>${formatWorkflowRunInstant(run.generatedAt, run.createdAt)}</created_at>`,
  );
  blocks.push(
    `<updated_at>${formatWorkflowRunInstant(run.generatedAt, run.updatedAt)}</updated_at>`,
  );
  return blocks;
}

/**
 * 停驻中的升级问题，排在健康 / 花名册 / 叙事之前：其余各块都是「这个 run 过得怎么样」，
 * 而这一块是**一件此刻等着模型做的事**——埋在二十行叙事后面，等于把唯一的解除阻塞路径藏起来。
 */
function pendingQuestionBlocks(run: GetWorkflowRunOutput): string[] {
  if (!run.health.pendingQuestionsKnown) {
    return [`<pending_questions>${PENDING_QUESTIONS_UNKNOWN}</pending_questions>`];
  }
  const questions = run.pendingQuestions ?? [];
  if (questions.length === 0) return [];
  const rendered = questions.map((question) => {
    const who = question.actorName ?? question.actor;
    const age = formatRelativeAge(run.generatedAt, question.askedAt);
    const asked =
      age === undefined
        ? `asked at ${formatWorkflowRunTimestamp(question.askedAt)}`
        : `asked ${age}`;
    const lines = [
      `[${escapeWorkflowRunText(question.qid)}] ${escapeWorkflowRunText(who)} ${asked}`,
      escapeWorkflowRunText(question.question),
    ];
    if (question.context !== undefined)
      lines.push(`context: ${escapeWorkflowRunText(question.context)}`);
    return lines.join("\n");
  });
  return [
    `<pending_questions>\n${rendered.join("\n\n")}\n\n${PENDING_QUESTIONS_INSTRUCTION}\n</pending_questions>`,
  ];
}

/**
 * 留白（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」），紧随停驻的问题：等着的留白
 * 与待答问题是同一种「此刻等着模型做的事」，补过的留白列在后面只为让模型知道那一支已经续上。
 * 与 `<amendable>` 同一种路由姿态：块尾点名 FillWorkflowHole 与要传的 hole_id。
 */
function holeBlocks(run: GetWorkflowRunOutput): string[] {
  const holes = run.holes ?? [];
  if (holes.length === 0) return [];
  const rendered = holes.map((hole) => {
    const head = `[${escapeWorkflowRunText(hole.siteId)}] "${escapeWorkflowRunText(hole.name)}": ${escapeWorkflowRunText(hole.type)}`;
    if (hole.state === "waiting") {
      const age = formatRelativeAge(run.generatedAt, hole.since);
      return `${head} — waiting${age === undefined ? "" : ` ${age.replace(/ ago$/u, "")}`}`;
    }
    const age = formatRelativeAge(run.generatedAt, hole.filledAt);
    const by = hole.filledBy === undefined ? "" : ` by ${escapeWorkflowRunText(hole.filledBy)}`;
    return `${head} — filled${age === undefined ? "" : ` ${age}`}${by}`;
  });
  const waiting = holes.filter((hole) => hole.state === "waiting").length;
  const instruction =
    waiting === 0
      ? "Every hole above has been filled; its body is part of the run's script now (see <amendable> to change it)."
      : `Each waiting hole parks one branch of the script until you supply its body, and nothing times out on its behalf. Read the run's draft for context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id="${escapeWorkflowRunText(run.runId)}" and the hole id in brackets as hole_id. The rest of the run keeps running meanwhile.`;
  return [`<holes>\n${rendered.join("\n")}\n\n${instruction}\n</holes>`];
}

/** nodes_observed 是已落库节点的行数，绝不冒充「总步数」：动态工作流没有静态总数。 */
function usageBlock(run: GetWorkflowRunOutput): string {
  const usage = [
    `spent_tokens=${run.usage.spentTokens}`,
    `nodes_observed=${run.usage.nodesObserved}`,
    `nodes_running=${run.usage.nodesRunning}`,
    `nodes_completed=${run.usage.nodesCompleted}`,
    `nodes_failed=${run.usage.nodesFailed}`,
  ].join(" ");
  return `<usage>${usage}</usage>`;
}

/** run 的收场：产物 → 失败 → 用户面产物清单（与完成通知同序）。 */
function outcomeBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks: string[] = [];
  if (run.result !== undefined) {
    // 产物原样进块（不转义）：它可能是一整段 JSON 或代码，转义会让模型读到的与真实产物不同。
    blocks.push(`<result>\n${run.result}\n</result>`);
  }
  if (run.error !== undefined) {
    // provider 停下：`<error>` 是与终态通知同一函数铸出的整块文案（原因 → 动作 → 事实 → 原文），
    // 模型在两条读面上读到的是同一段话；照 `<result>` 的先例原样进块——里面有 `run_id="…"`
    // 这样要让模型照抄的片段，转义成 &quot; 反而让它抄错。其余失败照旧一句 message。
    const body =
      run.error.providerStop === undefined
        ? escapeWorkflowRunText(run.error.message)
        : `\n${formatWorkflowProviderStopError(run.error, run.runId)}\n`;
    blocks.push(`<error ${workflowRunAttribute("code", run.error.code)}>${body}</error>`);
  }
  // 用户面产物排在 result / error **之后**（同完成通知的顺序）：run 的收场是模型首先要读的，
  // 交付物清单是索引。行的格式与完成通知逐字共用一个格式器。
  if (run.artifacts !== undefined && run.artifacts.length > 0) {
    const lines = run.artifacts.map((artifact) =>
      escapeWorkflowRunText(formatPublishedArtifactLine(artifact)),
    );
    blocks.push(`<artifacts count="${run.artifacts.length}">\n${lines.join("\n")}\n</artifacts>`);
  }
  return blocks;
}

/** 路由：被替代 → 只指向后继；否则可恢复与可修订各占一块，各说各的。 */
function routingBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks: string[] = [];
  if (run.stopReason === "superseded") {
    // 被替代的 run 不可 resume（活的是后继），也不该被再次修订——后继才是要修的那一个。
    const successor =
      run.supersededBy === undefined
        ? "its successor"
        : `run ${escapeWorkflowRunText(run.supersededBy)}`;
    blocks.push(
      `<superseded>This run was stopped by an AmendWorkflow and superseded by ${successor}, which owns its unfinished work. Do not resume it (ResumeWorkflowRun will refuse) and do not amend it again; read or amend ${successor} instead.</superseded>`,
    );
    return blocks;
  }
  if (isWorkflowRunResumableOutput(run)) blocks.push(formatResumableHint(run));
  blocks.push(formatAmendableHint(run));
  return blocks;
}

/**
 * 四个 stop reason 同为可恢复，但下一步不同：user 是有人故意停的（只在用户要求时恢复）；provider 要先解决原因；
 * model / interrupted 直接续。提示块把这句话带上，否则模型把用户刚取消的 run 当事故续跑。
 */
function formatResumableHint(run: GetWorkflowRunOutput): string {
  const reasonSentence =
    run.stopReason === "user"
      ? " This run was stopped on purpose by the user: resume it only when the user asks."
      : run.stopReason === "model"
        ? " You stopped this run yourself with TaskStop: resume it unchanged only if that is what the user wants. If you stopped it to fix the script, do not wait — amend it now, see <amendable>."
        : run.stopReason === "provider"
          ? " A provider-side error stopped it: resolve the cause named in <error> with the user before resuming, or it will stop again the same way."
          : "";
  return `<resumable>This run can be continued with ResumeWorkflowRun — it will resume under the same run ID, replaying finished steps and re-dispatching the unfinished ones.${reasonSentence} The script must be byte-for-byte the one this run was started with; to change it, see <amendable>.</resumable>`;
}

/**
 * 修订续跑（amend-resume）的路由提示。与 `<resumable>` **并列而非替代**：两者谓词不同、
 * 动作也不同，所以刻意各占一块、各自把差别说破（同 run 同脚本 vs 新 run 新脚本）。
 *
 * 尾句按状态分叉：脚本真失败是修订的最高价值场景（修 bug 保缓存），而模型的默认反射是
 * 从头重写——那会把已经付过 token 的工作全部作废。
 *
 * **健康地在跑的 run 只给一句**：那时没有任何决定要模型现在做，整段路由论证只是在挤占
 * 它读花名册的注意力；停滞了、或还没起飞、或已经终态，才把完整论证摆出来。
 */
function formatAmendableHint(run: GetWorkflowRunOutput): string {
  // 脚本文件那一句两支都带：健康在跑的那一支
  // 只给一句话，但那句话说的正是「怎么修订」——少了文件就等于让模型去内联重贴整份脚本。
  const scriptSentence =
    run.scriptPath === undefined
      ? ""
      : ` Its script is at ${escapeWorkflowRunText(run.scriptPath)}: edit that file in place and pass \`path: "${escapeWorkflowRunText(run.scriptPath)}"\` to AmendWorkflow instead of a script.`;
  if (run.status === "running" && run.health.stalledSince === undefined) {
    return `<amendable>AmendWorkflow with run_id "${escapeWorkflowRunText(run.runId)}" supersedes this run with a revised script and imports its finished work as cache.${scriptSentence}</amendable>`;
  }
  const tail =
    run.status === "errored"
      ? "This is the highest-value case for it: the script itself failed, so fix the script and re-run — every step that already succeeded is imported instead of being paid for a second time. Do NOT rewrite from scratch."
      : run.status === "completed"
        ? "Use it to extend or refine a finished workflow — added steps run live, unchanged ones cost nothing."
        : run.status === "stopped"
          ? "Use it when the script or a setting needs to change; use ResumeWorkflowRun to continue it unchanged. A run stopped because its script was wrong is amended now, not after the user asks: the cache holds everything that settled before the stop, and waiting buys nothing."
          : "It is still running: if the script is visibly wrong, amend it now — AmendWorkflow stops this run, imports everything that settled so far, and starts the revision in one call. Do not TaskStop it first and do not wait for it to finish.";
  const body = [
    `This run can be superseded by a revised script: call AmendWorkflow with \`run_id: "${escapeWorkflowRunText(run.runId)}"\` and your new script.`,
    "That mints a NEW run and imports this one's finished work as a warm cache — matched per named subagent along its conversation prefix — so steps you did not change settle from cache at zero tokens and only the revised part runs live.",
    // 省略即沿用：不说出来，
    // 模型会为了改一个数把整份脚本再抄一遍。
    "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.",
    tail,
  ].join(" ");
  return `<amendable>${body}${scriptSentence}</amendable>`;
}

/**
 * 可恢复终态的判定谓词，与 `port.resume` 的门**同语义**：
 * `stopped`，不论 reason。**绝不**放宽到 `errored`：脚本真失败的 run replay 会逐字复现失败。
 * 这只是路由预览不是放行承诺，门仍在 port.resume 服务端。
 */
function isWorkflowRunResumableOutput(run: GetWorkflowRunOutput): boolean {
  return run.status === "stopped";
}
