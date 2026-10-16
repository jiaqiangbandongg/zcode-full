// workflowRuns 的键级增量（workflow-runs-delta.ts + delta.ts 的两条 op + apply 的两个 twin）。
//
// 本文件钉的是**一条**契约，其余断言都为它服务：对任意一对 reducer 产出的 (prior, next)，
//   JSON.stringify(apply(带 prior 的快照, diff(prior, next)).workflowRuns) === JSON.stringify(next)
// 逐字节，不是深相等——键序若不一致，桌面与 CLI 的两份状态就会在别处（比如快照哈希、
// 回放比对）悄悄分叉，而这类分叉从现象上看只是"偶尔刷新一下"。
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  WORKFLOW_RUN_HEADER_KEYS,
  applyConversationDeltas,
  applyConversationDeltasMutable,
  canonicalWorkflowRun,
  coalesceConversationDeltas,
  conversationDeltaSchema,
  createMutableConversationSnapshotAccumulator,
  diffWorkflowRunsState,
  isCompleteWorkflowRunHeader,
  reduceWorkflowRunsState,
  workflowRunSchema,
  workflowRunsStateSchema,
  type ConversationDelta,
  type ConversationSnapshot,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/**
 * 只装 apply 会碰到的两处：rows 窗口（mutable accumulator 建索引要读它）与状态键。
 * 其余字段与本文件的契约无关，写全一份只会让真正的断言淹没在夹具里。
 */
function snapshotWith(workflowRuns: WorkflowRunsState | undefined): ConversationSnapshot {
  const base = {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
  return (workflowRuns === undefined
    ? base
    : { ...base, workflowRuns }) as unknown as ConversationSnapshot;
}

/** 事件信封工厂：sequence 按调用序自增，模拟 journal 的单调分配（与 reducer 测试同一习语）。 */
function progressLog(runId = RUN_ID) {
  let sequence = -1;
  return function progress(
    eventType: string,
    payload: Record<string, unknown> = {},
    extra: Partial<WorkflowRunProgressEnvelope> = {},
  ): WorkflowRunProgressEnvelope {
    sequence += 1;
    return { runId, toolCallId: "tc-1", sequence, eventType, payload, ...extra };
  };
}

const ASK = { siteId: "ask#1", ordinal: 1 };
const ACTOR = { siteId: "actor#1", ordinal: 1 };

/**
 * 一条走完全程的 run：出生、阶段、子代理、节点全相位、进度读数、用量、report、产物、
 * 升级问答（`cleared` 路径的唯一来源：pendingQuestions 归零后整个键缺席）、缓存命中的结算、
 * 第二个子代理、终态。
 */
function fullRunEvents(): WorkflowRunProgressEnvelope[] {
  const progress = progressLog();
  return [
    progress("run-started", {
      caps: { maxConcurrency: 2 },
      concurrencyCeiling: 8,
      subagentModel: "glm/glm-5",
      resumedFrom: "dwfrun-0",
    }),
    progress("run-launched", { phaseNames: ["调研", "实现"], phaseAlongside: [[1], [0]] }),
    progress("phase-entered", { name: "调研", ordinal: 1 }),
    progress(
      "actor-created",
      { actor: ACTOR, name: "reader", phaseName: "调研" },
      { actorSessionId: "sess_dwf-1-actor.1" },
    ),
    progress("node-queued", {
      instance: ASK,
      kind: "ask",
      actor: ACTOR,
      instructionsHead: "读一遍 a.ts",
      phaseName: "调研",
    }),
    progress("node-dispatched", { instance: ASK }),
    progress("node-executing", { instance: ASK }),
    progress("node-progress", {
      instance: ASK,
      turn: 2,
      toolCalls: 3,
      lastTool: { name: "Read", target: "a.ts" },
    }),
    progress("node-waiting", { instance: ASK }),
    progress("usage-updated", { spentTokens: 1_200 }),
    progress("report", { instance: { siteId: "report#1", ordinal: 1 }, item: "第一条发现" }),
    progress("artifact-published", {
      artifact: { id: "art-1", kind: "markdown", version: 1, title: "报告" },
    }),
    progress("escalation-raised", {
      qid: "dwfq-1",
      actor: ACTOR,
      actorName: "reader",
      question: "门是不是坏了？",
      askedAt: 1_756_000_000_000,
    }),
    // 划掉最后一条停驻问题 → 整个键缺席，这是 diff 的 `cleared` 路径。
    progress("escalation-resolved", { qid: "dwfq-1", answer: "坏了，跳过。" }),
    progress("node-settled", { instance: ASK, outcome: "ok" }),
    // resume 的完结命中短路：直接 settled、不经 queued，且它就是这条节点的出生事件。
    progress("node-settled", {
      instance: { siteId: "world-read#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
    }),
    progress("phase-entered", { name: "实现", ordinal: 1 }),
    progress(
      "actor-created",
      { actor: { siteId: "actor#2", ordinal: 1 }, name: "writer", phaseName: "实现" },
      { actorSessionId: "sess_dwf-1-actor.2" },
    ),
    progress("node-queued", {
      instance: { siteId: "ask#2", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#2", ordinal: 1 },
    }),
    progress("node-dispatched", { instance: { siteId: "ask#2", ordinal: 1 } }),
    progress("concurrency-changed", { key: "glm/glm-5", previous: 8, next: 3, reason: "backoff" }),
    progress("usage-updated", { spentTokens: 4_800 }),
    progress("node-settled", { instance: { siteId: "ask#2", ordinal: 1 }, outcome: "failed" }),
    progress("run-settled", { status: "completed" }),
  ];
}

/** 第二条 run 的最小生命周期：同一份状态里两条 run 并存，diff 只能动被改的那条。 */
function secondRunEvents(): WorkflowRunProgressEnvelope[] {
  const progress = progressLog("dwfrun-2");
  return [
    progress("run-started", { caps: { maxConcurrency: 1 } }),
    progress("actor-created", { actor: ACTOR, name: "planner" }),
    progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR }),
    progress("node-dispatched", { instance: ASK }),
    progress("run-settled", { status: "stopped", stopReason: "user", resumable: true }),
  ];
}

/** 把最旧的 run 挤出去：maxRuns + 2 条新 run，每条一个 run-started。 */
function evictionEvents(): WorkflowRunProgressEnvelope[] {
  return Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns + 2 }, (_, index) => ({
    runId: `dwfrun-evict-${index}`,
    sequence: 0,
    eventType: "run-started",
    payload: { caps: { maxConcurrency: 1 } },
  }));
}

