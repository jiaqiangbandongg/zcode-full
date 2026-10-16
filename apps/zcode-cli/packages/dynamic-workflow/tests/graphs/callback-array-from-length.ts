// Callback invocation family (docs/analysis.md), the motivating
// script: a fan-out written as `Array.from({ length: TOTAL }, (_, i) => agent(...).ask(...))`.
// The mapper is a per-element callback per the registry, so its body is a `fanout` region
// INSIDE phase#1 (not a detached body swept to the end under `unphased`), the worker lane
// carries `within=fan-out#1`, and the summarizer's ask follows the join. Cardinality is
// absent: `{ length: TOTAL }` is not an array literal (the card renders as `many`).
interface Item {
  /** 该 worker 的编号。 */
  id: number;
  /** 一句话：关于数字 id 的一个有趣数学事实。 */
  fact: string;
  /** worker 自评的趣味程度 1-5。 */
  funScore: number;
}

interface WorkflowReport {
  /** 两三句话回答用户问了什么。 */
  conclusion: string;
  /** 全部 50 个 worker 的产物。 */
  items: Item[];
  /** 本次运行检查了什么、怎么检查的。 */
  verified: string[];
  /** 没有覆盖什么、为什么。 */
  notCovered: string[];
}

phase("并发发起 50 个独立 worker");
const TOTAL = 50;
log(`fan-out: ${TOTAL} 个独立 worker，一次性全部发出`);

const items = await Promise.all(
  Array.from({ length: TOTAL }, (_, i) =>
    agent(`worker-${i}`, {
      system: "你是并行压测中的一个微型 worker。只回答分配给你的那一个数字，不要展开多余的上下文。",
    }).ask<Item>(
      `给出关于数字 ${i} 的一个有趣数学事实（一句话），并给它 1-5 的趣味评分。数字本身也要放进返回的 id 字段。`,
    ),
  ),
);

phase("汇总 50 个 worker 的产物");
const summary = await agent("summarizer", {
  system: "你汇总并行 worker 的结果，只输出简洁的中文摘要。",
}).ask<string>(
  `以下是 ${TOTAL} 个并行 worker 各自返回的数字事实（JSON 数组）。写 2-3 句总结：覆盖了哪些数字、平均趣味评分大约多少、最有意思的几条是什么。\n${JSON.stringify(items)}`,
);

const avg = items.reduce((s, it) => s + (it.funScore || 0), 0) / Math.max(items.length, 1);
const result: WorkflowReport = {
  conclusion: `50 个 worker 全部并发完成，平均趣味评分 ${avg.toFixed(1)}。汇总者点评：${summary}`,
  items,
  verified: [`全部 ${items.length}/${TOTAL} 个 worker 都返回了带 id、fact、funScore 的产物`],
  notCovered: ["这是纯并行度演示，worker 结果未做独立复核"],
};
return result;
