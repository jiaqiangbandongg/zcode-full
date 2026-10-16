/**
 * 内存版 {@link JournalStorePort}：阶段一用于 fake-driver 测试与 replay/resume。
 * 纯内存、同步；深拷贝进出以杜绝调用方持有的引用被后续写入意外改动（模拟存储边界）。
 * 生产实现落在 zcode session store 的 node:sqlite（DatabaseSync，同步）之上，共用 JournalStorePort；
 * 事务性不在端口面上，由 driver 组合 journal+session 写入。
 */

import type {
  ActorRecord,
  Caps,
  GetNodeOptions,
  JournalStorePort,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "./types.js";

/** 结构化深拷贝：隔离存储边界两侧的引用。值均为 JSON 兼容或 PersonaSpec 等纯数据。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 节点行的出库副本；`withResult: false` 与 SQLite 侧不 select `result_json` 同语义（键缺席）。 */
function nodeCopy(node: NodeRecord, withResult: boolean): NodeRecord {
  const copy = clone(node);
  if (!withResult) delete copy.result;
  return copy;
}

/** actor / node 的复合键。 */
function key(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

export class InMemoryJournalStore implements JournalStorePort {
  // 以 runId 分桶，贴合"一个 store 可承载多个 run"的存储语义。
  private readonly runs = new Map<string, RunRecord>();
  private readonly actors = new Map<string, Map<string, ActorRecord>>();
  private readonly nodes = new Map<string, Map<string, NodeRecord>>();
  private readonly events = new Map<string, StoredEvent[]>();

  createRun(record: RunRecord): void {
    if (this.runs.has(record.runId)) {
      throw new Error(`journal: run ${record.runId} already exists`);
    }
    this.runs.set(record.runId, clone(record));
    this.actors.set(record.runId, new Map());
    this.nodes.set(record.runId, new Map());
    this.events.set(record.runId, []);
  }

  getRun(runId: string): RunRecord | undefined {
    const r = this.runs.get(runId);
    return r === undefined ? undefined : clone(r);
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.status = status;
    if (status === "pending" || status === "running") {
      // 非终态 = 无 settlement：resume 把 run 翻回 running 时必须清掉上一世的残留，否则
      // 孤儿收敛写下的 failure_json 会与 running 并存（journal 快照读面同时报「在跑」与
      // 「已失败」）。矛盾的结算袋（非终态却携带 failure/result）同样按清空处理。
      delete r.failure;
      delete r.result;
      delete r.stopReason;
      delete r.supersededBy;
      return;
    }
    // 失败三件套（failure / stopReason / supersededBy）**整体改写**：结算袋是这一刻失败的
    // 全部真相，缺席即没有失败。旧的「缺席 = 不触碰」语义下，外部写入的 failed + Interrupted
    // 会在随后的 completed 结算里幸存，行同时说「完成了」和「被打断了」
    // （SQLite 侧是同一条 coalesce，两实现同语义）。
    if (settlement?.stopReason === undefined) delete r.stopReason;
    else r.stopReason = settlement.stopReason;
    if (settlement?.supersededBy === undefined) delete r.supersededBy;
    else r.supersededBy = settlement.supersededBy;
    if (settlement?.failure === undefined) delete r.failure;
    else r.failure = clone(settlement.failure);
    // 产物相反：缺席的键表示「不触碰」，一次不带产物的重复结算不会抹掉已结算的产物。
    // `result: null` 是合法产物，只有 undefined 才算缺席。
    if (settlement?.result !== undefined) r.result = clone(settlement.result);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.spentTokens = spentTokens;
  }

  updateRunCaps(runId: string, caps: Caps): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    // 深拷贝与其余写入同规（存储边界两侧不共享引用）：调用方手里的那份 caps 随后被换掉，
    // 不该顺手改动已落库的行。
    r.caps = clone(caps);
  }

  updateRunScript(runId: string, scriptText: string, scriptHash: string): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    // 两列同一笔写（resume 拿哈希对文本），行上其余一切不碰（与 updateRunUsage 同族）。
    r.scriptText = scriptText;
    r.scriptHash = scriptHash;
  }

  putActor(record: ActorRecord): void {
    const bucket = this.requireActorBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const a = this.actors.get(runId)?.get(key(siteId, ordinal));
    return a === undefined ? undefined : clone(a);
  }

  listActors(runId: string, opts: ListActorsOptions): ActorRecord[] {
    const bucket = this.actors.get(runId);
    if (bucket === undefined) return [];
    const matched = [...bucket.values()].filter(
      (actor) => opts.name === undefined || actor.name === opts.name,
    );
    return matched.map((actor) => {
      const copy = clone(actor);
      if (!opts.withPersona) delete copy.persona;
      return copy;
    });
  }

  putNode(record: NodeRecord): void {
    const bucket = this.requireNodeBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getNode(
    runId: string,
    siteId: string,
    ordinal: number,
    opts?: GetNodeOptions,
  ): NodeRecord | undefined {
    const n = this.nodes.get(runId)?.get(key(siteId, ordinal));
    return n === undefined ? undefined : nodeCopy(n, opts?.withResult ?? true);
  }

  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[] {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) return [];
    // Map 的迭代序 = 首次插入序，与 SQLite 侧的 `order by id` 同语义（upsert 不改 id，也不改
    // Map 里的位置）。
    const kinds = opts.kinds;
    const matched = [...bucket.values()].filter(
      (node) => kinds === "all" || kinds.includes(node.kind),
    );
    const limited = opts.limit === undefined ? matched : matched.slice(0, Math.max(0, opts.limit));
    const budgeted =
      opts.maxResultBytes === undefined ? limited : withinBytes(limited, opts.maxResultBytes);
    return budgeted.map((node) => nodeCopy(node, opts.withResult));
  }

  countNodes(runId: string, kind: NodeKind): number {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) return 0;
    let count = 0;
    for (const node of bucket.values()) if (node.kind === kind) count += 1;
    return count;
  }

  sumResultBytes(runId: string, kind: NodeKind): number {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) return 0;
    let bytes = 0;
    for (const node of bucket.values()) if (node.kind === kind) bytes += resultBytes(node);
    return bytes;
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // 孤儿事件（run 尚未 createRun）与 putActor/putNode 一样是契约破坏：静默建桶
    // 会写出一批永远归属不到任何 run 的事件；SQLite 侧有 FK 兜底，内存侧靠这句。
    const list = this.events.get(runId);
    if (list === undefined) throw new Error(`journal: unknown run ${runId}`);
    // 追加时刻与 SQLite 侧的 `dwf_event.time_created` 同语义（两实现共用一份契约测）：事件日志里
    // 一切「多久以前」只能从它算，让读者现取 Date.now() 会把冷重放的整段历史全标成「刚刚」。
    const stored: StoredEvent = {
      sequence: list.length,
      event: clone(event),
      timeCreated: Date.now(),
    };
    list.push(stored);
    return clone(stored);
  }

  listEvents(runId: string, opts: ListEventsOptions): StoredEvent[] {
    const list = this.events.get(runId);
    if (list === undefined) return [];
    // report 的排名按**全 run** 计（与 types / cursor / limit 无关），所以先在未过滤的序列上
    // 给每条 report 事件定名次，再过滤——SQLite 侧的 row_number() 也开在过滤之前。
    const reportLimit = opts.reportItems === "all" ? undefined : opts.reportItems.limit;
    const stripped = new Set<number>();
    if (reportLimit !== undefined) {
      let rank = 0;
      for (const stored of list) {
        if (stored.event.type !== "report") continue;
        rank += 1;
        if (rank > reportLimit) stripped.add(stored.sequence);
      }
    }
    // sequence 与数组下标在内存实现里恒等（appendEvent 用 list.length 分配），但这里仍按
    // sequence 比较而不是按下标偏移：cursor 的语义是"严格大于该 sequence"，SQLite 侧也是
    // `where sequence > ?`。两侧共用同一份契约测，语义必须逐字相同。
    const types = opts.types;
    const after = opts.afterSequence;
    const filtered = list.filter(
      (e) =>
        (types === "all" || types.includes(e.event.type)) &&
        (after === undefined || e.sequence > after),
    );
    const limited =
      opts.limit === undefined ? filtered : filtered.slice(0, Math.max(0, opts.limit));
    return limited.map((stored) => {
      const copy = clone(stored);
      if (stripped.has(stored.sequence)) delete (copy.event as { item?: unknown }).item;
      return copy;
    });
  }

  private requireActorBucket(runId: string): Map<string, ActorRecord> {
    const bucket = this.actors.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }

  private requireNodeBucket(runId: string): Map<string, NodeRecord> {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }
}

/**
 * 一行 `result` 的 UTF-8 序列化字节数，与 SQLite 侧 `octet_length(result_json)` 同一把尺
 * （`result_json` 就是 `JSON.stringify(result)`）。无结果的行计 0。
 */
function resultBytes(node: NodeRecord): number {
  if (node.result === undefined) return 0;
  const text = JSON.stringify(node.result);
  return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

/** `maxResultBytes` 的前缀规则：再加一行就超界时收尾，第一行总是带上（同 SQLite 侧）。 */
function withinBytes(nodes: readonly NodeRecord[], maxResultBytes: number): NodeRecord[] {
  const kept: NodeRecord[] = [];
  let total = 0;
  for (const node of nodes) {
    const bytes = resultBytes(node);
    if (kept.length > 0 && total + bytes > maxResultBytes) break;
    kept.push(node);
    total += bytes;
  }
  return kept;
}