/**
 * 契约裁判：逐条归约，每一步都用 diff 产出的增量把 prior 推到 next，两个 apply twin 都要
 * 得到与 next **逐字节**一致的 workflowRuns。返回走过的全部增量，供调用方再做别的断言。
 */
function expectRoundTrip(envelopes: readonly WorkflowRunProgressEnvelope[]): ConversationDelta[] {
  let state: WorkflowRunsState | undefined;
  const all: ConversationDelta[] = [];
  for (const envelope of envelopes) {
    const next = reduceWorkflowRunsState(state, envelope);
    if (next === null) continue;
    const deltas = diffWorkflowRunsState(state, next);
    all.push(...deltas);
    const prior = snapshotWith(state);

    const immutable = applyConversationDeltas(prior, deltas);
    expect(JSON.stringify(immutable.workflowRuns)).toBe(JSON.stringify(next));

    const accumulator = createMutableConversationSnapshotAccumulator(prior);
    applyConversationDeltasMutable(accumulator, deltas);
    expect(JSON.stringify(accumulator.snapshot.workflowRuns)).toBe(JSON.stringify(next));

    // 增量不该能拼出一个非法状态：客户端侧的产物同样过 strict schema。
    expect(workflowRunsStateSchema.safeParse(immutable.workflowRuns).success).toBe(true);
    state = next;
  }
  return all;
}

