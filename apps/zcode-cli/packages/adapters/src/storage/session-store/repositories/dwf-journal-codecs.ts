/**
 * dwf_* journal 表的行 ↔ 记录映射。
 *
 * 记录类型只以 `import type` 从 @zcode/dynamic-workflow 引入：端口住在领域包里，
 * SQLite store 只是它的一个 adapter，运行时不得对领域包产生任何依赖。
 *
 * 解码规则：可空列为 NULL 时**不写出该键**（而不是写成 undefined 或 null）。
 * 契约测试对整条记录做 toEqual，输入里缺席的可选字段必须原样缺席地回来。
 */

import type {
  ActorRecord,
  AskStats,
  Caps,
  NodeKind,
  NodeRecord,
  NodeRecordStatus,
  PersonaSpec,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
  WorkflowErrorJson,
  WorldReadInput,
} from "@zcode/dynamic-workflow";
import { decodeJson, encodeJson } from "../json.js";

/**
 * `dwf_run.status` 的**物理**词汇（migration 0019 的 CHECK 集，不迁移）。逻辑词汇是引擎的
 * `RunStatus`（`errored` / `stopped`），两者之间的映射只活在本文件：
 *
 * | 逻辑                    | 物理 status | failure_json                                        |
 * | ----------------------- | ----------- | --------------------------------------------------- |
 * | stopped{reason, error?} | cancelled   | `{"stopReason": …, "error"?: WorkflowErrorJson}` 信封 |
 * | errored{error}          | failed      | WorkflowErrorJson 原样                              |
 * | completed/pending/running | 同名      | 不变                                                |
 *
 * 解码（历史行免回填）：`cancelled` → stopped，reason = 信封的 stopReason，缺席（老行）⇒ `user`；
 * `failed` + code `Interrupted` → stopped(interrupted)（老孤儿收敛行）；其余 `failed` → errored。
 * 接受的不精确：历史无 reason 的 cancelled 一律解成 user（含 TaskStop 停的）。
 */
export type DwfRunPhysicalStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type RunStopReason = NonNullable<RunRecord["stopReason"]>;

/**
 * stopped 行 failure_json 里的信封（与 WorkflowErrorJson 以 `stopReason` 键区分）。
 * `supersededBy` 与 `stopReason: "superseded"` 同一笔写入——信封整体重写，所以它零迁移地
 * 住在这里。
 */
interface DwfStoppedEnvelope {
  stopReason: RunStopReason;
  supersededBy?: string;
  error?: WorkflowErrorJson;
}

/** 逻辑终态的三元组：状态 + 停止原因（+ 后继）+ 结构化失败。 */
interface DwfRunSettlementFields {
  status: RunStatus;
  stopReason?: RunStopReason;
  supersededBy?: string;
  failure?: WorkflowErrorJson;
}

const INTERRUPTED_CODE = "Interrupted";
// 信封嗅探的白名单：少一个值，该原因的整封 envelope 解不出来、行退化成 stopped(user)。
const STOP_REASONS: ReadonlySet<string> = new Set([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);

/** 逻辑状态（+ 结算袋）→ 物理列值。写入侧唯一入口（createRun / updateRunStatus 共用）。 */
export function encodeRunSettlement(
  status: RunStatus,
  settlement?: Pick<RunSettlementRecord, "stopReason" | "supersededBy" | "failure">,
): { status: DwfRunPhysicalStatus; failureJson: string | null } {
  switch (status) {
    case "stopped": {
      const envelope: DwfStoppedEnvelope = { stopReason: settlement?.stopReason ?? "user" };
      if (settlement?.supersededBy !== undefined) envelope.supersededBy = settlement.supersededBy;
      if (settlement?.failure !== undefined) envelope.error = settlement.failure;
      return { status: "cancelled", failureJson: JSON.stringify(envelope) };
    }
    case "errored":
      return { status: "failed", failureJson: encodeJson(settlement?.failure) };
    case "completed":
      return { status: "completed", failureJson: encodeJson(settlement?.failure) };
    case "pending":
    case "running":
      return { status, failureJson: null };
  }
}

/** 物理列值 → 逻辑终态三元组。读取侧唯一入口（完整记录与枚举行共用）。 */
function decodeRunSettlement(
  status: DwfRunPhysicalStatus,
  failureJson: string | null,
): DwfRunSettlementFields {
  const raw = decodeJson<Record<string, unknown>>(failureJson);
  switch (status) {
    case "cancelled": {
      const fields: DwfRunSettlementFields = { status: "stopped", stopReason: "user" };
      if (raw !== undefined && isStoppedEnvelope(raw)) {
        fields.stopReason = raw.stopReason;
        if (typeof raw.supersededBy === "string" && raw.supersededBy.length > 0) {
          fields.supersededBy = raw.supersededBy;
        }
        if (raw.error !== undefined) fields.failure = raw.error;
      }
      return fields;
    }
    case "failed": {
      const failure = raw as WorkflowErrorJson | undefined;
      if (failure?.code === INTERRUPTED_CODE) {
        return { status: "stopped", stopReason: "interrupted", failure };
      }
      return failure === undefined ? { status: "errored" } : { status: "errored", failure };
    }
    case "completed": {
      const failure = raw as WorkflowErrorJson | undefined;
      return failure === undefined ? { status: "completed" } : { status: "completed", failure };
    }
    case "pending":
    case "running":
      return { status };
  }
}

function isStoppedEnvelope(
  value: Record<string, unknown>,
): value is DwfStoppedEnvelope & Record<string, unknown> {
  return typeof value.stopReason === "string" && STOP_REASONS.has(value.stopReason);
}

/**
 * 逻辑状态过滤 → SQL 谓词（`listRuns` 的 statuses 下推）。`stopped` / `errored` 在物理层共享
 * `failed` 列值，靠 `failure_json` 的 code 判别——用 SQLite 的 json_extract 在 SQL 里分清，
 * 而不是取一页再筛（后者会让 limit 与截断探测失真）。
 */
export function encodeRunStatusPredicate(statuses: readonly RunStatus[]): {
  sql: string;
  params: string[];
} {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const status of statuses) {
    switch (status) {
      case "stopped":
        clauses.push(
          "(status = 'cancelled' or (status = 'failed' and json_extract(failure_json, '$.code') = ?))",
        );
        params.push(INTERRUPTED_CODE);
        break;
      case "errored":
        clauses.push(
          "(status = 'failed' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)",
        );
        params.push(INTERRUPTED_CODE);
        break;
      default:
        clauses.push("status = ?");
        params.push(status);
    }
  }
  return { sql: clauses.length === 0 ? "0" : `(${clauses.join(" or ")})`, params };
}

