/**
 * 看板只取字段的读（docs/execution-engine.md「Reading the journal」）：按 spec 点名的字段路径，
 * 由 SQLite 从每条标签 report 的 item 里把值取出来，渲染器只收到这几个值，而不是整条 item。
 *
 * 路径规则与 `readWorkflowArtifactField`（packages/shared，协议上的契约）逐字相同：按 `.` 切段；
 * 当前值是数组时段按 `Number(段)` 当下标，是对象时按键取，走不通得「没有」。SQLite 的 JSON 路径
 * 在每一步都得先说「这是下标还是键」（`[n]` 只命中数组，`."键"` 只命中对象），而 JS 规则要到
 * 运行时看到值才知道——所以一个像整数的段展开成两种写法，整条路径得到 2^k 个候选（k = 像整数的
 * 段数），用 `coalesce` 取第一个命中的。每一步的容器要么是数组要么是对象，所以至多一个候选命中，
 * `coalesce` 的次序无关紧要。`->` 回 JSON 文本：JSON 的 null 是文本 `null`（在），走不通是 SQL
 * NULL（不在），两者由此分开。
 *
 * 值的界：序列化超过 `maxValueBytes` 的值回成一段截短的字符串——字符串取正文前 1,000 个字符，
 * 对象 / 数组取 JSON 文本的前 1,000 个字符，都加「…」。截短在 SQLite 里做，一个 1 MiB 的值不会
 * 整段进 JavaScript。
 */

import type { DatabaseSync } from "node:sqlite";

/** 像整数的段超过这个数的路径不取（2^6 = 64 个候选已远超任何看板 spec 的需要）。 */
const MAX_INDEX_LIKE_SEGMENTS = 6;
/** 截短后保留的字符数：4 字节字符也放得进 4 KiB。 */
const CLIPPED_CHARS = 1000;
/** 每行除字段值之外的开销（sequence、站点坐标）的估算，计入页的字节。 */
const ROW_OVERHEAD_BYTES = 64;

/** 一个字段路径的全部 SQLite JSON 路径候选；超过展开上限时为空（该字段恒为「没有」）。 */
export function fieldPathCandidates(path: string): string[] {
  const segments = path.split(".");
  const indexLike = segments.filter((segment) => arrayIndexOf(segment) !== undefined).length;
  if (indexLike > MAX_INDEX_LIKE_SEGMENTS) return [];
  let candidates = ["$.item"];
  for (const segment of segments) {
    // JSON.stringify 给出带引号、已转义的键：SQLite 的路径标签认同一套转义。
    const asKey = `.${JSON.stringify(segment)}`;
    const index = arrayIndexOf(segment);
    candidates = candidates.flatMap((prefix) =>
      index === undefined ? [prefix + asKey] : [prefix + asKey, `${prefix}[${index}]`],
    );
  }
  return candidates;
}

/** `readWorkflowArtifactField` 在数组上的下标判据：`Number(段)` 是非负整数。 */
function arrayIndexOf(segment: string): number | undefined {
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * 一个字段的 SQL 表达式（取值 + 截短），以及它按出现顺序要绑定的参数。取值只算一次：放在一个
 * 关联子查询里，外层的 `case` 引用它的结果列。
 */
function fieldExpression(path: string, maxValueBytes: number): { sql: string; params: string[] } {
  const candidates = fieldPathCandidates(path);
  if (candidates.length === 0) return { sql: "null", params: [] };
  const value = `coalesce(${candidates.map(() => "e.payload_json -> ?").join(", ")}, null)`;
  const sql = `(select case
      when v is null then null
      when octet_length(v) <= ${maxValueBytes} then v
      when json_type(v) = 'text' then json_quote(substr(v ->> '$', 1, ${CLIPPED_CHARS}) || '…')
      else json_quote(substr(v, 1, ${CLIPPED_CHARS}) || '…')
    end from (select ${value} as v))`;
  return { sql, params: candidates };
}

/** 只取字段的一页（游标、两道界与 `hasMore` 的语义同 dwf-journal-pages.ts）。 */
export interface DwfArtifactFieldPageQuery {
  afterSequence?: number;
  fields: readonly string[];
  limit: number;
  maxBytes: number;
  maxValueBytes: number;
}

/** 一条只取字段的条目。 */
export interface DwfArtifactFieldItem {
  fields: Record<string, unknown>;
  ordinal: number;
  sequence: number;
  siteId: string;
}

/**
 * 一页只取字段的看板条目。与整条 item 的分页（dwf-journal-pages.ts）同一种窗口：先按条数取
 * `limit + 1` 行、在每行字段值的字节上开窗求前缀和，页就是 `rn = 1 or (rn <= limit and
 * through <= maxBytes)` 的那段前缀，后面还有行即 `hasMore`。这里的窗口作用在已截短的字段值上
 * （每个至多 `maxValueBytes`），所以临时表里没有整条 item。
 */
export function listArtifactFieldItems(
  db: DatabaseSync,
  runId: string,
  artifactId: string,
  query: DwfArtifactFieldPageQuery,
): { items: DwfArtifactFieldItem[]; hasMore: boolean } {
  if (query.limit <= 0) return { items: [], hasMore: false };
  const fields = query.fields.map((path) => fieldExpression(path, query.maxValueBytes));
  const columns = fields.map((field, index) => `${field.sql} as f${index}`).join(",\n");
  const bytes = fields.map((_field, index) => `coalesce(octet_length(f${index}), 0)`).join(" + ");
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and e.sequence > ?";
  const rows = db
    .prepare(
      `
      with page as (
        select e.sequence,
               json_extract(e.payload_json, '$.instance.siteId') as site_id,
               json_extract(e.payload_json, '$.instance.ordinal') as ordinal${columns ? `,\n${columns}` : ""}
        from dwf_event e
        where e.run_id = ?
          and e.type = 'report'
          and json_extract(e.payload_json, '$.artifactId') = ?${cursor}
        order by e.sequence
        limit ?
      ),
      ranked as (
        select *,
               row_number() over (order by sequence) as rn,
               sum(${ROW_OVERHEAD_BYTES}${bytes ? ` + ${bytes}` : ""})
                 over (order by sequence rows unbounded preceding) as through
        from page
      )
      select * from ranked order by sequence
      `,
    )
    .all(
      ...fields.flatMap((field) => field.params),
      runId,
      artifactId,
      ...(after === undefined ? [] : [after]),
      query.limit + 1,
    ) as unknown as Array<Record<string, string | number | null>>;
  const maxBytes = Math.max(0, query.maxBytes);
  const end = rows.findIndex(
    (row) =>
      row.rn !== 1 && ((row.rn as number) > query.limit || (row.through as number) > maxBytes),
  );
  const inPage = end === -1 ? rows : rows.slice(0, end);
  const items = inPage.map((row) => {
    const values: Record<string, unknown> = {};
    query.fields.forEach((path, index) => {
      const text = row[`f${index}`];
      if (typeof text === "string") values[path] = JSON.parse(text);
    });
    return {
      sequence: row.sequence as number,
      siteId: String(row.site_id),
      ordinal: Number(row.ordinal),
      fields: values,
    };
  });
  return { items, hasMore: end !== -1 };
}