describe("diffWorkflowRunsState × apply：逐事件往返", () => {
  it("一条走完全程的 run：每一步的终态逐字节一致", () => {
    const deltas = expectRoundTrip(fullRunEvents());
    // 全程没有一条整键重发——有一条就说明 diff 认不出某种结构变化，字节数退回改造前。
    expect(deltas.some((delta) => delta.op === "state.updated")).toBe(false);
  });

  it("两条 run 并存 + 最旧淘汰：淘汰说得出口（workflowRun.removed）", () => {
    const deltas = expectRoundTrip([...fullRunEvents(), ...secondRunEvents(), ...evictionEvents()]);
    expect(deltas.some((delta) => delta.op === "state.updated")).toBe(false);
    const removed = deltas.filter((delta) => delta.op === "workflowRun.removed");
    // 两条旧 run + maxRuns + 2 条新 run 进场，最旧的四条按进场序被挤出去。
    expect(removed.map((delta) => (delta.op === "workflowRun.removed" ? delta.runId : ""))).toEqual(
      [RUN_ID, "dwfrun-2", "dwfrun-evict-0", "dwfrun-evict-1"],
    );
  });

  it("停驻问题清零走 cleared（「零条 ⇒ 键缺席」的键必须说得出它没了）", () => {
    const progress = progressLog();
    const raised = reduceWorkflowRunsState(
      reduceWorkflowRunsState(undefined, progress("run-started", { caps: { maxConcurrency: 1 } })),
      progress("escalation-raised", { qid: "dwfq-1", question: "门坏了吗？" }),
    )!;
    const resolved = reduceWorkflowRunsState(
      raised,
      progress("escalation-resolved", { qid: "dwfq-1", answer: "坏了" }),
    )!;
    const deltas = diffWorkflowRunsState(raised, resolved);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ op: "workflowRun.updated", cleared: ["pendingQuestions"] });
    const applied = applyConversationDeltas(snapshotWith(raised), deltas);
    expect(applied.workflowRuns?.runs[0]).not.toHaveProperty("pendingQuestions");
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(resolved));
  });

  it("一条节点事件只搬这条节点：增量里不出现没动过的条目", () => {
    const progress = progressLog();
    let state = reduceWorkflowRunsState(undefined, progress("run-started", {}))!;
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      state = reduceWorkflowRunsState(
        state,
        progress("node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" }),
      )!;
    }
    const next = reduceWorkflowRunsState(
      state,
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 7 } }),
    )!;
    const deltas = diffWorkflowRunsState(state, next);
    expect(deltas).toHaveLength(1);
    const op = deltas[0]!;
    expect(op.op).toBe("workflowRun.updated");
    if (op.op !== "workflowRun.updated") return;
    expect(op.nodes).toEqual([{ siteId: "ask#1", ordinal: 7, kind: "ask", phase: "dispatched" }]);
    expect(op.actors).toBeUndefined();
    // 派发计步改了 usage，header 里因此只有这一个键 + 水位。
    expect(Object.keys(op.run ?? {}).sort()).toEqual(["lastEventSequence", "usage"]);
  });

  // 删除有词汇（removedActors / removedNodes，腾位用），**重排没有**。所以下面第一种输入走键化
  // 路径、第二种只能退回整键重发——上面的往返用例断言「全程没有一条 state.updated」，任何一天
  // 有人让归约重排了条目，那里会立刻红。
  it("条目被删走键化路径，被重排则退回整键重发", () => {
    const state = expectRoundTripFinal(fullRunEvents());
    const run = state.runs[0]!;
    const shortened: WorkflowRunsState = {
      revision: state.revision + 1,
      runs: [{ ...run, nodes: run.nodes.slice(0, -1) }],
    };
    expect(diffWorkflowRunsState(state, shortened)).toEqual([
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: shortened.revision,
        removedNodes: [{ siteId: run.nodes.at(-1)!.siteId, ordinal: run.nodes.at(-1)!.ordinal }],
      },
    ]);
    expect(
      JSON.stringify(
        applyConversationDeltas(snapshotWith(state), diffWorkflowRunsState(state, shortened))
          .workflowRuns,
      ),
    ).toBe(JSON.stringify(shortened));

    const reordered: WorkflowRunsState = {
      revision: state.revision + 1,
      runs: [{ ...run, nodes: [...run.nodes].reverse() }],
    };
    expect(diffWorkflowRunsState(state, reordered)).toEqual([
      { op: "state.updated", patch: { workflowRuns: reordered } },
    ]);
    // 退路本身仍然正确：整键替换后逐字节一致。
    const applied = applyConversationDeltas(
      snapshotWith(state),
      diffWorkflowRunsState(state, reordered),
    );
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(reordered));
  });

  it("冷启动（客户端还没有这个键）：整条 header + 全部条目的诞生增量", () => {
    const state = expectRoundTripFinal(fullRunEvents());
    const deltas = diffWorkflowRunsState(undefined, state);
    expect(deltas).toHaveLength(1);
    const op = deltas[0]!;
    if (op.op !== "workflowRun.updated") throw new Error("诞生必须是一条 workflowRun.updated");
    expect(isCompleteWorkflowRunHeader(op.run)).toBe(true);
    expect(op.nodes).toHaveLength(state.runs[0]!.nodes.length);
    const applied = applyConversationDeltas(snapshotWith(undefined), deltas);
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(state));
  });
});

/** 跑完整串事件，返回终态（上面的往返断言在 expectRoundTrip 里，这里只要状态）。 */
function expectRoundTripFinal(
  envelopes: readonly WorkflowRunProgressEnvelope[],
): WorkflowRunsState {
  let state: WorkflowRunsState | undefined;
  for (const envelope of envelopes) state = reduceWorkflowRunsState(state, envelope) ?? state;
  return state!;
}

