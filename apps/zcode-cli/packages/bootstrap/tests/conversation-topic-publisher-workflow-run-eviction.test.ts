// ConversationTopicPublisher × 淘汰（DESIGN-2 §2/§3）。
// 归约在表满时不再只是"拒新"，而是**摘掉**终态条目给活的新人腾位，于是键级增量第一次带上
// `removedActors` / `removedNodes`。这一套钉的是三件此前不可能发生、也因此从未被测过的事：
//   1. ingest 快路径的字节上界在「一条 op 既删又加、还第一次带上 unlistedByPhase / truncated」
//      之后仍然是上界——它算松了就等于把 16MiB 闸门算松了；
//   2. 旧消费者收的是整键 patch（它连 `workflowRun.*` 的判别式都不认），一批淘汰之后它必须仍与
//      权威态收敛到同一份旧界裁剪；
//   3. 溢出过的 run 重臂时**一条 op 清空两张表**（各 1024 条删除）——这是全协议最大的一条 op，
//      它撞破 wire schema 的 .max、订阅者 500 op / 1 MiB 任何一道，那条订阅就此静默。
// 界不从 CLI 这一侧注入（投影调归约时不传 limits），所以这里跑的是**真界 1024**。
import { describe, expect, it } from "vitest";
import type { EventId, SessionEvent, SessionId, TraceId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type {
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
  WorkflowRunUpdatedDelta,
  WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  WORKFLOW_RUNS_LEGACY_LIMITS,
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  clampWorkflowRunsForLegacy,
  conversationTopicFrameSchema,
  utf8JsonByteLength,
  workflowRunUpdateWithinWireBounds,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";
/** 填满之后再来这么多个活的新人：每一个都要归约摘掉一个已完成组才坐得下。 */
const EVICTION_ROUNDS = 16;
const MODERN = "sub-epoch-1-1";
const LEGACY = "sub-epoch-1-2";

/** 保守上界是私有字段；断言它的**方向**没有别的观察面（与既有那一组同一个口子）。 */
function upperBoundOf(publisher: ConversationTopicPublisher): number {
  return (publisher as unknown as { wireSnapshotBytesUpperBound: number })
    .wireSnapshotBytesUpperBound;
}

/**
 * 取样前把上界**按回真值**。不按回去这条测试就不咬人：快路径只加不减，跑到腾位窗口时上界已经
 * 漂到精确值的四倍上，那时候 `上界 ≥ 精确值` 连一个错得离谱的记账都拦不住。按回真值之后，
 * `上界 ≥ 精确值` 恰好就是这一步要证的那句话——这一条 op 报出来的增长盖得住快照真的长了多少。
 */
function pinUpperBoundToTruth(publisher: ConversationTopicPublisher): void {
  (publisher as unknown as { wireSnapshotBytesUpperBound: number }).wireSnapshotBytesUpperBound =
    publisher.getWireSnapshotLogicalBytes();
}

function snapshotOf(frame: ConversationTopicFrame | null): ConversationSnapshot {
  expect(frame?.payload.kind).toBe("snapshot");
  return (frame!.payload as { kind: "snapshot"; snapshot: ConversationSnapshot }).snapshot;
}

function deltasOf(frame: ConversationTopicFrame | null): ConversationDelta[] {
  // deltas 帧本身就是"没有 overflow"的可观察面：任一道兜底响了，这里来的会是 snapshot。
  expect(frame?.payload.kind).toBe("deltas");
  return (frame!.payload as { kind: "deltas"; deltas: ConversationDelta[] }).deltas;
}

function onlyUpdate(deltas: readonly ConversationDelta[]): WorkflowRunUpdatedDelta {
  expect(deltas.map((delta) => delta.op)).toEqual(["workflowRun.updated"]);
  return deltas[0] as WorkflowRunUpdatedDelta;
}

/**
 * 同一批 op，但两张删除表被抹掉——「删除是**承重**的」这句话的反证。
 *
 * 为什么每条收敛断言都配一条：一个把 op 拆开重装、却漏掉这两个新键的消费者（投影、旧消费者
 * 编码、hydration 记账，任何一处），产出的状态在别处一切正常，只是表上多出几条本该走掉的条目。
 * 不摆出这个反面，`施加后与权威态一致` 在删除被丢掉时照样能过——它证明不了自己在证明什么。
 */
function withoutRemovals(deltas: readonly ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (delta.op !== "workflowRun.updated") return delta;
    const { removedActors: _actors, removedNodes: _nodes, ...rest } = delta;
    return rest;
  });
}

