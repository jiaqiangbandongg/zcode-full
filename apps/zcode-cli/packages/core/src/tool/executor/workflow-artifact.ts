/**
 * workflow run 产物的序列化规则，被 core 内的两处共用：完成通知的 `<result>`（background-tasks.ts）
 * 与 runtime task 条目上的 `resultText`（background-task-registry.ts，TaskOutput 的唯一来源）。
 *
 * 实现**搬到了 `@zcode/contracts`**（`interfaces/dynamic-workflow-run.port.ts`，与
 * `boundDynamicWorkflowRunEventPayload` 同一个接缝），因为它多了第三个消费者：bootstrap 的 v4
 * 投影要用同一条规则算 `workflowRuns.reports[].preview`（详情页 Results 区）。bootstrap 不能
 * import core 的内部模块，而复制一份序列化规则就是「同一个值在通知里和面板上长得不一样」的
 * 来源。这里保留一个再导出，好让 core 侧的两个 import 站点不动。
 */
import { serializeWorkflowArtifact } from "@zcode/contracts";

export { serializeWorkflowArtifact };

/**
 * 完成通知里 `<reports>` 那一节的预算：整节最多这么多字符。
 *
 * 通知端本来就有 120k 的总截断，但那是**最后一道**闸：它先斩到的是排在后面的字段。快照带来的
 * 渐进产物可以有 256 条（`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS`），任由它铺开会把 `<result>` 与
 * `<error>` 挤出通知——而那两个才是模型首先要看的。所以这一节自己带预算。
 */
const WORKFLOW_REPORTS_PREVIEW_MAX_CHARS = 8_000;
/** 单条的界。一条 32KB 的产物不该吃掉整节预算，让后面十条一条也进不来。 */
const WORKFLOW_REPORT_ITEM_MAX_CHARS = 2_000;

interface WorkflowReportsNotificationSection {
  /** **真实总条数**（不是预览里的条数）。 */
  count: number;
  /** 预览里实际给出的条数；小于 count 即预览是局部的。 */
  shown: number;
  preview: string;
}

/**
 * journal 里的 report 条目 → 完成通知的 `<reports>` 一节（completed / failed / cancelled 通用）。
 *
 * 截断与计数**两者都重要**：计数才是让主 agent 知道「预览是局部的、全量可经 run id 取回」的
 * 那个信号。只给预览会让模型以为它看到了全部；只给计数则等于什么产物都没回。
 *
 * `total` 是 run 的真实总条数（快照的 `reportCount`）；`items` 只是它的前若干条（快照截在
 * 256 条处）。缺席时退回 `items.length`——老快照没有这个字段，而那时 `items` 就是全部。
 *
 * 零条时返回 `undefined`，调用方据此让整节缺席——不发一节空的 `<reports>`。
 */
export function buildWorkflowReportsNotificationSection(
  items: readonly unknown[] | undefined,
  total?: number,
): WorkflowReportsNotificationSection | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_REPORT_ITEM_MAX_CHARS);
    const line = `[${index + 1}] ${text}`;
    // 至少给一条：一条超长产物也比"报过 11 条但一条都看不到"有用。
    if (lines.length > 0 && used + line.length + 1 > WORKFLOW_REPORTS_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    count: Math.max(total ?? 0, items.length),
    shown: lines.length,
    preview: lines.join("\n"),
  };
}

/**
 * manifest 载荷（`WorkflowNotificationMeta.reports`）的 `<reports>` 一节。与上面那个
 * **通知文本**用的一节同源同逐条序列化（`serializeWorkflowArtifact`），只是产出 **string[]**
 * 而非拼接好的一段文本——manifest 由 GUI 逐条渲染成编号预览，拼接会让它再拆一次。
 *
 * 界与通知文本那一节刻意不同：这里逐条 ≤500、最多 8 条（同步于 shared 的 `workflowNotificationMetaSchema`——超界会让 turnHeader row 落库时 zod 拒收）。
 * `count` 恒是**真实总条数**：`count ≠ shown` 就是「预览是局部的、全量经 run id 可取」的信号。
 *
 * `total` 与通知那一节同义（快照的 `reportCount`，缺席退回 `items.length`）。
 *
 * 零条时返回 `undefined`，调用方据此让整字段缺席。
 */
export function buildWorkflowReportsManifestSection(
  items: readonly unknown[] | undefined,
  total?: number,
): { count: number; shown: number; preview: string[] } | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const preview: string[] = [];
  for (const item of items) {
    if (preview.length >= WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS) break;
    preview.push(clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS));
  }
  return { count: Math.max(total ?? 0, items.length), shown: preview.length, preview };
}

/** manifest 载荷里逐条产物预览的界（shared schema：≤500 字符）。 */
const WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS = 500;
/** manifest 载荷里预览最多几条（shared schema：≤8 条）。 */
const WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