describe("coalesce 规则 6 × diff 产出的真实增量", () => {
  /** 把两条 run 的事件交错成一个 flush 窗口，收集逐步 diff 出来的全部增量。 */
  function windowOf(...streams: readonly WorkflowRunProgressEnvelope[][]): {
    deltas: ConversationDelta[];
    final: WorkflowRunsState;
  } {
    const interleaved: WorkflowRunProgressEnvelope[] = [];
    const longest = Math.max(...streams.map((stream) => stream.length));
    for (let index = 0; index < longest; index += 1) {
      for (const stream of streams) {
        const envelope = stream[index];
        if (envelope !== undefined) interleaved.push(envelope);
      }
    }
    let state: WorkflowRunsState | undefined;
    const deltas: ConversationDelta[] = [];
    for (const envelope of interleaved) {
      const next = reduceWorkflowRunsState(state, envelope);
      if (next === null) continue;
      deltas.push(...diffWorkflowRunsState(state, next));
      state = next;
    }
    return { deltas, final: state! };
  }

  it("合并前后终态逐字节一致，且每条 run 在窗口里塌成一条增量", () => {
    const { deltas, final } = windowOf(fullRunEvents(), secondRunEvents());
    const base = snapshotWith(undefined);
    const direct = applyConversationDeltas(base, deltas);
    const coalesced = coalesceConversationDeltas(deltas);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    // 逐条投递本来就该收敛到 reducer 的终态；合并只是不许改变它。
    expect(JSON.stringify(direct.workflowRuns)).toBe(JSON.stringify(final));
    // 塌缩：几十条引擎事件 → 每条 run 一条增量，与 fan-out 宽度无关（500 条帧界的由来）。
    expect(deltas.length).toBeGreaterThan(20);
    expect(coalesced).toHaveLength(2);
  });

  it("窗口里夹着整键重发的屏障时，屏障两侧各自塌缩且终态不变", () => {
    const { deltas, final } = windowOf(fullRunEvents(), secondRunEvents());
    const half = Math.floor(deltas.length / 2);
    const midpoint = applyConversationDeltas(
      snapshotWith(undefined),
      deltas.slice(0, half),
    ).workflowRuns!;
    const withBarrier: ConversationDelta[] = [
      ...deltas.slice(0, half),
      { op: "state.updated", patch: { workflowRuns: midpoint } },
      ...deltas.slice(half),
    ];
    const base = snapshotWith(undefined);
    const direct = applyConversationDeltas(base, withBarrier);
    const coalesced = coalesceConversationDeltas(withBarrier);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    expect(JSON.stringify(direct.workflowRuns)).toBe(JSON.stringify(final));
    expect(coalesced.filter((delta) => delta.op === "state.updated")).toHaveLength(1);
  });

  it("淘汰吞掉同 run 此前的增量，终态仍与逐条投递一致", () => {
    const { deltas, final } = windowOf(fullRunEvents(), secondRunEvents(), evictionEvents());
    const base = snapshotWith(undefined);
    const direct = applyConversationDeltas(base, deltas);
    const coalesced = coalesceConversationDeltas(deltas);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    expect(JSON.stringify(direct.workflowRuns)).toBe(JSON.stringify(final));
    // 被淘汰的 run：屏障之前的增量被吞干净（出生+淘汰同窗口 = 客户端没见过它）。屏障之后还可能
    // 再出现一条——迟到的事件让这条 runId 作为**新条目**回到队尾，那是另一件事，不该被吞。
    const removedAt = coalesced.findIndex(
      (delta) => delta.op === "workflowRun.removed" && delta.runId === RUN_ID,
    );
    expect(removedAt).toBeGreaterThanOrEqual(0);
    const firstUpdate = coalesced.findIndex(
      (delta) => delta.op === "workflowRun.updated" && delta.runId === RUN_ID,
    );
    expect(firstUpdate === -1 || firstUpdate > removedAt).toBe(true);
  });
});

