// 从一次 run 出发的两个方法（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）：把这次 run 跑过的脚本存成定义，以及回答
// 「这次 run 对应哪个已保存工作流」。
//
// 与 saved-workflows.ts 同一条纪律（解析器、序列化器、名字规则与类型检查器都只从 @zcode/core 取，
// 不变式 3），分文件只为守住 400 行的门。
//
// 为什么保存**不收脚本**只收 runId：要写下去的正文是这次 run 实际执行的那一份，而它在 journal
// 里（`scriptText`）。经由调用方转一圈有两处会坏：修订过的 run 该存**结算它的**那一份，而工具行
// 入参被快照裁成预览的老对话里，调用方手上根本没有完整脚本。
import {
  SavedWorkflowMetaSchema,
  isValidSavedWorkflowName,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import {
  analyzeScript,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  type ResolvedSavedWorkflow,
} from "@zcode/core";
import {
  zcodeWorkflowsForRunParamsSchema,
  zcodeWorkflowsSaveParamsSchema,
  type ZCodeSavedWorkflowEntry,
  type ZCodeWorkflowsForRunResult,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import type { RunRecord } from "@zcode/dynamic-workflow";
import { resolveDynamicWorkflowJournalStore } from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 诊断回给 GUI 的上界：弹层里只放得下开头几条，完整诊断属于模型那条路。 */
const SAVE_DIAGNOSTICS_MAX_LINES = 5;
const SAVE_DIAGNOSTICS_MAX_CHARS = 1_000;

/**
 * 脚本比对要扫的文件数上界。一个项目的定义是个位到两位数量级；给个常数只为让异常目录
 * （有人把几千个文件倒进 `.zcode/workflows/`）不至于把一次查询变成一次全盘读。
 */
const SCRIPT_MATCH_SCAN_LIMIT = 50;

function scopeOf(params: { scope?: SavedWorkflowScope }): SavedWorkflowScope {
  return params.scope ?? "project";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDiagnostics(
  diagnostics: readonly { line: number; column: number; message: string }[],
): string {
  const text = diagnostics
    .slice(0, SAVE_DIAGNOSTICS_MAX_LINES)
    .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
    .join("\n");
  return text.length > SAVE_DIAGNOSTICS_MAX_CHARS
    ? `${text.slice(0, SAVE_DIAGNOSTICS_MAX_CHARS)}…`
    : text;
}

/** 解析结果 → 协议 entry（与 `workflows/list` 的行同形，不含脚本正文）。 */
function entryOf(resolved: ResolvedSavedWorkflow): ZCodeSavedWorkflowEntry {
  return {
    name: resolved.name,
    description: resolved.meta.description,
    ...(resolved.meta.whenToUse === undefined ? {} : { whenToUse: resolved.meta.whenToUse }),
    ...(resolved.meta.args === undefined ? {} : { args: resolved.meta.args }),
    scope: resolved.scope,
    path: resolved.path,
  };
}

function runRecordOf(
  context: ZCodeProtocolAgentServerContext,
  runId: string,
): RunRecord | undefined {
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  return journal?.getRun(runId);
}

/**
 * 完成卡的「直接保存」：按 runId 取脚本、按 SaveWorkflow 的同一套规则落盘。
 *
 * 顺序有意与工具一致：名字合法性 → 脚本可得 → 覆盖判定 → 类型检查 → 写。覆盖排在类型检查
 * 之前，是因为「已经有同名的了」是调用方要先回答的问题，而编译失败时本来就一个字节都不会写。
 */
export async function saveSavedWorkflowFromRunOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsSaveResult> {
  const params = parseParams(zcodeWorkflowsSaveParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
  // 名字先验后拼路径：这条顺序是路径穿越的防线本身（store.ts 的同一论证）。
  if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
  // shared 与 contracts 的 meta schema 逐字对齐，但序列化器认的是 contracts 那份；再过一遍，
  // 让「两边漂移」炸在这里，而不是写出一个自己读不回来的文件（updateMeta 的同一条）。
  const meta = SavedWorkflowMetaSchema.parse(params.meta);

  const record = runRecordOf(context, params.runId);
  if (record === undefined) return { ok: false, reason: "run_not_found" };
  const script = record.scriptText;
  // scriptText 落库始于 workflow-live-run；更早的记录没有可保存的脚本原文。
  if (script === undefined) return { ok: false, reason: "script_missing" };

  const path = savedWorkflowPath(savedWorkflowRoot(cwd, scope), params.name);
  // 覆盖是用户的决定，不是一次保存的副作用：没说要覆盖就拒绝，由调用方把警告摆出来再来一次。
  if (params.overwrite !== true && savedWorkflowExists({ cwd, name: params.name, scope })) {
    return { ok: false, reason: "target_exists", path };
  }

  const analysis = analyzeScript(script);
  if (!analysis.ok) {
    return {
      ok: false,
      reason: "compile_failed",
      path,
      detail: boundedDiagnostics(analysis.diagnostics),
    };
  }

  const shadowing = findSavedWorkflowShadowing({ cwd, name: params.name, scope });
  try {
    const written = saveSavedWorkflow({ cwd, name: params.name, meta, script, scope });
    return {
      ok: true,
      name: params.name,
      scope: written.scope,
      path: written.path,
      // 写的那一刻重新判定，不回抄入参（SaveWorkflow handler 的同一条理由）。
      overwritten: written.overwritten,
      ...(shadowing === undefined ? {} : { shadowing }),
    };
  } catch (error) {
    // 写失败（只读挂载、权限）是一条业务分支，不是协议错误：GUI 要把它画在弹层里。
    return { ok: false, reason: "write_error", path, detail: describeError(error) };
  }
}

/**
 * 「这次 run 对应哪个已保存工作流」。三条规则按序命中即返回（spec 的同一顺序）：
 *
 * 1. **对话说的**：模型用 SaveWorkflow 存过并认领了这次 run（入参 `run_id`），调用方把名字
 *    转写成候选交上来。这里仍要解析一遍——用户后来把那份删了，它就不再是事实。
 * 2. **run 跑的**：某份定义的正文与这次 run 存下的脚本逐字节相同。GUI 的「直接保存」按构造
 *    落在这一条上，而且在对话不在了之后依然成立。
 * 3. **run 叫的**：某份定义的名字与 run 名相同——中枢把运行历史归属到工作流用的就是这条规则，
 *    所以从中枢启动的 run 天然「已保存」。
 *
 * 查不到 run 记录时只跳过 2、3（候选仍然算数）：一条查不到的 run 不该让整个查询失败。
 */
export async function findSavedWorkflowForRunOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsForRunResult> {
  const params = parseParams(zcodeWorkflowsForRunParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const record = runRecordOf(context, params.runId);
  // 实参与命中与否无关：它服务的是「再次运行」的实参窗预填，run 在就给。
  const runArgs = record?.args === undefined ? {} : { runArgs: record.args };

  for (const candidate of params.candidates ?? []) {
    if (!isValidSavedWorkflowName(candidate.name)) continue;
    const resolved = resolveSavedWorkflow({
      cwd,
      name: candidate.name,
      ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
    });
    if (resolved.ok) return { entry: entryOf(resolved), match: "candidate", ...runArgs };
  }

  const script = record?.scriptText;
  if (script !== undefined) {
    // 项目档先于全局档：同名遮蔽的方向就是这个方向，内容相同时也该报本项目那一份。
    for (const scope of ["project", "global"] as const) {
      const listed = listSavedWorkflows({ cwd, scope });
      for (const entry of listed.entries.slice(0, SCRIPT_MATCH_SCAN_LIMIT)) {
        const resolved = resolveSavedWorkflow({ cwd, name: entry.name, scope });
        if (resolved.ok && resolved.script === script) {
          return { entry: entryOf(resolved), match: "script", ...runArgs };
        }
      }
    }
  }

  const name = record?.name;
  if (name !== undefined && isValidSavedWorkflowName(name)) {
    // 不定向：项目档 first-wins，与中枢之外的所有按名查找同规。
    const resolved = resolveSavedWorkflow({ cwd, name });
    if (resolved.ok) return { entry: entryOf(resolved), match: "name", ...runArgs };
  }

  return { ...runArgs };
}
