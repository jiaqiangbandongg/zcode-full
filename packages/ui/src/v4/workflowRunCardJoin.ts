import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES,
  type ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { readWorkflowHoleTarget } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";

/**
 * 工具卡 → dwf run 的联接（docs/dynamic-workflow/presentation.md「The tool row」）。
 *
 * 权威来源是 `workflowRuns` 投影里每条 run 的 `toolCallId`（schema 注释就写着它是
 * 「工具卡 → 详情页的关联键」）；工具行自己的 output 在 v4 下只剩
 * `formatCreateWorkflowModelContent` 挑出的那句散文，`status` / `backgroundTaskId`
 * 这些结构化字段根本不在行上。
 *
 * 是纯函数而不是组件里的一段 `useMemo`：计数语义（settled vs observed）是这里唯一
 * 值得穷举的规则，而穷举一个 Map 不需要渲染任何东西。
 */
export function buildWorkflowRunByToolCallId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byToolCallId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    // 没有 toolCallId 的 run 没有可点的卡片，不进表。
    if (!run.toolCallId) continue;
    const { settled, total } = workflowRunStepCounts(run);
    byToolCallId.set(run.toolCallId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      // 已排程（observed）而不是全程总数：动态工作流的节点数由脚本在运行时决定。
      nodesTotal: total,
      agents: run.actors.length,
      // 活投影整条带上：卡片内联的时间线要灯、药丸与墨迹。
      run,
      // 可恢复性是状态位（CLI 在 run-settled 载荷上按 resume 门裁定，reducer 搬运），UI 不推导。
      ...(run.resumable === true ? { resumable: true as const } : {}),
    });
  }
  return byToolCallId;
}

/**
 * runId 键的联接表（run 态紧凑可点卡）。
 *
 * ResumeWorkflowRun 的工具行按 toolCallId **永远查不到** run——投影里 run.toolCallId 跨
 * resume 沿用原始 CreateWorkflow 行（「详情页 join 不断链」的刻意语义，勿改）；而 resume 行
 * 的 display 载荷带着 runId（≡ backgroundTaskId ≡ workId），按 runId 联接同一份投影即可。
 * 侧栏 run tab 的身份也是 runId 键，从 resume 行或原始 create 行打开命中同一个 tab。
 */
export function buildWorkflowRunByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byRunId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    const { settled, total } = workflowRunStepCounts(run);
    byRunId.set(run.runId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      nodesTotal: total,
      agents: run.actors.length,
      run,
      ...(run.resumable === true ? { resumable: true as const } : {}),
      // 打开请求的关联键：WorkflowRunSidePane 拿它找 CreateWorkflow 发起行（图与脚本
      // 都在那条行上）。resume 行自己的 id 不能用——它的 display 里没有图。
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
    });
  }
  return byRunId;
}

/**
 * 打开侧栏 run 视图时请求里的 `toolCallId` 该填谁。不是「点中的那一行」，而是**发起 run 的
 * CreateWorkflow 行**——`WorkflowRunSidePane` 用它去行窗口找发起行（causalityGraph 与脚本
 * 原文挂在那条行的 display/入参上；resume 行的 display 里没有图，填它自己会让详情页落
 * 「可见历史里没有这张工作流图」）。联接摘要带投影的 `toolCallId` 时恒用投影值；缺席
 * 回落点中行的 id——create 行点开时两者本就相等。
 *
 * 顺带挡住覆盖污染：`openWorkflowRunSidePane` 对已存在 tab 做 `{...existing, ...nextTab}`
 * 合并，请求里若带错 id 会把原本正常的 tab 也写坏。
 */
export function resolveWorkflowRunOpenToolCallId(
  rowToolCallId: string,
  workflowRun: WorkflowRunCardSummary | undefined,
): string {
  return workflowRun?.toolCallId ?? rowToolCallId;
}

/**
 * runId → 该 run 当前停驻的 qid 集合。Workflow 通知 manifest 的 Waiting→Answered 翻转的唯一数据源。
 *
 * 键在场 ⟺ run 在投影里（冷回放后终态 run 的 pendingQuestions 已被 reducer 的 run-settled 清空）；值是一个 Set（可能为空 = 已答完最后
 * 一个），缺键 = run 不在场（被 8 条上限淘汰，中性 Question）。
 *
 * pendingQuestions 零条时整个键缺席（workflow-runs schema 的既有惯例），坍缩成空 Set。
 */
export function buildWorkflowRunPendingQuestionsByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byRunId = new Map<string, ReadonlySet<string>>();
  for (const run of runs ?? []) {
    byRunId.set(run.runId, new Set((run.pendingQuestions ?? []).map((question) => question.qid)));
  }
  return byRunId;
}

/**
 * 一行上挂着的「发起图」：图是 **run** 的属性，
 * 按发起该 run 的 toolCallId 找，不问它挂在哪种行上——
 * - CreateWorkflow 工具行：`display.kind === "create_workflow"` 的 `causalityGraph`；
 * - 中枢直接启动没有工具行：图挂在启动轮 turnHeader / userInput 行
 *   的 `workflowLaunch` 元数据上（同一个 toolCallId、同一个 display schema）。
 *
 * 空图（脚本里一次 ask / files.* 都没有）不值得一条空轨道，按「无图」处理；与工具卡同一条判定。
 */
function workflowGraphOfRow(
  row: ConversationRow,
): { toolCallId: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind === "toolCall") {
    const display = row.display;
    if (display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: row.toolCallId, graph }
      : undefined;
  }
  if (row.kind === "turnHeader" || row.kind === "userInput") {
    const launch = row.workflowLaunch;
    const display = launch?.display;
    if (launch === undefined || display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: launch.toolCallId, graph }
      : undefined;
  }
  return undefined;
}

/**
 * 发起 toolCallId → 图的联接表，行窗口一遍建成。轮尾 run 卡（三种来源：CreateWorkflow 行、
 * ResumeWorkflowRun 行、直接启动轮）与 run 详情 / 脚本 transcript 侧板都从这一张表取图——
 * 「图按发起 toolCallId 找」只有这一处实现。行窗口是有界的，老对话里翻不到发起行是正常情况，
 * 不是错误：此时没有图可给，卡片退成单行表头、侧板念一句「图不可用」。
 */
export function buildWorkflowGraphByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowCausalityGraphData> {
  const byToolCallId = new Map<string, WorkflowCausalityGraphData>();
  for (const row of rows ?? []) {
    const found = workflowGraphOfRow(row);
    // 启动轮的 turnHeader 与 userInput 各带一份同样的元数据：首见即定。
    if (found !== undefined && !byToolCallId.has(found.toolCallId)) {
      byToolCallId.set(found.toolCallId, found.graph);
    }
  }
  return byToolCallId;
}

/**
 * runId → 最新一次成功补全的 display（docs/dynamic-workflow/presentation.md「Holes on the timeline」的
 * 「The model」）：`FillWorkflowHole` 行的输出是 `CreateWorkflowOutput`，它的 `causalityGraph` 是**有效脚本**
 * 的图——留白的体已经站在留白的位置上。卡与侧板取「run id 是自己的、最新的那份 display」：补全之后是
 * 补全行的，之前是发起行的。行窗口按序一遍，后来的覆盖先来的；只认成功且编过的行（编不过的补全什么
 * 都没接进 run，它的图不是这条 run 的）。名字从 display 的 `fill` 块带出（补全后的留白在图上没有落点；
 * 行的入参里没有名字——transcript 只存模型自己的入参）；类型不上界面。
 */
export interface WorkflowFillGraph {
  graph: WorkflowCausalityGraphData;
  holeLabels: ReadonlyMap<string, { name: string }>;
}

function readFillRow(
  row: ConversationRow,
): { runId: string; holeId: string; name?: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind !== "toolCall" || row.status !== "success") return undefined;
  if (!isFillWorkflowHoleToolCall(row)) return undefined;
  const display = row.display;
  if (display?.kind !== "create_workflow" || display.ok !== true) return undefined;
  const graph = display.causalityGraph;
  if (graph === undefined || graph.steps.length === 0) return undefined;
  const target = readWorkflowHoleTarget(row.input, display.fill);
  if (target?.runId === undefined || target.holeId === undefined) return undefined;
  return {
    runId: target.runId,
    holeId: target.holeId,
    ...(target.name === undefined ? {} : { name: target.name }),
    graph,
  };
}

export function buildWorkflowFillGraphByRunId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowFillGraph> {
  const byRunId = new Map<string, WorkflowFillGraph>();
  for (const row of rows ?? []) {
    const fill = readFillRow(row);
    if (fill === undefined) continue;
    // 名字跨补全累积：第二次补全的图上仍有第一次的头，它的名字只在第一行的入参里。
    const labels = new Map(byRunId.get(fill.runId)?.holeLabels ?? []);
    if (fill.name !== undefined) labels.set(fill.holeId, { name: fill.name });
    byRunId.set(fill.runId, { graph: fill.graph, holeLabels: labels });
  }
  return byRunId;
}