describe("apply：workflowRun.* 的边界语义", () => {
  const born: ConversationDelta = {
    op: "workflowRun.updated",
    runId: RUN_ID,
    revision: 3,
    run: {
      runId: RUN_ID,
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      lastEventSequence: 0,
    },
  };

  it("未知 run + 完整 header = 诞生；条目缺席按空表建", () => {
    const applied = applyConversationDeltas(snapshotWith(undefined), [born]);
    expect(applied.workflowRuns).toEqual({
      revision: 3,
      runs: [
        {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors: [],
          nodes: [],
          lastEventSequence: 0,
        },
      ],
    });
    expect(workflowRunsStateSchema.safeParse(applied.workflowRuns).success).toBe(true);
  });

  it("未知 run + 残缺 header = 不建条目（与 row.upserted 命中未加载行同一条裁决）", () => {
    const applied = applyConversationDeltas(snapshotWith(undefined), [
      { op: "workflowRun.updated", runId: "dwfrun-ghost", revision: 5, run: { status: "running" } },
      { op: "workflowRun.updated", runId: "dwfrun-ghost", revision: 6, nodes: [ASK_NODE] },
    ]);
    expect(applied.workflowRuns?.runs).toEqual([]);
    // 容器 revision 仍然跟上：生产者对版本的断言与它能不能安放这条 run 是两回事。
    expect(applied.workflowRuns?.revision).toBe(6);
  });

  it("removed 命中未知 runId 只让 revision 跟上，不抛", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [born]);
    const applied = applyConversationDeltas(seeded, [
      { op: "workflowRun.removed", runId: "dwfrun-别的", revision: 9 },
    ]);
    expect(applied.workflowRuns?.runs.map((run) => run.runId)).toEqual([RUN_ID]);
    expect(applied.workflowRuns?.revision).toBe(9);
  });

  it("revision 取 max：合并后靠前的 op 携带靠后的 revision 也不会把容器版本拉回去", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [born]);
    const applied = applyConversationDeltas(seeded, [
      { op: "workflowRun.updated", runId: RUN_ID, revision: 12, run: { status: "completed" } },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 7, run: { lastEventSequence: 4 } },
    ]);
    expect(applied.workflowRuns?.revision).toBe(12);
  });

  it("身份：没动过的 run 与条目保持引用，动过的那条 run 与容器是新对象", () => {
    const twoRuns = applyConversationDeltas(snapshotWith(undefined), [
      born,
      { ...born, runId: "dwfrun-2", run: { ...born.run, runId: "dwfrun-2" } } as ConversationDelta,
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 4,
        nodes: [ASK_NODE, { siteId: "ask#2", ordinal: 1, phase: "queued" }],
      },
    ]);
    const before = twoRuns.workflowRuns!;
    const after = applyConversationDeltas(twoRuns, [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 5,
        nodes: [{ siteId: "ask#2", ordinal: 1, phase: "dispatched" }],
      },
    ]).workflowRuns!;

    expect(after).not.toBe(before);
    expect(after.runs[0]).not.toBe(before.runs[0]);
    // 另一条 run 与被改 run 里没动过的那个节点都保持引用——GUI 的两级 memo 靠的就是这个。
    expect(after.runs[1]).toBe(before.runs[1]);
    expect(after.runs[0]!.nodes[0]).toBe(before.runs[0]!.nodes[0]);
    expect(after.runs[0]!.nodes[1]).not.toBe(before.runs[0]!.nodes[1]);
    // actors 没被这条 op 提到：整张表保持引用。
    expect(after.runs[0]!.actors).toBe(before.runs[0]!.actors);
  });

  it("客户端从不自行施加上界：maxRuns 之外的诞生照样落表（只有生产者淘汰，且必须说出来）", () => {
    const births = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns + 3 }, (_, index) => ({
      ...born,
      runId: `dwfrun-${index}`,
      revision: index + 1,
      run: { ...born.run, runId: `dwfrun-${index}` },
    })) as ConversationDelta[];
    const applied = applyConversationDeltas(snapshotWith(undefined), births);
    // 客户端自行裁剪只会让两侧悄悄分叉：生产者以为发过的 run 在这边根本不存在。
    expect(applied.workflowRuns?.runs).toHaveLength(WORKFLOW_RUNS_LIMITS.maxRuns + 3);
  });

  it("两个 apply twin 在 workflowRun.* 上逐字节等价", () => {
    const deltas: ConversationDelta[] = [
      born,
      { op: "workflowRun.updated", runId: RUN_ID, revision: 4, nodes: [ASK_NODE] },
      {
        op: "workflowRun.updated",
        runId: "dwfrun-2",
        revision: 5,
        run: { ...born.run, runId: "dwfrun-2" },
      },
      { op: "workflowRun.removed", runId: RUN_ID, revision: 6 },
    ];
    const base = snapshotWith(undefined);
    const immutable = applyConversationDeltas(base, deltas);
    const accumulator = createMutableConversationSnapshotAccumulator(base);
    applyConversationDeltasMutable(accumulator, deltas);
    expect(JSON.stringify(accumulator.snapshot.workflowRuns)).toBe(
      JSON.stringify(immutable.workflowRuns),
    );
    expect(immutable.workflowRuns?.runs.map((run) => run.runId)).toEqual(["dwfrun-2"]);
    // 入参不被修改。
    expect(base.workflowRuns).toBeUndefined();
  });
});

const ASK_NODE = { siteId: "ask#1", ordinal: 1, phase: "queued" } as const;

// ── 条目淘汰的线上表达：removedActors / removedNodes ────────────────────────
//
// 归约到界之后会淘汰终态条目给活的新人腾位（workflow-runs-eviction.ts），于是这个模型第一次
// 需要说出「这条走了」。下面钉的仍是文件头那条契约（diff 施加到 prior 与 next 逐字节一致），
// 只是输入里多了删除；外加一条：合并两条增量必须等于顺序施加它们。

/** 手搓一条 run：本节测的是 diff/apply/merge 的代数，走一遍归约反而看不清输入。 */
function runWithNodes(
  nodes: readonly { siteId: string; ordinal: number; phase: string }[],
  actors: readonly { siteId: string; ordinal: number; status: string }[] = [],
): WorkflowRunState {
  return canonicalWorkflowRun({
    runId: RUN_ID,
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: actors as WorkflowRunState["actors"],
    nodes: nodes as WorkflowRunState["nodes"],
    lastEventSequence: 1,
  } as WorkflowRunState);
}