interface EvictionScenario {
  events: readonly SessionEvent[];
  /** 腾位窗口里逐条事件取样的 (保守上界, 精确字节数)，取样前上界已按回真值。 */
  boundSamples: readonly { upper: number; exact: number }[];
  /** 重臂那一条事件的同一组读数，外加它之前的精确字节数（这一步快照是**变小**的）。 */
  resumeSample: { upper: number; exact: number; before: number };
  modernBase: ConversationSnapshot;
  legacyBase: ConversationSnapshot;
  evictionModern: ConversationDelta[];
  evictionLegacy: ConversationDelta[];
  evictedRuns: WorkflowRunsState;
  resumeModern: ConversationDelta[];
  resumeLegacy: ConversationDelta[];
  resumedRuns: WorkflowRunsState;
}

let cached: EvictionScenario | undefined;

/**
 * 填满 → 腾位 → 重臂的一整段。跑一遍三千多条事件要半秒，所以按模块记忆一次，三条测试各看
 * 自己那一面；它们读的都是这一次运行录下来的事实，没有一条会回头改它。
 */
function scenario(): EvictionScenario {
  if (cached) return cached;
  const events: SessionEvent[] = [];
  const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
  const ingest = (type: SessionEventType, payload: unknown): void => {
    const event: SessionEvent = {
      id: `event-${events.length + 1}` as EventId,
      sessionId: "session-1" as SessionId,
      type,
      timestamp: new Date(1_700_000_000_000 + events.length * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: events.length + 1,
      payload,
    };
    events.push(event);
    publisher.ingest(event);
  };
  const progress = (eventType: string, payload: Record<string, unknown>): void => {
    ingest(SessionEventType.DynamicWorkflowRunProgress, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: events.length,
      eventType,
      payload,
    });
  };
  /** 一个子代理干完一件活：这三条事件恰好造出一个**已完成组**（腾位的受害者）。 */
  const finishedGroup = (ordinal: number, phaseName: string): void => {
    const actor = { siteId: "agent#1", ordinal };
    const instance = { siteId: "ask#1", ordinal };
    progress("actor-created", { actor, name: `agent-${ordinal}`, phaseName });
    progress("node-queued", { instance, actor, kind: "ask", phaseName });
    progress("node-settled", { instance, outcome: "ok" });
  };

  ingest(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  progress("run-started", { runId: RUN_ID });
  for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxNodes; ordinal += 1) {
    finishedGroup(ordinal, `phase-${ordinal % 4}`);
  }

  // 订阅在填满之后、腾位之前：两个订阅者手上的基线是"一条都还没被摘掉"的那张表。
  const modernBase = snapshotOf(
    publisher.subscribe({ connectionId: "modern", workflowRunDeltas: true }).frame,
  );
  const legacyBase = snapshotOf(publisher.subscribe({ connectionId: "legacy" }).frame);

  const boundSamples: { upper: number; exact: number }[] = [];
  /** 一条事件一次取样，取样前把上界按回真值（见 {@link pinUpperBoundToTruth}）。 */
  const sampled = (eventType: string, payload: Record<string, unknown>): void => {
    pinUpperBoundToTruth(publisher);
    progress(eventType, payload);
    boundSamples.push({
      upper: upperBoundOf(publisher),
      exact: publisher.getWireSnapshotLogicalBytes(),
    });
  };
  for (let round = 1; round <= EVICTION_ROUNDS; round += 1) {
    const ordinal = WORKFLOW_RUNS_LIMITS.maxNodes + round;
    const actor = { siteId: "agent#1", ordinal };
    // actor 表满 → 摘掉一个已完成组（actor 与它那条节点同时离场），新人坐进来；
    // 随后这条 node-queued 落在刚空出来的节点位子上。
    sampled("actor-created", { actor, name: `agent-${ordinal}`, phaseName: "late" });
    sampled("node-queued", {
      instance: { siteId: "ask#1", ordinal },
      actor,
      kind: "ask",
      phaseName: "late",
    });
  }
  const evictionModern = deltasOf(publisher.flush(MODERN));
  const evictionLegacy = deltasOf(publisher.flush(LEGACY));
  const evictedRuns = publisher.getSnapshot().workflowRuns!;

  // 重臂：溢出过的 run 在新的一世里从空表重开（workflowRunTablesForNewLife）。
  pinUpperBoundToTruth(publisher);
  const resumeExactBefore = publisher.getWireSnapshotLogicalBytes();
  progress("run-started", { runId: RUN_ID });
  const resumeSample = {
    upper: upperBoundOf(publisher),
    exact: publisher.getWireSnapshotLogicalBytes(),
    before: resumeExactBefore,
  };
  const resumeModern = deltasOf(publisher.flush(MODERN));
  const resumeLegacy = deltasOf(publisher.flush(LEGACY));
  const resumedRuns = publisher.getSnapshot().workflowRuns!;

  cached = {
    events,
    boundSamples,
    resumeSample,
    modernBase,
    legacyBase,
    evictionModern,
    evictionLegacy,
    evictedRuns,
    resumeModern,
    resumeLegacy,
    resumedRuns,
  };
  return cached;
}