/** 卡与侧板取图的唯一入口：补全过就是补全行的图，否则按发起 toolCallId（含「配置」的借图规则）。 */
export function resolveWorkflowRunGraphForRun(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  fills: ReadonlyMap<string, WorkflowFillGraph> | undefined,
  toolCallId: string | undefined,
  runId: string | undefined,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const fill = runId === undefined ? undefined : fills?.get(runId);
  if (fill !== undefined) return fill.graph;
  return toolCallId === undefined ? undefined : resolveWorkflowRunGraph(graphs, toolCallId, runs);
}

/** 「配置」修订出来的 run 的发起 toolCallId 前缀（agent 铸 `settings-<uuid>`，docs/dynamic-workflow/launch.md）。 */
export const WORKFLOW_SETTINGS_TOOL_CALL_PREFIX = "settings-";

/**
 * 按发起 toolCallId 取图，外加唯一一条借图规则：
 * 「配置」修订出来的 run（`settings-…`）在它的设置轮落地之前——主代理正在一轮对话里，设置轮要等那一轮
 * 结束——行窗口里还没有它的图，此时经 `resumedFrom` 借前驱的图：它的脚本按构造就是前驱那一份。
 * 其他 run 一概不借——改过的脚本画的是另一张图。前驱自己也可能是一次「配置」，所以沿链上溯，带环保护。
 */
export function resolveWorkflowRunGraph(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  toolCallId: string,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const visited = new Set<string>();
  let current: string | undefined = toolCallId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const graph = graphs.get(current);
    if (graph !== undefined) return graph;
    if (!current.startsWith(WORKFLOW_SETTINGS_TOOL_CALL_PREFIX)) return undefined;
    const settingsToolCallId: string = current;
    const run: WorkflowRunState | undefined = runs?.find(
      (candidate) => candidate.toolCallId === settingsToolCallId,
    );
    const predecessorId: string | undefined = run?.resumedFrom;
    current =
      predecessorId === undefined
        ? undefined
        : runs?.find((candidate) => candidate.runId === predecessorId)?.toolCallId;
  }
  return undefined;
}

/**
 * 「模型把这次 run 存成了哪个工作流」的转写（docs/dynamic-workflow/transcript-and-notifications.md
 * 「Which workflow a run is saved as」）：行窗口里成功的 `SaveWorkflow` 行，按它入参认领的
 * `run_id` 归到那条 run 名下。
 *
 * 这是**候选**而不是结论：行只说「模型当时存了这个名字」，文件还在不在、是不是那一份，由
 * agent 侧的 `workflows/forRun` 再解析一遍。所以这里不读 output，也不判断成败之外的任何东西——
 * `status === "success"` 之外的行（编译失败、被拒、还在流式）本来就没有写成文件。
 *
 * 与其他联接同一条纪律：纯函数、一遍行窗口、身份只认入参通道（display 上没有这件事）。
 */
export type WorkflowSaveCandidate = ZCodeWorkflowsForRunCandidate;

function readWorkflowSaveCandidate(
  row: ConversationRow,
): { runId: string; candidate: WorkflowSaveCandidate } | undefined {
  if (row.kind !== "toolCall" || row.toolName !== "SaveWorkflow" || row.status !== "success") {
    return undefined;
  }
  const input = row.input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const runId = typeof record.run_id === "string" ? record.run_id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (runId.length === 0 || name.length === 0) return undefined;
  const scope = record.scope === "global" || record.scope === "project" ? record.scope : undefined;
  return { runId, candidate: { name, ...(scope === undefined ? {} : { scope }) } };
}

export function buildWorkflowSaveCandidatesByRunId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, readonly WorkflowSaveCandidate[]> {
  const byRunId = new Map<string, WorkflowSaveCandidate[]>();
  for (const row of rows ?? []) {
    const found = readWorkflowSaveCandidate(row);
    if (found === undefined) continue;
    const list = byRunId.get(found.runId) ?? [];
    // 同名重存（改了元数据再存一次）只留一个候选：解析一遍与解析三遍答案相同。
    if (list.some((entry) => entry.name === found.candidate.name)) continue;
    // 协议的候选上界在这里就守住：超出部分留最早的那几个（先存下的那份更可能还在）。
    if (list.length >= ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES) continue;
    list.push(found.candidate);
    byRunId.set(found.runId, list);
  }
  return byRunId;
}
