import type { TuiSubmitPromptResult } from "@zcode/tui";
import type {
  DynamicWorkflowRunResumeErrorReason,
  DynamicWorkflowRunSessionSummary,
} from "@zcode/contracts";
import type { CommandCenterDeps } from "../types.js";
import { splitArgs } from "../utils.js";
import { isWorkflowModeEnabled, WORKFLOW_DISABLED_NOTICE } from "../../workflow-mode.js";

const DWF_USAGE = "Usage: /dwf [list|cancel [runId]|resume <runId>]";

/** `/dwf list` 的默认条数；服务端自己还有上限，这里只表达「一屏够看」。 */
const DWF_LIST_LIMIT = 20;

/**
 * 非终态 run 的状态集合。`/dwf cancel` 缺 runId 时的候选就是这一集：
 * pending 是「已建未起」，running 是「在飞」，两者都还有可中止的东西；
 * completed / errored / stopped 已结算，取消无意义。
 */
const IN_FLIGHT_STATUSES: readonly DynamicWorkflowRunSessionSummary["status"][] = [
  "pending",
  "running",
];

export async function handleDwfCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const [action = "list", runId] = splitArgs(args);

  if (action === "list") {
    if (!app.listDynamicWorkflowRuns) return unavailable(deps);
    const runs = await app.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    return respond(deps, formatRunList(runs));
  }

  if (action === "cancel") {
    return await handleCancel(runId, app, deps);
  }

  if (action === "resume") {
    // resume 会起引擎，disabled 下在问服务端之前拒绝；list / cancel 不起引擎，照常。
    if (!isWorkflowModeEnabled(deps.workflowMode)) return respond(deps, WORKFLOW_DISABLED_NOTICE);
    if (!runId) return respond(deps, DWF_USAGE);
    if (!app.resumeWorkflowRun) return unavailable(deps);
    const result = await app.resumeWorkflowRun({ workId: runId });
    return respond(
      deps,
      result.ok
        ? `Resumed dynamic workflow run ${result.runId}.`
        : `Cannot resume ${runId}: ${describeResumeRejection(result.reason)} (${result.reason})${result.message === undefined ? "" : `\n${result.message}`}`,
    );
  }

  return respond(deps, DWF_USAGE);
}

async function handleCancel(
  runId: string | undefined,
  app: Awaited<ReturnType<CommandCenterDeps["getApp"]>>,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  if (!app.cancelBackgroundTask) return unavailable(deps);

  let targetRunId = runId;
  if (!targetRunId) {
    // 缺 runId 时只在「恰好一个在飞」时替用户决定。多个候选就列出来让用户点名：
    // 取消是花掉的钱和丢掉的进度，猜错的代价不对称。
    if (!app.listDynamicWorkflowRuns) return respond(deps, DWF_USAGE);
    const runs = await app.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    const inFlight = runs.filter((run) => IN_FLIGHT_STATUSES.includes(run.status));
    if (inFlight.length === 0) {
      return respond(deps, "No in-flight dynamic workflow runs to cancel.");
    }
    if (inFlight.length > 1) {
      return respond(
        deps,
        [
          "Multiple in-flight dynamic workflow runs; pass the run id to cancel one:",
          ...inFlight.map((run) => `- ${formatRunLine(run)}`),
          "",
          "Usage: /dwf cancel <runId>",
        ].join("\n"),
      );
    }
    targetRunId = inFlight[0]!.runId;
  }

  // runId ≡ taskId：workflow run 在后台任务注册表里就是用 runId 登记的。
  const result = await app.cancelBackgroundTask(targetRunId);
  if (!result.cancelled) {
    const reason = result.reason ? `: ${result.reason}` : ".";
    return respond(deps, `Could not cancel ${targetRunId} (${result.status})${reason}`);
  }
  return respond(deps, `Cancelled dynamic workflow run ${targetRunId}.`);
}

function formatRunList(runs: DynamicWorkflowRunSessionSummary[]): string {
  if (runs.length === 0) {
    return "No dynamic workflow runs in this session.";
  }
  return [
    `Dynamic workflow runs (${runs.length}):`,
    ...runs.map((run) => `- ${formatRunLine(run)}`),
    "",
    "Use /dwf cancel <runId> or /dwf resume <runId>.",
  ].join("\n");
}

/**
 * 一行 = `runId · label · status · resumable · updated` + 失败后缀。
 *
 * `label` 与 `updatedAt` 都是 additive optional（老服务端不发这两个键）：标签回落 runId、
 * 时间整段省略。少一列是退化，不是错误——绝不因此把整行藏起来。label 恰好等于 runId 时
 * 不重复印：服务端的兜底最后一档就是 runId，照抄会得到「dwfrun_x dwfrun_x」。
 */
function formatRunLine(run: DynamicWorkflowRunSessionSummary): string {
  const columns = [run.runId];
  const label = run.label ?? run.runId;
  if (label !== run.runId) columns.push(label);
  // stopped 带原因词：`stopped/provider`。
  columns.push(run.stopReason === undefined ? run.status : `${run.status}/${run.stopReason}`);
  // resumable 直接印服务端的裁定，不按 status + failureCode 重新推导：
  // 两处谓词总有一天不一致，届时提示说可恢复而命令被拒。
  if (run.resumable) columns.push("resumable");
  if (run.updatedAt !== undefined) columns.push(`updated ${formatUpdatedAt(run.updatedAt)}`);
  return `${columns.join(" · ")}${formatFailure(run)}`;
}

/**
 * epoch 毫秒 → 可读时间。用本地时区的 ISO 风格短格式：终端用户看的是自己机器上的时间，
 * 而 UTC 的 `Z` 后缀在本地排查时每次都要在脑子里换算一遍。
 */
function formatUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return String(updatedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatFailure(run: DynamicWorkflowRunSessionSummary): string {
  if (!run.failureCode && !run.failureMessage) return "";
  const code = run.failureCode ?? run.status;
  return run.failureMessage ? ` (${code}: ${run.failureMessage})` : ` (${code})`;
}

function describeResumeRejection(reason: DynamicWorkflowRunResumeErrorReason): string {
  switch (reason) {
    case "not_found":
      return "no such run in this session's journal";
    case "not_resumable":
      return "only a stopped run can be resumed (an errored run needs a corrected script via AmendWorkflow)";
    case "superseded":
      return "the run was stopped and superseded by an amended run; that successor is the live one";
    case "already_running":
      return "the run is already in flight";
    case "script_missing":
      return "the recorded run has no script to re-run";
    case "script_mismatch":
      return "the recorded script no longer matches its hash";
    case "compile_failed":
      return "the recorded script no longer compiles against the current workflow facade; rewrite it and use AmendWorkflow";
  }
}

function unavailable(deps: CommandCenterDeps): TuiSubmitPromptResult {
  return respond(deps, "Dynamic workflow runs are not available in this client.");
}

function respond(deps: CommandCenterDeps, response: string): TuiSubmitPromptResult {
  return {
    mode: deps.getMode?.(),
    response,
  };
}