export interface DwfRunRow {
  args_json: string | null;
  caps_max_concurrency: number;
  cwd: string | null;
  failure_json: string | null;
  id: string;
  name: string | null;
  parent_session_id: string | null;
  result_json: string | null;
  /** amend-resume 的 lineage 指针（较新迁移添加）。窄投影也 select 它：见 {@link DwfRunMetadataRow}。 */
  resumed_from: string | null;
  script_hash: string | null;
  script_text: string | null;
  /** run 级 token 用量（旧称 budget_spent；同一份数字，只是不再叫预算）。 */
  spent_tokens: number;
  /** 物理词汇（见文件头的映射表）；逻辑状态由 {@link decodeRunSettlement} 与 failure_json 一起解出。 */
  status: DwfRunPhysicalStatus;
  time_created: number;
  time_updated: number;
  tool_call_id: string | null;
}

/**
 * dwf_run 的**元数据列**（不含可能很大的 result_json）。枚举查询只 select 这些列：
 * 一页 50 行把 result_json 一起解出来，等于把整库的产物读进内存，而列表面根本不展示它。
 *
 * 物理 `failed` 既可能是 errored 也
 * 可能是 stopped(interrupted)，逻辑 status 只有连同 failure_json 才解得出来；它是结构化的小
 * 对象（code + message + 信封），逐行解出来没有内存风险。枚举行仍**不带** `failure` 字段。
 *
 * 实参是经声明校验过的
 * 小 JSON 袋，GUI 中枢的运行历史行要展示它——而 failure / result 才是无界的产物列。
 *
 * `resumed_from` 属于这一层（不是被省掉的大列）：它是一个短字符串，而「缺席 = 不是修订」
 * 的解码规则要求列真的被 select——漏掉它，窄查询里 `row.resumed_from` 会是 undefined，
 * 与 NULL 走不同分支，于是枚举行带上一个值为 undefined 的键。
 */
export type DwfRunMetadataRow = Omit<DwfRunRow, "result_json">;

/** journal 侧的行时间戳。`RunRecord` 刻意不带时间（引擎不关心），但读面要报 created/updated。 */
export interface DwfRunTimestamps {
  timeCreated: number;
  timeUpdated: number;
}

/**
 * 枚举查询的一行：run 元数据 + 时间戳，**不含** failure / result。
 * 详情行是它的超集，所以 list 与 get 两条读面可以共用同一套标签与归属推导。
 */
export type DwfRunListItem = Omit<RunRecord, "failure" | "result"> & DwfRunTimestamps;

/** 详情查询的一行：完整 `RunRecord`（含 failure / result）+ 时间戳。 */
export type DwfRunDetailRow = RunRecord & DwfRunTimestamps;

