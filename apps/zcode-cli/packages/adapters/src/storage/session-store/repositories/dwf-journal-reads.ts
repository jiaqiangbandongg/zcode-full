/**
 * `JournalStorePort` 读面的 SQL（docs/execution-engine.md「Reading the journal」）：kinds / types
 * 过滤、`withResult` / `withPersona` 列裁剪、`countNodes`、`reportItems` 剥离，全部下推 SQLite。
 *
 * 拆出原因：dwf-journal.ts 顶到 oxlint max-lines 上限（400 行）；这几条读各自带着「为什么这样
 * 取数」的论证，与写入路径没有共享状态，只要一个 db 句柄。
 *
 * 列裁剪用 `null as <列>` 而不是省掉列：解码器（dwf-journal-codecs.ts）对 NULL 一律解成缺席的
 * 键，所以「没读」与「读到 NULL」在行上同形，解码器不必知道这次读选了哪些列。
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord,
  GetNodeOptions,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import {
  decodeActor,
  decodeEvent,
  decodeNode,
  type DwfActorRow,
  type DwfEventRow,
  type DwfNodeRow,
} from "./dwf-journal-codecs.js";

/** SQLite 的「不限」写法：缺省与显式 limit 共用同一条语句形状。 */
const UNBOUNDED = -1;

const NODE_COLUMNS_BEFORE_RESULT =
  "id, run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash, " +
  "input_json, status";
const NODE_COLUMNS_AFTER_RESULT =
  "error_json, stats_json, message_boundary, artifact_id, time_created, time_updated";

