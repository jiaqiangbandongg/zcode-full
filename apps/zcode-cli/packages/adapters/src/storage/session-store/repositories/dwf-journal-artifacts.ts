/**
 * 用户面**产物**的两条宿主读面。
 *
 * ⚠ 这里的 artifact 是脚本**发布给用户看**的交付物（文件 / markdown / 预置看板），不是
 * `RunSettlement.artifact`（脚本的顶层返回值）。两义并存。
 *
 * 为什么住在 `JournalStorePort` **之外**：与 `listRuns` 逐字同一条论证——引擎只按
 * `listNodes` 走自己那条 ordinal 链，从不为「本 run 有哪些产物」「某个看板收到过哪些条目」
 * 负责。把它们加进领域端口，等于要求每个 journal 实现（含引擎自带的内存实现）实现一件
 * 引擎不做的事。消费方按能力探测（`typeof journal.listArtifactRows === "function"`）
 * 决定读面可用性，签名的单一事实源是 `DwfRunIntrospectionQueries`。
 *
 * 为什么住在 dwf-journal.ts **之外**：两条查询只要一个 db 句柄（与 run/actor/node/event
 * 的写入-读取无共享状态），而各自带着一大段「取数源为何是这张表、排序为何是这个」的论证。
 * 与 dwf-journal-codecs.ts 同一种分法。
 */

import type { DatabaseSync } from "node:sqlite";
import type { NodeRecord } from "@zcode/dynamic-workflow";
import { decodeNode, type DwfNodeRow } from "./dwf-journal-codecs.js";
import { listArtifactFieldItems } from "./dwf-journal-fields.js";
import { pageEventRows } from "./dwf-journal-pages.js";

/**
 * {@link listArtifactItems} 的分页袋（游标 = journal sequence）。两道界的规则见
 * dwf-journal-pages.ts：条数到 `limit`、或再加一条就超过 `maxBytes` 时收尾，第一条总是带上。
 *
 * 两者都**必填**，且存储层精确兑现、不加自己的天花板：页大小的缺省与钳制归网关，一条无界的
 * 取数查询是这里唯一不该有的形状。`hasMore` 由这里判定（收尾处后面还有没有行），调用方不必
 * 再靠「多取一条」去猜。
 */
export interface DwfArtifactItemsQuery {
  /**
   * 只返回 sequence **严格大于**该值的条目。游标是「已读到的最后一个 sequence」而不是偏移量，
   * 与 `listEvents` 逐字同一套语义——看板 hook 用的正是它已经在用的那个游标。
   */
  afterSequence?: number;
  limit: number;
  maxBytes: number;
  /**
   * 只取这些字段路径（dwf-journal-fields.ts），每个值至多 `maxValueBytes`；给了它，条目带
   * `fields` 而不带 `item`，`maxBytes` 按取出的字段值计。缺省 = 整条 item。
   */
  fields?: { paths: readonly string[]; maxValueBytes: number };
}

/**
 * 一条喂给某个预置产物的 `report` 条目，**按 journal sequence 定位**。
 *
 * 为什么键是 sequence 而不是 (siteId, ordinal)：UI 的增量取数游标就是 journal 那一套
 * sequence（`afterSequence`，同运行事件查询的形状），而 dwf_node 上没有它。站点坐标仍然随行返回——
 * 揭示动画要一个跨重取稳定的 React key，而 sequence 与坐标都满足。
 */
export interface DwfArtifactItem {
  /** 被报告的 item 原值（任意 JSON；`REPORT_CAPS` 在写入侧已保证有界）。只取字段时缺席。 */
  item?: unknown;
  /** 只取字段时：路径 → 值，走不通的路径不在表里。 */
  fields?: Record<string, unknown>;
  ordinal: number;
  sequence: number;
  siteId: string;
}

