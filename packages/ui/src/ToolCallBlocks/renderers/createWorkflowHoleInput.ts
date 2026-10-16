import {
  isSyntheticLaneId,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * FillWorkflowHole 行的目标留白（docs/dynamic-workflow/presentation.md「The fill row」）：`run_id` /
 * `hole_id` 来自行的入参（模型写的）；**名字、草稿路径与行号来自 display 的 `fill` 块**，工具从解析
 * 出的留白写进输出、投影原样带上。入参里的 `hole` 块是 resolveInput 给权限规则回填的，transcript
 * 不存它（2026-09-28 首次接龙实测：只读入参的行标题成了 `hole#1`）——这里仍读它，只为确认窗那条
 * 拿得到解析入参的路，display 在场时以 display 为准。从 createWorkflowInput.ts 拆出（max-lines 门）。
 */
export interface WorkflowHoleTarget {
  runId: string | undefined;
  holeId: string | undefined;
  name: string | undefined;
  draftPath: string | undefined;
  line: number | undefined;
}

/** display 的 `fill` 块（与 shared 的 toolCallCreateWorkflowDisplaySchema.fill 同形），未解析的原样。 */
export interface WorkflowDisplayFill {
  siteId: string;
  name: string;
  draftPath?: string;
  line?: number;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

export function readWorkflowHoleTarget(
  input: unknown,
  fill?: WorkflowDisplayFill,
): WorkflowHoleTarget | undefined {
  if (!isPlainRecord(input)) return undefined;
  const hole = isPlainRecord(input.hole) ? input.hole : undefined;
  const line = fill?.line ?? hole?.line;
  return {
    runId: trimmed(input.run_id),
    holeId: trimmed(input.hole_id) ?? trimmed(fill?.siteId),
    name: trimmed(fill?.name) ?? trimmed(hole?.name),
    draftPath: trimmed(fill?.draftPath) ?? trimmed(hole?.draft_path),
    line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined,
  };
}

/** 补全的体（`script`）：与 CreateWorkflow 的脚本同一通道，流式草稿的笔从它里扫阶段。 */
export function readWorkflowHoleBody(input: unknown): string | undefined {
  return isPlainRecord(input) && typeof input.script === "string" ? input.script : undefined;
}

/**
 * 一次补全写下了几个阶段、几个子代理（「留白已补全 · {name} · {k} 个阶段 · {m} 个子代理」）：
 * 有效脚本的图上带 `fill === holeId` 的阶段与站点。留白自己的阶段（无阶段的补全）不算阶段。
 */
export function workflowFillCounts(
  graph: WorkflowCausalityGraphData | undefined,
  holeId: string,
): { phases: number; agents: number } {
  if (graph === undefined) return { agents: 0, phases: 0 };
  const phases = (graph.phases ?? []).filter((phase) => phase.fill === holeId).length;
  const lanes = new Set<string>();
  for (const step of graph.steps) {
    // 补全写进来的开着的内层留白（kind `hole`、车道 `main`）不是子代理。
    if (step.fill === holeId && step.kind !== "hole" && !isSyntheticLaneId(step.lane)) {
      lanes.add(step.lane);
    }
  }
  return { agents: lanes.size, phases };
}
