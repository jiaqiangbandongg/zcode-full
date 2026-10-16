// ============================================================
// `hole-reached` → 一条模型可见的 run 中通知（留白）
// ============================================================
// docs/dynamic-workflow/transcript-and-notifications.md 的 `hole` 载荷与「What the model reads」；引擎侧
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。
//
// 从 dynamic-workflow-run-progress.ts 拆出（400 行门），与那里的升级 / 停滞发射器同层、同三条纪律：
// **每条 `hole-reached` 恰好一条通知**（不重发、不催办，丢失后的兜底是 GetWorkflowRun 的 `holes`）；
// **`hole-filled` 不发通知**（补全方就是主代理自己，回执已是那次工具调用的结果）；**绝不抛异常**
// （这是观察面，run 的真相在 journal）。
//
// 与另两条不同的一点：事件载荷只带站点、名字与 prompt，而通知还要念类型、草稿路径与行号、前后
// 阶段——那些是编译产物，住在快照的 `holes[]` 与 `scriptPath` 上。所以这里读一次端口快照（有界：
// 一处留白一次），端口缺席或读不到时退回载荷自己说得出的字段，通知照发、只是少几句。

import type { DynamicWorkflowRunHole } from "@zcode/contracts";
import type { DynamicWorkflowRunProgressPayload, TraceContext } from "../deps.js";
import { formatWorkflowHoleNotification } from "../../runtime-task/workflow-notification-copy.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 留白到达的事件种类（引擎的 `RunEvent.type`）。 */
export const HOLE_REACHED_EVENT_TYPE = "hole-reached";

/** manifest 载荷与通知里 prompt 的界（spec：4000 字符，截断以 `…` 收尾，与升级通知同界）。 */
const WORKFLOW_HOLE_PROMPT_MAX_CHARS = 4_000;
const PROMPT_ELLIPSIS = "…";

export async function notifyHoleReached(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): Promise<void> {
  if (payload.eventType !== HOLE_REACHED_EVENT_TYPE) return;
  const instance = payload.payload.instance as Record<string, unknown> | undefined;
  const siteId = stringField(instance, "siteId");
  const ordinal = numberField(instance, "ordinal");
  const name = stringField(payload.payload, "name");
  if (siteId === undefined || ordinal === undefined || name === undefined) {
    this.logger?.warn?.("Dynamic workflow hole notification skipped: malformed payload", {
      event: "dynamic_workflow.hole.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }

  const snapshot = await readHoleSnapshot(this, payload.runId, siteId, ordinal);
  // 展示名的兜底链与另两条通知同源：registry 条目的 description → runId。
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const prompt = boundPrompt(stringField(payload.payload, "prompt"));
  // 类型、行号与前后阶段来自快照的留白条目；载荷上若也带（未来的引擎版本）以载荷为准。
  const type = stringField(payload.payload, "type") ?? snapshot.hole?.type ?? "unknown";
  const line = numberField(payload.payload, "line") ?? snapshot.hole?.line;
  const before = stringField(payload.payload, "before") ?? snapshot.hole?.before;
  const after = stringField(payload.payload, "after") ?? snapshot.hole?.after;
  const draftPath = stringField(payload.payload, "draftPath") ?? snapshot.scriptPath;
  const reachedAt = numberField(payload.payload, "reachedAt") ?? snapshot.hole?.since;

  const facts = {
    ...(prompt === undefined ? {} : { prompt }),
    ...(draftPath === undefined ? {} : { draftPath }),
    ...(line === undefined ? {} : { line }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId ≡ runId：与该 run 的其余通知同一个展示锚点。
      workId: payload.runId,
      // manifest 载荷（hole 判别分支）：GUI 的留白行按 run 投影的 `holes` 翻三种活状态。
      workflowNotification: {
        kind: "hole",
        siteId,
        ordinal,
        name,
        type,
        ...facts,
        ...(reachedAt === undefined ? {} : { reachedAt }),
      },
    },
    // taskId 让通知继承该 run 的 branchGeneration（迟到通知的 fencing）；丢弃后的兜底是快照查询。
    taskId: payload.runId,
    text: formatWorkflowHoleNotification({
      runLabel,
      runId: payload.runId,
      holeId: siteId,
      name,
      type,
      ...facts,
    }),
    traceContext,
  });
}

/** 读一次快照取这处留白的条目与草稿路径；端口缺席 / 读失败 / 没有条目都只是「没有」。 */
async function readHoleSnapshot(
  runtime: AgentRuntimeInternal,
  runId: string,
  siteId: string,
  ordinal: number,
): Promise<{ hole?: DynamicWorkflowRunHole; scriptPath?: string }> {
  const port = runtime.dynamicWorkflowRunPort;
  if (port === undefined) return {};
  try {
    const snapshot = await port.getTask(runId);
    if (snapshot === undefined) return {};
    const holes = snapshot.holes ?? [];
    const hole =
      holes.find((entry) => entry.siteId === siteId && entry.ordinal === ordinal) ??
      holes.find((entry) => entry.siteId === siteId);
    return {
      ...(hole === undefined ? {} : { hole }),
      ...(snapshot.scriptPath === undefined ? {} : { scriptPath: snapshot.scriptPath }),
    };
  } catch (error) {
    runtime.logger?.warn?.("Dynamic workflow hole notification: snapshot read failed", {
      event: "dynamic_workflow.hole.snapshot_failed",
      module: "core.runtime",
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/** prompt 的界：超出即截到上限并以 `…` 收尾（尾字符落在代理对中间时再退一个码元）。 */
function boundPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  if (prompt.length <= WORKFLOW_HOLE_PROMPT_MAX_CHARS) return prompt;
  let head = prompt.slice(0, WORKFLOW_HOLE_PROMPT_MAX_CHARS - PROMPT_ELLIPSIS.length);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${PROMPT_ELLIPSIS}`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
