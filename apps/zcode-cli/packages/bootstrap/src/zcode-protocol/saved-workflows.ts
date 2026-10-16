// 已保存工作流的 GUI 中枢：workspace 级、无会话的方法。
//
// 与 skills/referenceCatalog 同一条先例：不带 sessionId，每次调用现扫目录——挂载时快照会漏掉
// 用户手改 / 模型刚 SaveWorkflow 落盘的文件。
// 解析器与序列化器只从 @zcode/core 取：这里不解析 frontmatter，也不拼 YAML。
//
// 全局作用域：五个方法的 params 收可选 `scope`（缺省
// `project`）。`global` 时改按本机全局根（`~/.zcode/workflows/`）操作，`workspace` 只是**载体**——
// 处理器对全局档不读它的路径。`workflows/move` 把全局档搬回 `workspace` 项目（只此一向）。
import { unlink, writeFile } from "node:fs/promises";
import { SavedWorkflowMetaSchema, isValidSavedWorkflowName } from "@zcode/contracts";
import {
  listSavedWorkflows,
  moveSavedWorkflow,
  resolveSavedWorkflow,
  savedWorkflowPath,
  savedWorkflowRoot,
  serializeSavedWorkflow,
  type SavedWorkflowResolveFailure,
} from "@zcode/core";
import {
  ZCODE_WORKFLOWS_RUNS_MAX_LIMIT,
  zcodeWorkflowsDeleteParamsSchema,
  zcodeWorkflowsGetParamsSchema,
  zcodeWorkflowsListParamsSchema,
  zcodeWorkflowsMoveParamsSchema,
  zcodeWorkflowsRunsParamsSchema,
  zcodeWorkflowsUpdateMetaParamsSchema,
  type ZCodeSavedWorkflowRun,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsDeleteResult,
  type ZCodeWorkflowsGetResult,
  type ZCodeWorkflowsListResult,
  type ZCodeWorkflowsMoveResult,
  type ZCodeWorkflowsRunsResult,
  type ZCodeWorkflowsUpdateMetaResult,
} from "@zcode/shared";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { artifactsOf } from "../app/dynamic-workflow-run-observation.js";
import {
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
} from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

// 缺省即 `project`：不给 scope 的旧 GUI 与项目档调用逐字走本项目根，形状不变（版本偏斜）。
function scopeOf(params: { scope?: ZCodeSavedWorkflowScope }): ZCodeSavedWorkflowScope {
  return params.scope ?? "project";
}

export async function listSavedWorkflowsOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsListResult> {
  const params = parseParams(zcodeWorkflowsListParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
  // 中枢的 PROJECT 组只列本项目那一份，全局组只列全局那一份——**永远**传定向 scope，绝不走
  // 无向变体（两根 first-wins 会把 global 混进 project 组，把被遮蔽的 global 从全局组里藏掉）。
  const listed = listSavedWorkflows({ cwd, scope });
  // 扫过的目录（即使不存在也回）：GUI 的文件监听靠它 watch。
  return {
    workflows: listed.entries,
    invalid: listed.invalid,
    dir: savedWorkflowRoot(cwd, scope).dir,
  };
}

export async function getSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsGetResult> {
  const params = parseParams(zcodeWorkflowsGetParamsSchema, rawParams);
  // 定向 scope：`global` 只查全局根、不做遮蔽——中枢的全局组要看到被项目档遮蔽的那份。
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  return {
    ok: true,
    name: resolved.name,
    path: resolved.path,
    scope: resolved.scope,
    meta: resolved.meta,
    script: resolved.script,
  };
}

/**
 * 只改写文件顶部的元数据：读回当前脚本正文，再整文件覆写为 `serialize(newMeta, script)`。
 * 读-改-写在同一次调用内完成；不做三方合并（文件小、单机、用户自己在改）。
 */
export async function updateSavedWorkflowMetaOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsUpdateMetaResult> {
  const params = parseParams(zcodeWorkflowsUpdateMetaParamsSchema, rawParams);
  // shared 与 contracts 的 meta schema 逐字对齐，但序列化器认的是 contracts 那份类型；再过一遍
  // 让「两边漂移」在这里炸成 -32602 而不是写出一个自己读不回来的文件。
  const meta = SavedWorkflowMetaSchema.parse(params.meta);
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  await writeFile(resolved.path, serializeSavedWorkflow(meta, resolved.script), "utf8");
  return { ok: true, path: resolved.path };
}

/**
 * 只按名字删：`isValidSavedWorkflowName` 先于拼路径——这条顺序是路径穿越的防线本身
 * （store.ts 的同一论证），所以协议不收路径、也不接受 `..`。按 scope 选根（不再写死 roots[0]）：
 * `global` 删本机全局根那一份。同名的 legacy `.workflow.js` 是另一套解析器的文件，不在视野里。
 */
export async function deleteSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsDeleteResult> {
  const params = parseParams(zcodeWorkflowsDeleteParamsSchema, rawParams);
  if (!isValidSavedWorkflowName(params.name)) {
    return { ok: false, reason: "invalid_name" };
  }
  const root = savedWorkflowRoot(params.workspace.workspacePath, scopeOf(params));
  const path = savedWorkflowPath(root, params.name);
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "read_error", detail: describeError(error) };
  }
  return { ok: true, path };
}

