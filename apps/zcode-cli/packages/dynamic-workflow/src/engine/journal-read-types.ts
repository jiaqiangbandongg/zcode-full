/**
 * journal 读面的选项词汇表（docs/execution-engine.md「Reading the journal」）。
 *
 * 一条 run 的表随它做过的一切增长：每次调用一行节点，ask 的回答与 world read 的结果在
 * `result_json`，每条 report item 更是存了两份（节点行 + `report` 事件的载荷）。所以没有读者
 * 可以「整表读进内存再过滤」：每次读都说清自己要什么，过滤、计数、分组都在存储层做。
 *
 * 选项是**必填**的而不是带缺省：一次整表读必须在调用点写出 `"all"`，于是它在代码评审与
 * grep 里都看得见，不会借一个缺省参数悄悄回来。
 *
 * 独立成模块：types.ts 顶在 oxlint max-lines 上限（400 行）。
 */

import type { NodeKind, RunEvent } from "./types.js";

/** 事件类型词（`dwf_event.type` 列）。 */
export type RunEventType = RunEvent["type"];

/**
 * 全部节点 kind。`Record<NodeKind, true>` 让新增的 kind 在这里编译失败，而不是被一份手写
 * 列表悄悄漏掉——{@link NON_REPORT_NODE_KINDS} 这类「除了某种之外」的集合都从它派生。
 */
const NODE_KIND_SET: Record<NodeKind, true> = {
  ask: true,
  "world-read": true,
  "world-run": true,
  report: true,
  artifact: true,
};

export const NODE_KINDS: readonly NodeKind[] = Object.keys(NODE_KIND_SET) as NodeKind[];

/** 除 `report` 之外的全部 kind：读「这条 run 做过的事」而不碰报告条目的读者用它。 */
export const NON_REPORT_NODE_KINDS: readonly NodeKind[] = NODE_KINDS.filter(
  (kind) => kind !== "report",
);

/** 节点列表读。行按 `id`（插入顺序）升序，`limit` 作用在过滤之后。 */
export interface ListNodesOptions {
  /** 只返回这些 kind 的行（`kind in (…)`）；`"all"` = 不过滤。空数组得到空列表。 */
  kinds: readonly NodeKind[] | "all";
  /** false = 不读 `result_json`，返回的行上 `result` 缺席（其余列照常）。 */
  withResult: boolean;
  /** 最多返回的行数；缺省不限。 */
  limit?: number;
  /**
   * 结果字节的上界：按行序取行，再加一行就会让已取各行 `result` 的序列化字节数之和超过它时
   * 收尾；第一行总是带上。只在 `withResult: true` 时有意义。终态快照用它把「前 256 条报告」
   * 同时限在 8 MiB 之内——条数上界单独管不住字节。
   */
  maxResultBytes?: number;
}

/** 单行节点读。缺省读整行：点查不是整表读，只有只比对哈希的读者才需要省掉结果。 */
export interface GetNodeOptions {
  /** false = 不读 `result_json`，返回的行上 `result` 缺席。 */
  withResult: boolean;
}

/** 子代理列表读。行按 `id`（插入顺序）升序。 */
export interface ListActorsOptions {
  /** 只返回这个名字的行（`name = ?`）；缺省不过滤。 */
  name?: string;
  /** false = 不读 `persona_json`，返回的行上 `persona` 缺席。 */
  withPersona: boolean;
}

/**
 * 事件列表读（cursor = journal sequence）。事件按 sequence 升序；`types` 过滤先于 cursor 与
 * `limit` 生效，于是分页在过滤后的序列上进行。
 */
export interface ListEventsOptions {
  /** 只返回这些类型的事件（`type in (…)`）；`"all"` = 不过滤。空数组得到空列表。 */
  types: readonly RunEventType[] | "all";
  /**
   * `report` 事件的 `item` 读到哪里为止。`{limit: N}`：本 run 按 sequence 的**第 N 条之后**的
   * 每条 `report` 事件照样返回，但不带 `item`——实例、`artifactId`、出生阶段字段与时间都保留。
   * 剥离发生在存储层（SQLite 的 `json_remove`），被剥掉的 item 从不进入 JS 堆。`item` 缺席只
   * 可能是被剥掉的：`report(undefined)` 在引擎里就被拒绝了。
   *
   * 排名按**本 run 全部 report 事件**的 sequence 计，与 `types` / cursor / `limit` 无关——
   * 「第几条报告」是 run 的事实，不随一页从哪里开始而变。
   */
  reportItems: "all" | { limit: number };
  /** 只返回 sequence **严格大于**该值的事件。cursor 是"已读到的最后一个 sequence"，不是偏移量。 */
  afterSequence?: number;
  /** 单页最多返回的条数；缺省不限。 */
  limit?: number;
}

/** 整条事件日志、report item 不剥：只给真要逐字节重放全部事件的读者（与测试）。 */
export const ALL_EVENTS: ListEventsOptions = { types: "all", reportItems: "all" };
