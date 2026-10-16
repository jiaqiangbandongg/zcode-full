// ============================================================
// workflow 默认并发：CPU 推导值的唯一实现
// ============================================================
// docs/dynamic-workflow/concurrency.md「Two bounds on a run」：`max(4, min(16, availableParallelism() − 2))`
// 是**默认并发** D——没设 `max_concurrency` 的 run 的上界、进程级治理器每个 provider 桶的起点与
// 空闲重置落点、legacy `Workflow` 工具与 snippet 的并发。它是起点，**不是**上限：用户给的
// `max_concurrency` 高于低于都照用，桶的自动增长到 2D 为止（再往上只随在飞 run 的上界）。
//
// 此前这个数叫「天花板」，run 自己的上界被钳在它之下；用户反馈小机器 / 小远端上只给两个子代理，
// 而子代理等的是远端 provider 而不是本地核——于是去掉上限语义、把地板从 1 抬到 4。
// 公式复制在多处会各自漂移，收敛成这一个函数。

import { availableParallelism as osAvailableParallelism } from "node:os";

/** 默认并发的硬顶（沿用 legacy 并发式）。只管默认值，不管用户给的上界。 */
export const WORKFLOW_DEFAULT_CONCURRENCY_MAX = 16;
/** 地板：核数少的机器与小远端上 `cores − 2` 只剩一两个，而子代理的瓶颈不在本地核。 */
const WORKFLOW_DEFAULT_CONCURRENCY_FLOOR = 4;
/** 给主代理与宿主进程留出的核数。 */
const RESERVED_PARALLELISM = 2;
/**
 * 治理器桶的自动增长倍数：没有在飞 run 要求更多时，cap 靠探测最多爬到 `2 × D`
 * （docs/dynamic-workflow/concurrency.md「The governor」）。
 */
export const WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR = 2;

/**
 * CPU 推导的默认并发。`availableParallelism` 可注入，供测试固定核数（地板/硬顶两条用例）。
 */
export function resolveWorkflowDefaultConcurrency(
  availableParallelism: () => number = osAvailableParallelism,
): number {
  return Math.max(
    WORKFLOW_DEFAULT_CONCURRENCY_FLOOR,
    Math.min(WORKFLOW_DEFAULT_CONCURRENCY_MAX, availableParallelism() - RESERVED_PARALLELISM),
  );
}

/**
 * 请求的并发上界 → 本 run 实际生效的上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。
 *
 * **没有上限**：高于默认与低于默认同样照用——用户要 40 个就给 40 个，provider 的承受力是治理器
 * 的事。缺席 / 非有限数读作「不设自己的界」= 默认并发；非整数向下取整（要「3.7 个在飞的 ask」没有
 * 意义，而向上取整会偷偷越过用户说的数）；地板 1。
 *
 * 提交时定上界与中途 retune 走的**必须**是同一条规则（否则同一个 `max_concurrency` 经两条路会
 * 落成两个数），而那两条路分居 run service 与 retune 两个模块，所以它住在这里。
 */
export function normalizeRunConcurrency(
  requested: number | undefined,
  defaultConcurrency: number,
): number {
  if (requested === undefined || !Number.isFinite(requested)) return defaultConcurrency;
  return Math.max(1, Math.floor(requested));
}