/**
 * 会话枚举查询的一行：{@link DwfRunListItem} + `failure`，**仍然不含 result**。
 *
 * 为什么不直接用 {@link DwfRunListItem}：会话枚举面（`listRunsForSession` → `/dwf list`）
 * 要报 failureCode/failureMessage，且 `resumable` 的谓词就是「failed 且 code 为
 * Interrupted」——省掉 failure_json 会让每个被打断的 run 都被算成不可恢复，
 * 那是一个静默的错误答案，而不是少一列展示。
 *
 * 为什么仍然不取 result_json：那一列是真正无界的（脚本的顶层返回值），而列表面从不展示
 * 产物。failure_json 是结构化的小对象（code + message），逐行解出来没有内存风险。
 */
export type DwfRunSessionRow = DwfRunMetadataRow;

/** {@link DwfRunSessionRow} 的记录形态。 */
export type DwfRunSessionListItem = DwfRunListItem & Pick<RunRecord, "failure">;

export interface DwfActorRow {
  id: number;
  name: string | null;
  ordinal: number;
  persona_json: string | null;
  resolved_model: string | null;
  run_id: string;
  session_id: string | null;
  site_id: string;
  time_created: number;
  time_updated: number;
}

export interface DwfNodeRow {
  actor_ordinal: number | null;
  actor_seq: number | null;
  actor_site_id: string | null;
  /**
   * 用户面产物的 id（较新迁移添加）。`kind = 'artifact'` 的行带它发布 / 声明的那个产物；
   * 带标签的 `kind = 'report'` 行带它喂养的那个预置产物。其余行为 NULL。
   * ⚠ 与 `RunSettlement.artifact`（脚本顶层返回值）无关。
   */
  artifact_id: string | null;
  error_json: string | null;
  id: number;
  input_hash: string;
  /** world-read / world-run 行的有界 `{op, args}`（较新迁移添加）；其余行与老行为 NULL。 */
  input_json: string | null;
  kind: NodeKind;
  /** ask 结算后 actor 会话消息 log 的长度（count offset，较新迁移添加）。 */
  message_boundary: number | null;
  ordinal: number;
  result_json: string | null;
  run_id: string;
  site_id: string;
  stats_json: string | null;
  status: NodeRecordStatus;
  time_created: number;
  time_updated: number;
}

/**
 * 工作区读面的一行：world-read / world-run 的
 * `NodeRecord`（**不含 `result`**——正文另有按 (siteId, ordinal) 的读面）+ journal 时间戳 +
 * `result_json` 的字节数（清单上的「多大」，不用把正文解出来就能报）。
 */