const queued = (siteId: string) => ({ siteId, ordinal: 1, phase: "queued" as const });
const settled = (siteId: string) => ({ siteId, ordinal: 1, phase: "settled" as const });
const waiting = (siteId: string) => ({ siteId, ordinal: 1, status: "waiting" as const });

/** 单条 run 的 diff，取出那条 updated（本节的输入都不触发整键重发）。 */
function updateBetween(before: WorkflowRunState, after: WorkflowRunState) {
  const deltas = diffWorkflowRunsState(
    { revision: 1, runs: [before] },
    { revision: 2, runs: [after] },
  );
  expect(deltas).toHaveLength(1);
  const op = deltas[0]!;
  if (op.op !== "workflowRun.updated") throw new Error("应当是一条 workflowRun.updated");
  // 契约：施加到 prior 之后与 next 逐字节一致。
  const applied = applyConversationDeltas(snapshotWith({ revision: 1, runs: [before] }), deltas);
  expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify({ revision: 2, runs: [after] }));
  return op;
}

describe("diff：条目被删时走键化路径", () => {
  it("中间少了一条：removedNodes 说出来，其余条目一个字节都不重发", () => {
    const op = updateBetween(
      runWithNodes([queued("a"), queued("b"), queued("c")]),
      runWithNodes([queued("a"), queued("c")]),
    );
    expect(op.removedNodes).toEqual([{ siteId: "b", ordinal: 1 }]);
    expect(op.nodes).toBeUndefined();
  });

  it("删除 + 追加 + 幸存者变化同时发生", () => {
    const op = updateBetween(
      runWithNodes([queued("a"), queued("b"), queued("c")]),
      runWithNodes([settled("a"), queued("c"), queued("d")]),
    );
    expect(op.removedNodes).toEqual([{ siteId: "b", ordinal: 1 }]);
    expect(op.nodes).toEqual([settled("a"), queued("d")]);
  });

  it("两张表各自走各自的路径：actors 删、nodes 只追加", () => {
    const op = updateBetween(
      runWithNodes([queued("a")], [waiting("x"), waiting("y")]),
      runWithNodes([queued("a"), queued("b")], [waiting("y")]),
    );
    expect(op.removedActors).toEqual([{ siteId: "x", ordinal: 1 }]);
    expect(op.removedNodes).toBeUndefined();
    expect(op.nodes).toEqual([queued("b")]);
  });

  it("整张表被清空（溢出过的 run 在 resume 时重开）", () => {
    const op = updateBetween(
      runWithNodes([queued("a"), queued("b")], [waiting("x")]),
      runWithNodes([], []),
    );
    expect(op.removedNodes).toEqual([
      { siteId: "a", ordinal: 1 },
      { siteId: "b", ordinal: 1 },
    ]);
    expect(op.removedActors).toEqual([{ siteId: "x", ordinal: 1 }]);
  });

  it("重排仍然退回整键重发：删除之外的顺序变化这个模型表达不了", () => {
    const before = { revision: 1, runs: [runWithNodes([queued("a"), queued("b")])] };
    const after = { revision: 2, runs: [runWithNodes([queued("b"), queued("a")])] };
    expect(diffWorkflowRunsState(before, after)).toEqual([
      { op: "state.updated", patch: { workflowRuns: after } },
    ]);
  });
});

describe("apply：一条 op 内先删后加", () => {
  it("同一个键在一条 op 里被删又被加 → 落在表尾", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        nodes: [queued("a"), queued("b")],
      },
    ]);
    const applied = applyConversationDeltas(seeded, [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
        nodes: [settled("a")],
      },
    ]);
    expect(applied.workflowRuns?.runs[0]?.nodes).toEqual([queued("b"), settled("a")]);
  });

  it("删到一条不剩 + 未命中的键是 no-op；没被提到的表保持引用", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        actors: [waiting("x")],
        nodes: [queued("a")],
      },
    ]);
    const applied = applyConversationDeltas(seeded, [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [
          { siteId: "a", ordinal: 1 },
          { siteId: "从来没有过", ordinal: 7 },
        ],
      },
    ]);
    expect(applied.workflowRuns?.runs[0]?.nodes).toEqual([]);
    expect(applied.workflowRuns?.runs[0]?.actors).toBe(seeded.workflowRuns?.runs[0]?.actors);
  });
});

