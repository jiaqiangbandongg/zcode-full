/**
 * dwf_event 上按条数**与字节**两道界分页的读（docs/execution-engine.md「Reading the journal」）：
 * 事件日志一页（{@link listEventPage}）与看板条目一页（dwf-journal-artifacts.ts 的
 * `listArtifactItems`）共用这一条查询。
 *
 * 页的规则：按 sequence 升序取行，条数到 `limit`、或再加一行就会让本页载荷的字节数超过
 * `maxBytes` 时收尾；第一行总是带上（一行超过 `maxBytes` 的载荷自成一页，否则翻页永远卡住）。
 * `hasMore` 在这里就能说准：收尾时后面那一行存在与否。
 *
 * 为什么是一条带窗口的查询而不是在 JS 里逐行累加：窗口只作用在 `octet_length(payload_json)`
 * 上，而 SQLite 对 `octet_length` 只读行头里的长度、不碰载荷本身（实测 1.5 GB 的 report 行
 * 求和 0.7 ms，`length()` 要 541 ms）。于是「哪几行进页」在不读任何载荷的前提下就定了；外层
 * 的 `case` 是惰性的，只有进页的行才真的把载荷读出来——收尾处那一行（它的存在就是 `hasMore`）
 * 连同它可能 1 MiB 的 item 一个字节都不读。
 */

import type { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "@zcode/dynamic-workflow";
import { decodeEvent } from "./dwf-journal-codecs.js";

/** 分页袋：cursor 严格大于、两道界同时生效。 */
export interface DwfEventPageQuery {
  afterSequence?: number;
  limit: number;
  maxBytes: number;
}

/** 进页的一行（载荷原文，解码归调用方）。 */
export interface DwfEventPageRow {
  payload_json: string;
  sequence: number;
  time_created: number;
  type: string;
}

/**
 * 在 `run_id = ?` 之外再加的筛选（如看板的 `type = 'report' and json_extract(...) = ?`）。
 * `sql` 以 ` and ` 开头；参数按出现顺序绑定。
 */
export interface DwfEventPageFilter {
  params: readonly (string | number)[];
  sql: string;
}

const NO_FILTER: DwfEventPageFilter = { params: [], sql: "" };

export function pageEventRows(
  db: DatabaseSync,
  runId: string,
  query: DwfEventPageQuery,
  filter: DwfEventPageFilter = NO_FILTER,
): { rows: DwfEventPageRow[]; hasMore: boolean } {
  // limit ≤ 0 是空页：翻页面永远有界，没有「-1 = 全量」这种写法。
  if (query.limit <= 0) return { rows: [], hasMore: false };
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and sequence > ?";
  const found = db
    .prepare(
      `
      with sized as (
        select sequence, octet_length(payload_json) as bytes
        from dwf_event
        where run_id = ?${filter.sql}${cursor}
        order by sequence
        limit ?
      ),
      ranked as (
        select sequence,
               row_number() over (order by sequence) as rn,
               sum(bytes) over (order by sequence rows unbounded preceding) as through
        from sized
      )
      select r.sequence, e.type, e.time_created,
             case when r.rn = 1 or (r.rn <= ? and r.through <= ?) then e.payload_json end
               as payload_json
      from ranked r
      join dwf_event e on e.run_id = ? and e.sequence = r.sequence
      order by r.sequence
      `,
    )
    .all(
      runId,
      ...filter.params,
      ...(after === undefined ? [] : [after]),
      // 多取一行：它不进页，它的存在就是 hasMore。
      query.limit + 1,
      query.limit,
      Math.max(0, query.maxBytes),
      runId,
    ) as unknown as Array<Omit<DwfEventPageRow, "payload_json"> & { payload_json: string | null }>;
  // `through` 单调不减，所以进页的行恰是一段前缀：第一行没有载荷之处就是页尾。
  const end = found.findIndex((row) => row.payload_json === null);
  const inPage = end === -1 ? found : found.slice(0, end);
  return { rows: inPage as DwfEventPageRow[], hasMore: end !== -1 };
}

/**
 * 事件日志的一页（详情页审计面，`workflowRunEvents`）：全部类型、item 原样，两道界由网关给定。
 * 住在引擎端口之外（宿主按能力探测），理由同 `listArtifactItems`：引擎从不翻自己的事件日志找
 * 一页给人看，内存 journal 没有理由为它陪跑。
 */
export function listEventPage(
  db: DatabaseSync,
  runId: string,
  query: DwfEventPageQuery,
): { events: StoredEvent[]; hasMore: boolean } {
  const { rows, hasMore } = pageEventRows(db, runId, query);
  return { events: rows.map(decodeEvent), hasMore };
}