export interface DwfWorldNodeRow extends Omit<NodeRecord, "result">, DwfRunTimestamps {
  /** `result_json` 的 UTF-8 字节数；行还没结算或结算失败时缺席。 */
  resultBytes?: number;
  /**
   * 正文是 JSON 数组时的元素数（`glob` 的文件数、`grep` 的命中数、`git.changedFiles` 的路径数）。
   * 由 SQLite 的 JSON 函数在查询里算出，正文本身不出库。
   */
  resultCount?: number;
  /** `world.run` 结算后正文上的 `exitCode`；其它 op 与未结算行缺席。 */
  exitCode?: number;
  /** `world.run` 结算后 `stdout` / `stderr` 的 UTF-8 字节数。 */
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface DwfEventRow {
  id: number;
  payload_json: string;
  run_id: string;
  sequence: number;
  time_created: number;
  type: string;
}

/**
 * `result` 列专用编码。`null` 是合法的 ask 结果（`ask<T | null>` 会返回它），
 * 而共享的 encodeJson 把 undefined 和 null 一起压成 SQL NULL——那样 `result: null`
 * 落库再读出来会变成"没有 result"。这里只有 undefined 才映射为 SQL NULL。
 */
export function encodeResultJson(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

/**
 * run 元数据的公共解码。完整记录与枚举行都从这里出发，两条读面因此不可能在「哪些可选列
 * 算缺席」上分叉。
 */
function decodeRunMetadata(row: DwfRunMetadataRow): Omit<RunRecord, "failure" | "result"> {
  const caps: Caps = { maxConcurrency: row.caps_max_concurrency };

  const settlement = decodeRunSettlement(row.status, row.failure_json);
  const record: Omit<RunRecord, "failure" | "result"> = {
    runId: row.id,
    caps,
    spentTokens: row.spent_tokens,
    status: settlement.status,
  };
  if (settlement.stopReason !== undefined) record.stopReason = settlement.stopReason;
  if (settlement.supersededBy !== undefined) record.supersededBy = settlement.supersededBy;
  if (row.parent_session_id !== null) record.parentSessionId = row.parent_session_id;
  if (row.cwd !== null) record.cwd = row.cwd;
  // 列引入之前的行 name 为 NULL（新列、不回填）：解成**缺席的键**，读侧据此走脚本首行兜底。
  if (row.name !== null) record.name = row.name;
  // 早期落库的行没有这一列的值（NULL 即缺席），解成缺席的键，历史 run 照旧读回。
  if (row.tool_call_id !== null) record.toolCallId = row.tool_call_id;
  if (row.script_text !== null) record.scriptText = row.script_text;
  if (row.script_hash !== null) record.scriptHash = row.script_hash;
  // 早期落库的行、以及每一个不是修订的 run（绝大多数）该列为 NULL：解成**缺席的键**。
  // 读侧据此判定「本 run 是否需要重建导入缓存」。
  if (row.resumed_from !== null) record.resumedFrom = row.resumed_from;
  // 早期落库的行没有这一列的值（NULL 即缺席）：解成**缺席的键**而不是 `{}`，让「没有实参」
  // 与「实参是空袋」在记录层面保持可分辨；沙箱侧统一把缺席读作 `{}`（不变式 7）。
  if (row.args_json !== null) record.args = JSON.parse(row.args_json) as Record<string, unknown>;
  return record;
}

export function decodeRun(row: DwfRunRow): RunRecord {
  const record: RunRecord = decodeRunMetadata(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) record.failure = failure;
  // 早期落库的行没有值（列是新加的、值为 NULL）：必须解成**缺席的键**，而不是 undefined
  // 值或抛错，否则升级后所有历史 run 都读不回来。`result: null` 走的是同一条 JSON.parse
  // 路径，因此合法的 null 产物照旧出现在记录里（与 node 的 result_json 同一约定）。
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  return record;
}

/** 枚举行：元数据 + 时间戳。 */
export function decodeRunListItem(row: DwfRunMetadataRow): DwfRunListItem {
  return {
    ...decodeRunMetadata(row),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

/** 详情行：完整记录 + 时间戳。 */
export function decodeRunDetailRow(row: DwfRunRow): DwfRunDetailRow {
  return { ...decodeRun(row), timeCreated: row.time_created, timeUpdated: row.time_updated };
}

/** 会话枚举行：元数据 + 时间戳 + failure（不解 result_json——那一列没被 select）。 */
export function decodeRunSessionListItem(row: DwfRunSessionRow): DwfRunSessionListItem {
  const item: DwfRunSessionListItem = decodeRunListItem(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) item.failure = failure;
  return item;
}

export function decodeActor(row: DwfActorRow): ActorRecord {
  const record: ActorRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
  };
  if (row.name !== null) record.name = row.name;
  const persona = decodeJson<PersonaSpec>(row.persona_json);
  if (persona !== undefined) record.persona = persona;
  if (row.session_id !== null) record.sessionId = row.session_id;
  // 列引入之前的行该列为 NULL：解成**缺席的键**，历史 actor 记录照旧回得来。
  if (row.resolved_model !== null) record.resolvedModel = row.resolved_model;
  return record;
}

export function decodeNode(row: DwfNodeRow): NodeRecord {
  const record: NodeRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
    kind: row.kind,
    inputHash: row.input_hash,
    status: row.status,
  };
  if (row.actor_site_id !== null) record.actorSiteId = row.actor_site_id;
  if (row.actor_ordinal !== null) record.actorOrdinal = row.actor_ordinal;
  if (row.actor_seq !== null) record.actorSeq = row.actor_seq;
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  const error = decodeJson<WorkflowErrorJson>(row.error_json);
  if (error !== undefined) record.error = error;
  const stats = decodeJson<AskStats>(row.stats_json);
  if (stats !== undefined) record.stats = stats;
  // 早期落库的行、非 ask 节点、以及尚未被 driver 补写边界的 ask 都是 NULL → 缺席的键。
  // `0` 是**合法边界**（复制零条消息），所以判定必须是 `!== null` 而不是真值判断。
  if (row.message_boundary !== null) record.messageBoundary = row.message_boundary;
  // 早期落库的行、以及每一条既不是产物行也没打标签的 report / ask / world-* 行都是 NULL
  // → 解成**缺席的键**（不是 undefined 值）。看板取数按「artifact_id 相符」筛行，
  // 一个值为 undefined 的键会让契约测的整条 toEqual 失败。
  if (row.artifact_id !== null) record.artifactId = row.artifact_id;
  // 0030 之前的行、以及 ask / report / artifact 行都是 NULL → 缺席的键（读面据此退回静态标签）。
  const input = decodeJson<WorldReadInput>(row.input_json);
  if (input !== undefined) record.input = input;
  return record;
}

export function decodeEvent(
  row: Pick<DwfEventRow, "payload_json" | "sequence" | "time_created">,
): StoredEvent {
  return {
    sequence: row.sequence,
    event: JSON.parse(row.payload_json) as RunEvent,
    // 事件日志里唯一的时钟：日志行的年龄、子代理
    // 上一次动作的时刻都从它算。列自 0019 起就恒有值，所以这里无条件写出。
    timeCreated: row.time_created,
  };
}