describe("merge（coalesce 规则 6 的载荷）：合并必须等于顺序施加", () => {
  const birth: ConversationDelta = {
    op: "workflowRun.updated",
    runId: RUN_ID,
    revision: 1,
    run: {
      runId: RUN_ID,
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      lastEventSequence: 0,
    },
    nodes: [queued("a"), queued("b"), queued("c")],
  };

  /** 裁判：合并后施加 与 顺序施加 逐字节一致（两条 op 都以 birth 建好的表为底）。 */
  function expectMergeEqualsSequential(
    earlier: ConversationDelta,
    later: ConversationDelta,
  ): ConversationDelta {
    const base = applyConversationDeltas(snapshotWith(undefined), [birth]);
    const sequential = applyConversationDeltas(base, [earlier, later]);
    const merged = coalesceConversationDeltas([earlier, later]);
    expect(merged).toHaveLength(1);
    expect(JSON.stringify(applyConversationDeltas(base, merged).workflowRuns)).toBe(
      JSON.stringify(sequential.workflowRuns),
    );
    expect(conversationDeltaSchema.safeParse(merged[0]).success).toBe(true);
    return merged[0]!;
  }

  it("先删后加同一个键：合并后它仍然落在表尾", () => {
    const merged = expectMergeEqualsSequential(
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
      },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 3, nodes: [settled("a")] },
    );
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 updated");
    expect(merged.removedNodes).toEqual([{ siteId: "a", ordinal: 1 }]);
    expect(merged.nodes).toEqual([settled("a")]);
  });

  it("先者 upsert 的键被后者删掉：合并后它从 upsert 里消失", () => {
    const merged = expectMergeEqualsSequential(
      { op: "workflowRun.updated", runId: RUN_ID, revision: 2, nodes: [settled("b"), queued("d")] },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedNodes: [{ siteId: "d", ordinal: 1 }],
      },
    );
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 updated");
    expect(merged.nodes).toEqual([settled("b")]);
    expect(merged.removedNodes).toEqual([{ siteId: "d", ordinal: 1 }]);
  });

  it("两侧的删除取并集、按首次出现去重", () => {
    const merged = expectMergeEqualsSequential(
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [
          { siteId: "a", ordinal: 1 },
          { siteId: "b", ordinal: 1 },
        ],
      },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedNodes: [
          { siteId: "b", ordinal: 1 },
          { siteId: "c", ordinal: 1 },
        ],
      },
    );
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 updated");
    expect(merged.removedNodes).toEqual([
      { siteId: "a", ordinal: 1 },
      { siteId: "b", ordinal: 1 },
      { siteId: "c", ordinal: 1 },
    ]);
  });

  it("先加新键、后删另一个旧键：新键仍追在幸存者后面", () => {
    expectMergeEqualsSequential(
      { op: "workflowRun.updated", runId: RUN_ID, revision: 2, nodes: [queued("d")] },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
      },
    );
  });

  it("合并出来会超界时**不合并**：超界的帧会被整帧丢掉，订阅从此静默", () => {
    // 腾位之前，「一个窗口里被碰过的不同键 ≤ 表界」是结构性的（表只增不减）；腾位之后不是了。
    const ref = (ordinal: number) => ({ siteId: "ask#1", ordinal });
    const wide = (revision: number, from: number, count: number): ConversationDelta => ({
      op: "workflowRun.updated",
      runId: RUN_ID,
      revision,
      removedNodes: Array.from({ length: count }, (_, index) => ref(from + index)),
    });
    const deltas = [wide(2, 0, WORKFLOW_RUNS_LIMITS.maxNodes), wide(3, 100_000, 100)];
    const coalesced = coalesceConversationDeltas(deltas);
    expect(coalesced).toHaveLength(2);
    for (const delta of coalesced) {
      expect(conversationDeltaSchema.safeParse(delta).success).toBe(true);
    }
    // 不合并不改变终态：逐条投递与"合并"后的序列施加出来的是同一份状态。
    const base = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        nodes: [queued("a"), { siteId: "ask#1", ordinal: 3, phase: "settled" }],
      },
    ]);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(applyConversationDeltas(base, deltas).workflowRuns),
    );
    // 界内的两条仍然照常合并（这道闸只在真的装不下时才拦）。
    expect(coalesceConversationDeltas([wide(2, 0, 10), wide(3, 100, 10)])).toHaveLength(1);
  });

  it("合并被拒之后，后来的 op 只能并进**最后**那条——并回更早那条会吃掉一个先删后加的键", () => {
    const ref = (ordinal: number) => ({ siteId: "ask#9", ordinal });
    const key = { siteId: "ask#1", ordinal: 1 };
    const base = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        nodes: [queued("ask#1"), queued("x")],
      },
    ]);
    // A 把删除表塞到界上 → B 并不进去，只能另立一条；C 若越过 B 并回 A，
    // 它的 upsert 就跑到了 B 的删除**之前**，ask#1 会凭空消失。
    const deltas: ConversationDelta[] = [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, i) => ref(i)),
      },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 3, removedNodes: [key] },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 4, nodes: [settled("ask#1")] },
    ];
    const coalesced = coalesceConversationDeltas(deltas);
    expect(coalesced).toHaveLength(2);
    const direct = applyConversationDeltas(base, deltas);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    // 先删后加的键落在表尾，而不是被吃掉。
    expect(direct.workflowRuns?.runs[0]?.nodes).toEqual([queued("x"), settled("ask#1")]);
  });

  it("actors 与 nodes 各删各的，互不相干", () => {
    expectMergeEqualsSequential(
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
        actors: [waiting("x")],
      },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedActors: [{ siteId: "x", ordinal: 1 }],
        nodes: [settled("c")],
      },
    );
  });
});