/**
 * run 历史，按 `dwf_run.name` 归属到工作流。只读 journal：中枢在任何会话之外，看不到
 * 「submit 已回、行未落」的注册表间隙——那几个微任务靠下一次刷新补上，不值得为它把中枢绑到会话。
 * journal 缺席（注入的测试 store、无内省查询的实现）回空页而不是抛错：中枢据此显示「尚未运行」。
 *
 * `project`（缺省）：只查 `dwf_run.cwd === workspacePath`。`global`：**不**按 cwd 过滤，跨所有项目
 * 取该名字的运行历史（全局工作流在任何项目里跑，历史因此跨 cwd）；每行回 `cwd` 供 GUI 标项目。
 */
export async function listSavedWorkflowRunsOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsRunsResult> {
  const params = parseParams(zcodeWorkflowsRunsParamsSchema, rawParams);
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  if (journal === undefined || !supportsRunIntrospection(journal)) return { runs: [] };
  const limit = Math.min(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT, params.limit);
  const global = scopeOf(params) === "global";
  // 多取一条**只为判定 truncated**（run service 的同一惯例）。
  // 全局变体省掉 cwd 谓词（journal 的 cwd 可选 = 跨所有项目）；项目变体传 cwd，逐字不变。
  const rows = journal.listRuns({
    ...(global ? {} : { cwd: params.workspace.workspacePath }),
    limit: limit + 1,
    ...(params.name === undefined ? {} : { name: params.name }),
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  // 产物汇总：每行一次 `listArtifactRows`（journal 的持久家），只在能力在场时做——缺席即
  // 整字段缺席，中枢的 chips 就不画。**只对这一页的行**取数，所以代价与页大小同阶（≤ 50）。
  const artifactsByRun = savedWorkflowRunArtifacts(journal, page);
  const runs: ZCodeSavedWorkflowRun[] = page.map((row) => ({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    status: row.status,
    ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
    spentTokens: row.spentTokens,
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    ...(row.args === undefined ? {} : { args: row.args }),
    // 实际运行的项目目录：全局变体用它给每行标项目；项目变体里它恒等于 workspacePath，无害。
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    ...(artifactsByRun.get(row.runId) === undefined
      ? {}
      : { artifacts: artifactsByRun.get(row.runId)! }),
  }));
  return { runs, ...(truncated ? { truncated: true } : {}) };
}

/** 中枢 chips 上界：一行画得下的 kind 图标数（协议 schema 的 `.max(8)` 同值）。 */
const SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT = 8;

/**
 * 一页 run 行 → 每行的**用户面产物**摘要。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值
 * （引擎内部的 `RunSettlement.artifact`）。
 *
 * 取数经 {@link artifactsOf}：与快照 / `GetWorkflowRun` **同一条归并规则**（只收 completed 行、
 * 同 id 按版本升序、顶层字段取最新版），中枢自己再写一遍就会让同一个 run 的产物在中枢和侧板
 * 上长得不一样。`listArtifactRows` 不在引擎端口上，所以能力探测在 `artifactsOf` 内部完成：
 * 缺席 ⇒ 每行都拿不到条目 ⇒ 字段整个缺席（老 CLI / 注入的测试 store 逐字不变）。
 *
 * 零件的 run 不进表——调用方据此让整字段缺席，而不是发一个空数组。
 */
function savedWorkflowRunArtifacts(
  journal: JournalStorePort,
  page: readonly { runId: string }[],
): Map<string, ZCodeSavedWorkflowRun["artifacts"]> {
  const byRun = new Map<string, ZCodeSavedWorkflowRun["artifacts"]>();
  for (const row of page) {
    const { artifacts } = artifactsOf(row.runId, journal);
    if (artifacts === undefined || artifacts.length === 0) continue;
    byRun.set(
      row.runId,
      artifacts.slice(0, SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT).map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        ...(artifact.title === undefined ? {} : { title: artifact.title }),
        version: artifact.version,
        ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
      })),
    );
  }
  return byRun;
}

/**
 * 把本机全局根的同名文件搬到 `workspace` 项目根（只此一向：项目→全局是模型的概括「提升为全局」，不是搬文件）。逐字节搬
 * （frontmatter 不存 scope），不覆盖（目标已存在即拒绝，不变式 7）。名字先验后拼路径。
 * `workspace` 既是载体也是目标项目：core 据它的 cwd 与本机 home 算出两个根。
 */
export async function moveSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsMoveResult> {
  const params = parseParams(zcodeWorkflowsMoveParamsSchema, rawParams);
  const result = moveSavedWorkflow({ cwd: params.workspace.workspacePath, name: params.name });
  if (result.ok) {
    return { ok: true, from: result.from, to: result.to };
  }
  // core 的失败分支与协议 result 逐字对齐；path / detail 在场时原样带出（缺席即省键）。
  switch (result.reason) {
    case "invalid_name":
      return { ok: false, reason: "invalid_name", detail: result.detail };
    case "not_found":
      return { ok: false, reason: "not_found" };
    case "target_exists":
      return { ok: false, reason: "target_exists", path: result.path };
    case "read_error":
    case "write_error":
      return { ok: false, reason: result.reason, path: result.path, detail: result.detail };
  }
}

function toFailure(failure: SavedWorkflowResolveFailure) {
  switch (failure.reason) {
    case "invalid_name":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
    case "not_found":
      return { ok: false as const, reason: failure.reason };
    case "parse_error":
    case "read_error":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