function nodeColumns(withResult: boolean): string {
  const result = withResult ? "result_json" : "null as result_json";
  return `${NODE_COLUMNS_BEFORE_RESULT}, ${result}, ${NODE_COLUMNS_AFTER_RESULT}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function limitParam(limit: number | undefined): number {
  return limit === undefined ? UNBOUNDED : Math.max(0, limit);
}

export function getNodeRow(
  db: DatabaseSync,
  runId: string,
  siteId: string,
  ordinal: number,
  opts: GetNodeOptions | undefined,
): NodeRecord | undefined {
  const row = db
    .prepare(
      `select ${nodeColumns(opts?.withResult ?? true)} from dwf_node
       where run_id = ? and site_id = ? and ordinal = ?`,
    )
    .get(runId, siteId, ordinal) as DwfNodeRow | undefined;
  return row ? decodeNode(row) : undefined;
}

export function listNodeRows(
  db: DatabaseSync,
  runId: string,
  opts: ListNodesOptions,
): NodeRecord[] {
  const kinds = opts.kinds;
  if (kinds !== "all" && kinds.length === 0) return [];
  const kindFilter = kinds === "all" ? "" : ` and kind in (${placeholders(kinds.length)})`;
  const kindParams = kinds === "all" ? [] : kinds;
  if (opts.maxResultBytes !== undefined) {
    return listNodeRowsWithinBytes(db, runId, opts, kindFilter, kindParams, opts.maxResultBytes);
  }
  const rows = db
    .prepare(
      `select ${nodeColumns(opts.withResult)} from dwf_node
       where run_id = ?${kindFilter}
       order by id limit ?`,
    )
    .all(runId, ...kindParams, limitParam(opts.limit)) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

/**
 * `maxResultBytes` 的读法：先在 `octet_length(result_json)` 上开窗算出前缀和，定下哪几行进页，
 * 再只为这几行取整行。`octet_length` 从行头读长度、不碰结果本身，所以没进页的行（包括一条
 * 1 MiB 的报告）一个字节都不读——与事件分页（dwf-journal-pages.ts）同一种查询。
 */
function listNodeRowsWithinBytes(
  db: DatabaseSync,
  runId: string,
  opts: ListNodesOptions,
  kindFilter: string,
  kindParams: readonly string[],
  maxResultBytes: number,
): NodeRecord[] {
  const columns = nodeColumns(opts.withResult)
    .split(", ")
    .map((column) => (column.startsWith("null as ") ? column : `n.${column}`))
    .join(", ");
  const rows = db
    .prepare(
      `with sized as (
         select id, coalesce(octet_length(result_json), 0) as bytes from dwf_node
         where run_id = ?${kindFilter}
         order by id limit ?
       ),
       ranked as (
         select id,
                row_number() over (order by id) as rn,
                sum(bytes) over (order by id rows unbounded preceding) as through
         from sized
       )
       select ${columns} from ranked r join dwf_node n on n.id = r.id
       where r.rn = 1 or r.through <= ?
       order by r.id`,
    )
    .all(
      runId,
      ...kindParams,
      limitParam(opts.limit),
      Math.max(0, maxResultBytes),
    ) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

export function countNodeRows(db: DatabaseSync, runId: string, kind: NodeKind): number {
  const row = db
    .prepare("select count(*) as total from dwf_node where run_id = ? and kind = ?")
    .get(runId, kind) as { total: number | bigint } | undefined;
  return Number(row?.total ?? 0);
}

/**
 * 该 kind 各行 `result_json` 的字节数之和。`octet_length` 让 SQLite 只读行头里记的长度：实测
 * 1.5 GB 的结果求和 0.7 ms，而 `length()` 要逐字符数、541 ms。resume 恢复报告的 run 级字节
 * 计数靠它，一条 item 都不读出来。
 */
export function sumResultBytes(db: DatabaseSync, runId: string, kind: NodeKind): number {
  const row = db
    .prepare(
      "select coalesce(sum(octet_length(result_json)), 0) as total from dwf_node where run_id = ? and kind = ?",
    )
    .get(runId, kind) as { total: number | bigint } | undefined;
  return Number(row?.total ?? 0);
}

export function listActorRows(
  db: DatabaseSync,
  runId: string,
  opts: ListActorsOptions,
): ActorRecord[] {
  const persona = opts.withPersona ? "persona_json" : "null as persona_json";
  const nameFilter = opts.name === undefined ? "" : " and name = ?";
  const rows = db
    .prepare(
      `select id, run_id, site_id, ordinal, name, ${persona}, resolved_model, session_id,
              time_created, time_updated
       from dwf_actor where run_id = ?${nameFilter} order by id`,
    )
    .all(runId, ...(opts.name === undefined ? [] : [opts.name])) as unknown as DwfActorRow[];
  return rows.map(decodeActor);
}

/**
 * 事件读。`types` / cursor / `limit` 下推成 WHERE 与 LIMIT；`reportItems: {limit: N}` 先取本 run
 * 第 N 条 report 事件的 sequence 作为分界（一条走 `(run_id, sequence)` 唯一索引、最多读 N 行的
 * 查询），主查询再把分界之后的 report 载荷交给 `json_remove(payload_json, '$.item')`。
 *
 * 为什么是两条查询而不是一条 `row_number()` 窗口：窗口函数要先把子查询的行（连同 payload）物化
 * 进临时表再编号，一个报了 65,536 条的 run 会把约 2 GiB 的载荷抄一遍进 temp store——正是本读面要
 * 避免的那种按总字节付费。分界 sequence 让主查询保持流式，`CASE` 又是惰性的，未剥离的行不会被
 * 解析。
 */
export function listEventRows(
  db: DatabaseSync,
  runId: string,
  opts: ListEventsOptions,
): StoredEvent[] {
  const types = opts.types;
  if (types !== "all" && types.length === 0) return [];
  const cutoff = reportCutoff(db, runId, opts);
  const payload =
    cutoff === undefined
      ? "payload_json"
      : "case when type = 'report' and sequence > ? then json_remove(payload_json, '$.item') " +
        "else payload_json end as payload_json";
  const typeFilter = types === "all" ? "" : ` and type in (${placeholders(types.length)})`;
  const after = opts.afterSequence;
  const cursorFilter = after === undefined ? "" : " and sequence > ?";
  const rows = db
    .prepare(
      `select sequence, type, time_created, ${payload} from dwf_event
       where run_id = ?${typeFilter}${cursorFilter}
       order by sequence limit ?`,
    )
    .all(
      ...(cutoff === undefined ? [] : [cutoff]),
      runId,
      ...(types === "all" ? [] : types),
      ...(after === undefined ? [] : [after]),
      limitParam(opts.limit),
    ) as unknown as DwfEventRow[];
  return rows.map(decodeEvent);
}

/**
 * report item 的分界 sequence：sequence 大于它的 report 事件剥掉 item。`undefined` = 不剥
 * （`reportItems: "all"`，或本 run 的 report 事件不足 N 条）。N = 0 时分界是 -1：一条不留。
 *
 * 排名按**全 run** 计，与 types / cursor / limit 无关（端口契约）。
 */
function reportCutoff(
  db: DatabaseSync,
  runId: string,
  opts: ListEventsOptions,
): number | undefined {
  if (opts.reportItems === "all") return undefined;
  // 本次读根本不含 report 事件时，分界无从生效，省掉那条查询。
  if (opts.types !== "all" && !opts.types.includes("report")) return undefined;
  const keep = Math.max(0, opts.reportItems.limit);
  if (keep === 0) return -1;
  const row = db
    .prepare(
      `select sequence from dwf_event where run_id = ? and type = 'report'
       order by sequence limit 1 offset ?`,
    )
    .get(runId, keep - 1) as { sequence: number } | undefined;
  return row?.sequence;
}