describe("canonicalWorkflowRun：规范键序", () => {
  it("按 schema 声明序重建，undefined 值的键按缺席处理", () => {
    const scrambled = {
      lastEventSequence: 3,
      nodes: [],
      status: "running",
      actors: [],
      usage: { spentTokens: 0, nodesUsed: 0 },
      runId: RUN_ID,
      error: undefined,
    } as unknown as WorkflowRunState;
    expect(Object.keys(canonicalWorkflowRun(scrambled))).toEqual([
      "runId",
      "status",
      "usage",
      "actors",
      "nodes",
      "lastEventSequence",
    ]);
  });

  it("header 键表就是 schema 的键减去两张增量表", () => {
    expect(WORKFLOW_RUN_HEADER_KEYS).toEqual(
      Object.keys(workflowRunSchema.shape).filter((key) => key !== "actors" && key !== "nodes"),
    );
  });

  it("归约产出的 run 已经是规范序（diff 的字节等价不靠调用方再排一次）", () => {
    const state = expectRoundTripFinal(fullRunEvents());
    const run = state.runs[0]!;
    expect(Object.keys(run)).toEqual(Object.keys(canonicalWorkflowRun(run)));
  });
});

describe("conversationDeltaSchema：两条新 op", () => {
  it("增量 op 解析通过，并保住 cleared / 条目载荷", () => {
    const parsed = conversationDeltaSchema.parse({
      op: "workflowRun.updated",
      runId: RUN_ID,
      revision: 7,
      run: { status: "completed", lastEventSequence: 9 },
      cleared: ["pendingQuestions"],
      actors: [{ siteId: "actor#1", ordinal: 1, status: "completed" }],
      nodes: [ASK_NODE],
    });
    expect(parsed).toMatchObject({ op: "workflowRun.updated", cleared: ["pendingQuestions"] });
    expect(
      conversationDeltaSchema.parse({ op: "workflowRun.removed", runId: RUN_ID, revision: 1 }),
    ).toMatchObject({ op: "workflowRun.removed" });
  });

  it("条目淘汰的两个载荷：只带身份，界与两张表同值", () => {
    const parsed = conversationDeltaSchema.parse({
      op: "workflowRun.updated",
      runId: RUN_ID,
      revision: 8,
      removedActors: [{ siteId: "actor#1", ordinal: 1 }],
      removedNodes: [{ siteId: "ask#1", ordinal: 1 }],
    });
    expect(parsed).toMatchObject({ removedNodes: [{ siteId: "ask#1", ordinal: 1 }] });
    // 淘汰载荷说的是**身份**，不是条目：多带的键被剥掉，不会让整条 op 变成一次 upsert。
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        removedNodes: [{ siteId: "ask#1" }],
      }).success,
    ).toBe(false);
    const ref = (ordinal: number) => ({ siteId: "ask#1", ordinal });
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        removedNodes: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, i) => ref(i)),
      }).success,
    ).toBe(true);
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        removedNodes: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes + 1 }, (_, i) => ref(i)),
      }).success,
    ).toBe(false);
  });

  it("坏载荷一律拒收：负 revision、空 runId、非 header 键的 cleared", () => {
    expect(
      conversationDeltaSchema.safeParse({ op: "workflowRun.updated", runId: RUN_ID, revision: -1 })
        .success,
    ).toBe(false);
    expect(
      conversationDeltaSchema.safeParse({ op: "workflowRun.updated", runId: "", revision: 1 })
        .success,
    ).toBe(false);
    // nodes / actors 不是 header 键：它们有自己的增量载荷，清不掉。
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        cleared: ["nodes"],
      }).success,
    ).toBe(false);
    // 状态键上的坏值同样进不来（run 是 header 的 partial，不是任意对象）。
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: { status: "exploded" },
      }).success,
    ).toBe(false);
  });

  it("条目表的界与状态键同值：增量拼不出一个非法状态", () => {
    const node = (ordinal: number) => ({ siteId: "ask#1", ordinal, phase: "queued" });
    const withinBound = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, i) => node(i));
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        nodes: withinBound,
      }).success,
    ).toBe(true);
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        nodes: [...withinBound, node(9_999)],
      }).success,
    ).toBe(false);
    const actor = (ordinal: number) => ({ siteId: "actor#1", ordinal, status: "waiting" });
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        actors: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxActors + 1 }, (_, i) => actor(i)),
      }).success,
    ).toBe(false);
  });
});