/**
 * 本 run 的**产物行**（`kind = 'artifact'`），按落库先后（`order by id`）。
 *
 * 一行 = 一个版本（同 id 再发布是新行、历史保留），所以调用方按 `artifactId` 分组、
 * 从每行的 `result`（`ArtifactVersionRecord`）取版本。排序是**插入序**而不是
 * `order by artifact_id, ordinal`：版本的先后就是落库的先后，而同一个 id 的行天然连续
 * 只是巧合——把展示顺序寄托在它上面，一个交错发布的脚本就会让版本看起来乱序。
 *
 * 失败的发布同样在结果里（`status: "failed"` + `error`）：读面要能说出「这次发布没成
 * 功」，把它筛掉等于让一个用户可见的失败在每张表面上都不存在。
 */
export function listArtifactRows(db: DatabaseSync, runId: string): NodeRecord[] {
  const rows = db
    .prepare("select * from dwf_node where run_id = ? and kind = 'artifact' order by id")
    .all(runId) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

/**
 * 每个预置产物被打了多少条标签 report（看板的数据量，`itemCount`）。`group by` 下推 SQLite，
 * `dwf_node_artifact_idx (run_id, artifact_id)` 正是这个形状——行一条都不读出来。此前宿主把整张
 * 节点表（连同每条 report item）读进内存再在 JS 里数，一个报了 65,536 条的 run 每查一次清单就
 * 解码一遍全部 item（docs/execution-engine.md「Reading the journal」）。
 */
export function countTaggedReports(db: DatabaseSync, runId: string): ReadonlyMap<string, number> {
  const rows = db
    .prepare(
      `
      select artifact_id, count(*) as total from dwf_node
      where run_id = ? and kind = 'report' and artifact_id is not null
      group by artifact_id
      `,
    )
    .all(runId) as unknown as { artifact_id: string; total: number | bigint }[];
  return new Map(rows.map((row) => [row.artifact_id, Number(row.total)]));
}

/**
 * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序分页（看板的取数面）。
 *
 * 取数源是 **dwf_event 而不是 dwf_node**，尽管两张表都记了同一批标签 report。理由是游标：
 * UI 以事件日志那一套 `sequence` 增量拉取，而 dwf_node 上没有 sequence，只有一条
 * (siteId, ordinal) 的复合坐标——在它上面伪造一个全序，等于给同一批数据造第二套游标语义。
 * 于是筛选下推成 `json_extract(payload_json, '$.artifactId') = ?`，`dwf_event_artifact_idx`
 * （0029 的表达式索引）正是这个形状。
 *
 * `type = 'report'` 也入条件：`type` 列是为下推而存的冗余（payload 里也有一份）。少了它，
 * 一条恰好带 `artifactId` 的别种事件（今天只有 `artifact-published`，它带的是嵌套的
 * `artifact.id` 而不是顶层 `artifactId`，但明天未必）会混进看板的数据流。
 *
 * 未打标签的 report 天然被排除：它们的 payload 里根本没有 `artifactId` 键，`json_extract`
 * 给 NULL，而 SQL 的 `= ?` 不匹配 NULL。
 */
export function listArtifactItems(
  db: DatabaseSync,
  runId: string,
  artifactId: string,
  query: DwfArtifactItemsQuery,
): { items: DwfArtifactItem[]; hasMore: boolean } {
  if (query.fields !== undefined) {
    return listArtifactFieldItems(db, runId, artifactId, {
      ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence }),
      fields: query.fields.paths,
      limit: query.limit,
      maxBytes: query.maxBytes,
      maxValueBytes: query.fields.maxValueBytes,
    });
  }
  const { rows, hasMore } = pageEventRows(db, runId, query, {
    sql: " and type = 'report' and json_extract(payload_json, '$.artifactId') = ?",
    params: [artifactId],
  });
  const items = rows.map((row) => {
    // payload 是被 appendEvent 原样 stringify 的 `RunEvent`，因此这里的窄形状与
    // `{ type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }` 同源。
    const payload = JSON.parse(row.payload_json) as {
      instance: { ordinal: number; siteId: string };
      item: unknown;
    };
    return {
      sequence: row.sequence,
      siteId: payload.instance.siteId,
      ordinal: payload.instance.ordinal,
      item: payload.item,
    };
  });
  return { items, hasMore };
}
