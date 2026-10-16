import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunOverlay } from "@/components/workflow-graph/run-status.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { TimelinePill } from "./timeline-model.js";

// 原在 timeline-model.ts；dwf-recursive 与 dwf-pipeline-display 合并后那个文件到了 430 行（oxlint
// max-lines 上限 400）。药丸的活动标签只读 display 与 run，不参与模型折叠，所以单独成文件。

/** 一枚药丸「正在做什么」：优先正在跑的 step 的 label，其次最后一个已结算的，再次第一个。 */
export function pillActivity(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  pill: TimelinePill,
): { label: string; asks: number; reads: number } {
  const stepsById = new Map(graph.steps.map((step) => [step.id, step]));
  const statuses = run === undefined ? {} : workflowRunOverlay(run, graph).statuses;
  let asks = 0;
  let reads = 0;
  let running: string | undefined;
  let done: string | undefined;
  let first: string | undefined;
  for (const id of pill.stepIds) {
    const step = stepsById.get(id);
    // 留白自己的站点（kind `hole`）不是 ask，也不给药丸标签。
    if (step === undefined || step.kind === "hole") continue;
    if (step.kind === "world-read") reads += 1;
    else asks += 1;
    first ??= step.label;
    const status = statuses[id];
    if (status === "running") running ??= step.label;
    else if (status === "done" || status === "failed") done = step.label;
  }
  return { asks, label: running ?? done ?? first ?? "", reads };
}