describe("ingest 快路径 × 腾位", () => {
  /**
   * 快路径把「这批 op 的字节数」当成快照增长的上界。腾位给这条论证添了两处新形状：一条 op 同时
   * 带删除与 upsert，以及 `unlistedByPhase` / `truncated` 两个 header 键在某一步**第一次**出现。
   * 这里在真界 1024 上逐步比对上界与精确值——上界一旦低于精确值，16MiB 闸门就被算松了，而那道闸
   * 关不住的后果是整帧发不出去。
   *
   * （同一条论证在小界上的逐字节形态见 conversation-workflow-run-deltas.test.ts 的 property 测试。）
   */
  it("真界 1024 上的每一次腾位：保守上界都不低于精确字节数", () => {
    const { boundSamples } = scenario();
    expect(boundSamples).toHaveLength(EVICTION_ROUNDS * 2);
    for (const sample of boundSamples) {
      expect(sample.upper).toBeGreaterThanOrEqual(sample.exact);
    }
    // 取样前上界按回了真值，所以富余就是「这条 op 报的增长」减去「快照真的长了多少」——一条腾位
    // op 只带一个 actor、一条节点和两条删除，富余是几百字节量级。把它钉住，这条测试才咬得住：
    // 记账要是把量级算错，上面那串断言立刻翻；要是有人把上界改宽成整份快照，这一条翻。
    const slack = boundSamples.map((sample) => sample.upper - sample.exact);
    expect(Math.max(...slack)).toBeLessThan(2048);
  });

  /**
   * 删除只会让快照变小，所以带 1024 + 1024 条删除的重臂 op 上界**极度**宽松（它把两千条删除的
   * 字节加进了一份刚缩掉二十多万字节的快照）。宽松的方向是安全的那一边——这一条钉的就是方向：
   * 它只多量一次，绝不会把一条其实很小的 run 判成超限（快路径失手时 ingest 落回精确测量）。
   */
  it("重臂那一条 op：快照缩了，上界只会偏保守", () => {
    const { resumeSample } = scenario();
    expect(resumeSample.exact).toBeLessThan(resumeSample.before);
    expect(resumeSample.upper).toBeGreaterThanOrEqual(resumeSample.exact);
  });

  it("腾位的可观察面：两张表停在界上，被摘掉的条目仍然可数", () => {
    const run = scenario().evictedRuns.runs[0]!;
    expect(run.actors).toHaveLength(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(run.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(run.truncated).toBe(true);
    // 每一轮摘掉一个已完成组 = 一个 actor + 它那一条已结算节点。
    expect(run.usage.nodesUnlisted).toBe(EVICTION_ROUNDS);
    expect(run.usage.nodesUnlistedSettled).toBe(EVICTION_ROUNDS);
    const byPhase = run.unlistedByPhase ?? [];
    expect(byPhase.reduce((sum, bucket) => sum + bucket.actors, 0)).toBe(EVICTION_ROUNDS);
    // 新人自己那一格不在里面：被摘掉的是已完成的旧组，不是刚坐下的这些。
    expect(byPhase.some((bucket) => bucket.phaseName === "late")).toBe(false);
  });
});

describe("旧消费者 × 腾位", () => {
  /**
   * 旧消费者连 `workflowRun.*` 的判别式都不认（discriminatedUnion 解析失败 → 整帧被丢），所以
   * 它收到的是整键 patch。删除因此对它是**免费**的——它拿的本来就是当前投影的整份裁剪。这一条
   * 钉的就是"免费"不是想当然：一批淘汰之后它的终态必须逐字节等于 clampWorkflowRunsForLegacy(权威态)。
   */
  it("一批淘汰之后，旧订阅者的终态 = clampWorkflowRunsForLegacy(权威态)", () => {
    const { legacyBase, evictionLegacy, evictedRuns } = scenario();
    expect(evictionLegacy.map((delta) => delta.op)).toEqual(["state.updated"]);
    const settled = applyConversationDeltas(legacyBase, evictionLegacy);
    expect(JSON.stringify(settled.workflowRuns)).toBe(
      JSON.stringify(clampWorkflowRunsForLegacy(evictedRuns)),
    );
    const run = settled.workflowRuns!.runs[0]!;
    expect(run.actors).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors);
    expect(run.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    // 裁剪先留还在动的：腾位腾出来的位子上坐的正是这些，它们不能被"前 256 条"挡在外面。
    expect(run.nodes.filter((node) => node.phase !== "settled").length).toBe(EVICTION_ROUNDS);
  });

  it("增量订阅者施加同一批 op 之后与权威态逐字节一致", () => {
    const { modernBase, evictionModern, evictedRuns } = scenario();
    const op = onlyUpdate(evictionModern);
    // 合并（规则 6）把这一窗口的 16 次腾位并成一条：删除取并集，upsert 后来者覆盖。
    expect(op.removedActors).toHaveLength(EVICTION_ROUNDS);
    expect(op.removedNodes).toHaveLength(EVICTION_ROUNDS);
    expect(workflowRunUpdateWithinWireBounds(op)).toBe(true);
    const settled = applyConversationDeltas(modernBase, evictionModern);
    expect(JSON.stringify(settled.workflowRuns)).toBe(JSON.stringify(evictedRuns));

    // 删除是承重的：丢掉这两个键，表上就多出 16 条本该走掉的条目（见 withoutRemovals）。
    const dropped = applyConversationDeltas(modernBase, withoutRemovals(evictionModern));
    expect(dropped.workflowRuns!.runs[0]!.actors).toHaveLength(
      WORKFLOW_RUNS_LIMITS.maxActors + EVICTION_ROUNDS,
    );
    expect(JSON.stringify(dropped.workflowRuns)).not.toBe(JSON.stringify(evictedRuns));
  });
});

describe("重臂：一条 op 清空两张表", () => {
  /**
   * 溢出过的 run 的 `run-started` 是全协议最大的一条 op：两张满表整个离场，1024 + 1024 条删除
   * 挤在一条 `workflowRun.updated` 里。它要过四道闸——wire schema 的 `.max(1024)`（已知键上的解析
   * 错误不会只剥掉一个键，它让整帧被丢）、订阅者的 500 op 与 1 MiB，以及快路径的字节上界。
   */
  it("1024 + 1024 条删除仍在 wire 与订阅者两道兜底之内", () => {
    const { resumeModern } = scenario();
    const op = onlyUpdate(resumeModern);
    expect(op.removedActors).toHaveLength(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(op.removedNodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    // `unlistedByPhase` 是上一世的"界花在哪里"，随两张表一起离场——增量得说得出它变成了缺席。
    expect(op.cleared).toContain("unlistedByPhase");
    expect(workflowRunUpdateWithinWireBounds(op)).toBe(true);
    expect(() =>
      conversationTopicFrameSchema.parse({
        topic: "conversation/session-1",
        subscriptionId: MODERN,
        fromSeq: 0,
        toSeq: 1,
        sentAt: 0,
        payload: { kind: "deltas", deltas: resumeModern },
      }),
    ).not.toThrow();
    expect(resumeModern.length).toBeLessThan(PROTOCOL_V4_LIMITS.subscriberBufferMaxOps);
    expect(utf8JsonByteLength({ kind: "deltas", deltas: resumeModern })).toBeLessThan(
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    );
  });

  it("两种订阅者各自施加之后都落在空表上", () => {
    const {
      modernBase,
      evictionModern,
      resumeModern,
      legacyBase,
      evictionLegacy,
      resumeLegacy,
      resumedRuns,
    } = scenario();
    const modern = applyConversationDeltas(
      applyConversationDeltas(modernBase, evictionModern),
      resumeModern,
    );
    expect(JSON.stringify(modern.workflowRuns)).toBe(JSON.stringify(resumedRuns));
    expect(modern.workflowRuns!.runs[0]!.actors).toHaveLength(0);
    expect(modern.workflowRuns!.runs[0]!.nodes).toHaveLength(0);
    // 丢掉删除表，新的一世就带着上一世的两张满表开跑——每条实例既被列又被计。
    const dropped = applyConversationDeltas(
      applyConversationDeltas(modernBase, evictionModern),
      withoutRemovals(resumeModern),
    );
    expect(dropped.workflowRuns!.runs[0]!.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);

    const legacy = applyConversationDeltas(
      applyConversationDeltas(legacyBase, evictionLegacy),
      resumeLegacy,
    );
    expect(JSON.stringify(legacy.workflowRuns)).toBe(
      JSON.stringify(clampWorkflowRunsForLegacy(resumedRuns)),
    );
  });

  /**
   * 冷重物化走的是另一条记账（tryBatchHydration 按 op 逐类累计 wire 字节，而不是每条事件量一次
   * 整份快照）。一条带两千条删除的 op 在那条路径上是**减小**快照却**增加**估值的唯一形状——
   * 估值只会偏保守（大不了多量一次），但终态必须一个字节都不差。
   */
  it("冷重物化同一段日志：终态与逐事件 live 逐字节一致", () => {
    const { events, resumedRuns } = scenario();
    const rehydrated = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    rehydrated.rehydrate(events);
    expect(JSON.stringify(rehydrated.getSnapshot().workflowRuns)).toBe(JSON.stringify(resumedRuns));
    expect(upperBoundOf(rehydrated)).toBeGreaterThanOrEqual(
      rehydrated.getWireSnapshotLogicalBytes(),
    );
  });
});
