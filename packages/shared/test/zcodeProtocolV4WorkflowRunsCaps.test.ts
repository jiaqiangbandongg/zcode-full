// workflowRuns 的**界**留下的三样东西：被拒实例的计数器、整键的条目预算、给旧消费者的裁剪。
//
// 改造前 nodes/actors 压在 256，是因为状态键按事件整体重发、无界即 O(N²) 字节；键级增量落地后
// 那条理由没了，界抬到 1024。但抬界不是免费的：一个 50 路 fan-out 的宽工作流仍然可能把整张表
// 撑到几 MB，所以多了一条**跨 run 的**条目预算；而触界仍然会拒掉实例，所以读面必须能说出
// 「有多少步没进表」——这就是两个计数器存在的全部理由。
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  clampWorkflowRunsForLegacy,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunStepCounts,
  workflowRunsStateSchema,
  type ConversationSnapshot,
  type WorkflowRunNode,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/** 一条手搓的 run：直接把表灌满，省下上千次归约（被测的是触界之后的事）。 */
function runWith(
  overrides: Partial<WorkflowRunState> & { runId?: string } = {},
  nodeCount = 0,
  actorCount = 0,
): WorkflowRunState {
  return {
    runId: overrides.runId ?? RUN_ID,
    // 事件信封一律带 tc-1：不在夹具里先补上，第一条事件就会因为「补齐 toolCallId」而产生变化，
    // 把本文件所有「这条事件什么都不该改」的断言变成假阳性。
    toolCallId: "tc-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: Array.from({ length: actorCount }, (_, index) => ({
      siteId: "actor#1",
      ordinal: index,
      status: "completed" as const,
    })),
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      siteId: "ask#1",
      ordinal: index,
      phase: "settled" as const,
    })),
    lastEventSequence: 100,
    ...overrides,
  };
}

function stateWith(...runs: WorkflowRunState[]): WorkflowRunsState {
  return { revision: 10, runs };
}

/** 事件信封：sequence 显式给，本文件大半的断言都盯着水位。 */
function event(
  eventType: string,
  payload: Record<string, unknown>,
  sequence: number,
  runId = RUN_ID,
): WorkflowRunProgressEnvelope {
  return { runId, toolCallId: "tc-1", sequence, eventType, payload };
}

const FULL_NODES = WORKFLOW_RUNS_LIMITS.maxNodes;
/**
 * 表已满、且**一条都淘汰不动**的 run：之后每一条新实例都会被拒。
 *
 * 节点全部停在 `executing` 是这条夹具的要点：腾位只淘汰终态条目
 * （workflow-runs-eviction.ts），所以一张全是活节点的满表恰好就是「拒新」那条老路径，
 * 而本节钉的正是被拒实例怎么继续可数。淘汰路径在 …WorkflowRunsEviction.test.ts。
 */
const fullRun = () =>
  runWith(
    {
      truncated: true,
      nodes: Array.from({ length: FULL_NODES }, (_, index) => ({
        siteId: "ask#1",
        ordinal: index,
        phase: "executing" as const,
      })),
    },
    FULL_NODES,
  );
/** 一个表里没有的实例（ordinal 远在界外）。 */
const rejected = (ordinal: number) => ({ siteId: "ask#9", ordinal });

describe("WORKFLOW_RUNS_LIMITS：抬界之后的两条界", () => {
  it("nodes 与 actors 同界 1024；条目预算 6144 小于「满 8 条 run」的 16384", () => {
    expect(WORKFLOW_RUNS_LIMITS.maxNodes).toBe(1_024);
    expect(WORKFLOW_RUNS_LIMITS.maxActors).toBe(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(WORKFLOW_RUNS_LIMITS.maxTotalEntries).toBe(6_144);
    const worstCaseWithoutBudget =
      WORKFLOW_RUNS_LIMITS.maxRuns *
      (WORKFLOW_RUNS_LIMITS.maxNodes + WORKFLOW_RUNS_LIMITS.maxActors);
    expect(WORKFLOW_RUNS_LIMITS.maxTotalEntries).toBeLessThan(worstCaseWithoutBudget);
  });

  it("旧消费者的界是 256，且**永远不能变**（它是别人编译进去的校验界）", () => {
    expect(WORKFLOW_RUNS_LEGACY_LIMITS).toEqual({ maxActors: 256, maxNodes: 256 });
  });
});

describe("被拒实例的计数器（usage.nodesUnlisted / nodesUnlistedSettled）", () => {
  it("node-queued 撞界 → nodesUnlisted +1，表本身不增长", () => {
    const next = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-queued", { instance: rejected(5_000), kind: "ask" }, 101),
    );
    expect(next?.runs[0]?.nodes).toHaveLength(FULL_NODES);
    expect(next?.runs[0]?.usage).toEqual({
      spentTokens: 0,
      nodesUsed: 0,
      nodesUnlisted: 1,
    });
    expect(workflowRunsStateSchema.safeParse(next).success).toBe(true);
  });

  it("缓存命中的结算是**出生**：两个计数器一起 +1", () => {
    const next = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-settled", { instance: rejected(5_000), outcome: "ok", cached: true }, 101),
    );
    expect(next?.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("普通 node-settled 只 +settled：它的出生（queued）此前已经计过", () => {
    const queued = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-queued", { instance: rejected(5_000), kind: "ask" }, 101),
    )!;
    const settled = reduceWorkflowRunsState(
      queued,
      event("node-settled", { instance: rejected(5_000), outcome: "ok" }, 102),
    );
    expect(settled?.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("被拒实例的中间相位一个都不计（dispatched / executing / waiting / repairing / nudged / progress）", () => {
    let state: WorkflowRunsState = stateWith(fullRun());
    let sequence = 100;
    for (const eventType of [
      "node-dispatched",
      "node-executing",
      "node-waiting",
      "node-repairing",
      "node-nudged",
      "node-progress",
    ]) {
      sequence += 1;
      state =
        reduceWorkflowRunsState(state, event(eventType, { instance: rejected(5_000) }, sequence)) ??
        state;
    }
    expect(state.runs[0]?.usage).not.toHaveProperty("nodesUnlisted");
    expect(state.runs[0]?.usage).not.toHaveProperty("nodesUnlistedSettled");
    // `nodesUsed` 是另一码事，而且是**既有**行为：首次派发计一步，被拒实例照样计——
    // 步数是 run 级事实，不受展示界约束（归约主文件里 firstDispatch 那段注释）。
    expect(state.runs[0]?.usage.nodesUsed).toBe(1);
    // 水位照抬：事件到达过是事实，只是它不改变「有多少步没进表」。
    expect(state.runs[0]?.lastEventSequence).toBe(sequence);
  });

  it("**在表里**的实例永远不计：queued 与 settled 都只更新那一行", () => {
    const state = stateWith(runWith({}, 3));
    const queued = reduceWorkflowRunsState(
      state,
      event("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }, 101),
    )!;
    expect(queued.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
    const settled = reduceWorkflowRunsState(
      queued,
      event("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }, 102),
    )!;
    expect(settled.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
    expect(settled.runs[0]?.nodes).toHaveLength(3);
  });

  it("同一条事件重放仍是 null no-op：只有抬过水位的事件才计数", () => {
    // 这是计数器唯一的幂等支点。没有这条守卫，一条被重传的队尾事件会把计数器越推越高，
    // 而计数器是**加出来**的、没有可去重的身份（被拒实例根本不在表里）。
    const replayed = event("node-queued", { instance: rejected(5_000), kind: "ask" }, 101);
    const once = reduceWorkflowRunsState(stateWith(fullRun()), replayed)!;
    expect(once.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1 });
    expect(reduceWorkflowRunsState(once, replayed)).toBeNull();
  });

  it("迟到的低 sequence 事件不计数（水位没被抬过）", () => {
    const late = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-queued", { instance: rejected(5_000), kind: "ask" }, 50),
    );
    // 内容上没有任何变化：表满、水位不退、计数器不动 → 整条无变化。
    expect(late).toBeNull();
  });

  it("run-started 清零两个计数器：resume 会把整段脚本前缀重发一遍", () => {
    // 重开一世时引擎会把已完成实例的 cached settle 与新实例的 queued 全部再发一次，
    // 不清零就等于把上一世的「没进表的步数」和这一世的加在一起。
    const counted = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-settled", { instance: rejected(5_000), outcome: "ok", cached: true }, 101),
    )!;
    expect(counted.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    const rearmed = reduceWorkflowRunsState(
      counted,
      event("run-started", { caps: { maxConcurrency: 2 } }, 102),
    )!;
    expect(rearmed.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
  });

  it("零时整个键缺席（不是 0）：没撞过界的 run 一个新键都不多", () => {
    const next = reduceWorkflowRunsState(
      stateWith(runWith({}, 3)),
      event("node-queued", { instance: { siteId: "ask#2", ordinal: 1 }, kind: "ask" }, 101),
    );
    expect(next?.runs[0]?.usage).not.toHaveProperty("nodesUnlisted");
    expect(next?.runs[0]?.usage).not.toHaveProperty("nodesUnlistedSettled");
  });

  it("settled 永不超过 unlisted：每次结算的出生此前都计过（一世之内）", () => {
    // 引擎在一世之内对同一实例最多发一条 queued、最多发一条 settled（scheduler 的 settled 闩），
    // 缓存命中的结算则自带出生。所以这条不变量是**结构性**的，不靠夹逼。
    let state: WorkflowRunsState = stateWith(fullRun());
    let sequence = 100;
    const step = (eventType: string, payload: Record<string, unknown>) => {
      sequence += 1;
      state = reduceWorkflowRunsState(state, event(eventType, payload, sequence)) ?? state;
    };
    for (let ordinal = 5_000; ordinal < 5_005; ordinal += 1) {
      step("node-queued", { instance: rejected(ordinal), kind: "ask" });
      step("node-dispatched", { instance: rejected(ordinal) });
      step("node-settled", { instance: rejected(ordinal), outcome: "ok" });
    }
    // 一条只缓存命中的（没有 queued）。
    step("node-settled", { instance: rejected(6_000), outcome: "ok", cached: true });
    // 一条 queued 了但这一世永远没结算（run 级失败时引擎不补发 cancelled）。
    step("node-queued", { instance: rejected(7_000), kind: "ask" });
    const usage = state.runs[0]!.usage;
    expect(usage.nodesUnlisted).toBe(7);
    expect(usage.nodesUnlistedSettled).toBe(6);
    expect(usage.nodesUnlistedSettled!).toBeLessThanOrEqual(usage.nodesUnlisted!);
  });
});

describe("workflowRunStepCounts：表内 + 表外的唯一读法", () => {
  it("总数与已结算数都把被拒实例算进去", () => {
    const run = runWith(
      {
        usage: { spentTokens: 0, nodesUsed: 0, nodesUnlisted: 5, nodesUnlistedSettled: 2 },
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled" },
          { siteId: "ask#1", ordinal: 2, phase: "executing" },
          { siteId: "ask#1", ordinal: 3, phase: "settled" },
        ] satisfies WorkflowRunNode[],
      },
      0,
    );
    expect(workflowRunStepCounts(run)).toEqual({ total: 8, settled: 4 });
  });

  it("计数器缺席时退化成「表里有多少算多少」", () => {
    const run = runWith({
      nodes: [
        { siteId: "ask#1", ordinal: 1, phase: "settled" },
        { siteId: "ask#1", ordinal: 2, phase: "queued" },
      ] satisfies WorkflowRunNode[],
    });
    expect(workflowRunStepCounts(run)).toEqual({ total: 2, settled: 1 });
  });
});

describe("条目预算：整键 6144 条，淘汰最旧的终态 run", () => {
  // 一条**满界**的 run 是 1024 + 1024 = 2048 条，预算正好装得下三条。所以「四条满界的 run」
  // 是这条规则最小的现实场景：淘汰一条就回到预算内，不多淘汰一条。
  const FULL_RUN_ENTRIES = WORKFLOW_RUNS_LIMITS.maxNodes + WORKFLOW_RUNS_LIMITS.maxActors;
  const big = (runId: string, status: WorkflowRunState["status"]) =>
    runWith(
      { runId, status, truncated: true },
      WORKFLOW_RUNS_LIMITS.maxNodes,
      WORKFLOW_RUNS_LIMITS.maxActors,
    );
  const queueOne = (state: WorkflowRunsState) =>
    reduceWorkflowRunsState(
      state,
      event("node-queued", { instance: { siteId: "ask#new", ordinal: 1 }, kind: "ask" }, 101),
    )!;

  it("四条满界 run 超预算：淘汰最旧的终态 run，回到预算内就停手", () => {
    expect(FULL_RUN_ENTRIES * 4).toBeGreaterThan(WORKFLOW_RUNS_LIMITS.maxTotalEntries);
    expect(FULL_RUN_ENTRIES * 3).toBeLessThanOrEqual(WORKFLOW_RUNS_LIMITS.maxTotalEntries);
    const next = queueOne(
      stateWith(
        big("dwfrun-old-1", "completed"),
        big("dwfrun-old-2", "stopped"),
        big("dwfrun-live", "running"),
        big(RUN_ID, "running"),
      ),
    );
    // 只淘汰一条：老二虽然也是终态，但淘汰老大之后已经回到预算内。
    expect(next.runs.map((run) => run.runId)).toEqual(["dwfrun-old-2", "dwfrun-live", RUN_ID]);
  });

  it("绝不淘汰在跑的 run，也绝不淘汰事件所属的那条 run", () => {
    const next = queueOne(
      stateWith(
        big("dwfrun-live-1", "running"),
        big("dwfrun-live-2", "pending"),
        big("dwfrun-live-3", "running"),
        big(RUN_ID, "completed"),
      ),
    );
    // 唯一的终态 run 正是事件所属的那条 → 无人可淘汰，超预算也照留（诚实优先于省字节）。
    expect(next.runs.map((run) => run.runId)).toEqual([
      "dwfrun-live-1",
      "dwfrun-live-2",
      "dwfrun-live-3",
      RUN_ID,
    ]);
  });

  it("预算之内不动任何东西：run 对象保持引用（增量的快路径靠它）", () => {
    const state = stateWith(
      runWith({ runId: "dwfrun-old", status: "completed" }, 10),
      runWith({}, 10),
    );
    const next = queueOne(state);
    expect(next.runs).toHaveLength(2);
    expect(next.runs[0]).toBe(state.runs[0]);
  });

  it("预算淘汰在增量上说得出口：一条 workflowRun.removed，往返逐字节一致", () => {
    const state = stateWith(
      big("dwfrun-old-1", "completed"),
      big("dwfrun-old-2", "completed"),
      big("dwfrun-live", "running"),
      big(RUN_ID, "running"),
    );
    const next = queueOne(state);
    expect(next.runs.map((run) => run.runId)).toEqual(["dwfrun-old-2", "dwfrun-live", RUN_ID]);
    const deltas = diffWorkflowRunsState(state, next);
    expect(deltas[0]).toEqual({
      op: "workflowRun.removed",
      runId: "dwfrun-old-1",
      revision: next.revision,
    });
    const applied = applyConversationDeltas(snapshotWith(state), deltas);
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(next));
  });
});

describe("clampWorkflowRunsForLegacy：没有增量能力的消费者", () => {
  // 旧消费者编译进去的是 .max(256)：超界的帧会让**整个 state.updated patch** 解析失败、整帧被丢，
  // 于是那条订阅从此静默。这个裁剪是生产侧的第二道闸，「前 256 条」正是旧归约（拒新）的产物。
  const legacyStateSchema = z.object({
    revision: z.number().int().nonnegative(),
    runs: z
      .array(
        workflowRunSchema.extend({
          actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors),
          nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes),
        }),
      )
      .max(WORKFLOW_RUNS_LIMITS.maxRuns),
  });

  it("每条 run 各裁到前 256，并置 truncated", () => {
    const state = stateWith(runWith({ runId: "dwfrun-wide" }, 900, 700));
    const clamped = clampWorkflowRunsForLegacy(state);
    expect(clamped.runs[0]?.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    expect(clamped.runs[0]?.actors).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors);
    expect(clamped.runs[0]?.truncated).toBe(true);
    // 夹具里的条目全是终态，没有要先保的 → 留下的正是最早的那些实例。
    expect(clamped.runs[0]?.nodes[0]?.ordinal).toBe(0);
    expect(clamped.runs[0]?.nodes.at(-1)?.ordinal).toBe(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes - 1);
    expect(legacyStateSchema.safeParse(clamped).success).toBe(true);
  });

  // 裁剪保留的是**还在动的那些**：旧手机收到的是整键快照，而它要画的和新客户端一样是
  // 「此刻谁在跑」。一刀切前 256 条会让一个宽 run 在旧客户端上永远停在最早那批已结束的身上。
  it("还在动的先留：未结算的 node 与状态不是 completed 的 actor 不会被裁掉", () => {
    const live = (ordinal: number, phase: WorkflowRunNode["phase"]) => ({
      siteId: "ask#1",
      ordinal,
      phase,
    });
    const nodes: WorkflowRunNode[] = [
      ...Array.from({ length: 300 }, (_, index) => live(index, "settled")),
      live(300, "executing"),
      live(301, "queued"),
    ];
    const actors = [
      ...Array.from({ length: 300 }, (_, index) => ({
        siteId: "actor#1",
        ordinal: index,
        status: "completed" as const,
      })),
      { siteId: "actor#1", ordinal: 300, status: "running" as const },
    ];
    const clamped = clampWorkflowRunsForLegacy(stateWith(runWith({ nodes, actors }, 0, 0)));
    const keptNodes = clamped.runs[0]!.nodes;
    expect(keptNodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    expect(keptNodes.map((node) => node.ordinal)).toContain(300);
    expect(keptNodes.map((node) => node.ordinal)).toContain(301);
    // 输出仍按原表序：留下的两条活节点在最后，剩下的名额按表序补最早的条目。
    expect(keptNodes.map((node) => node.ordinal)).toEqual([
      ...Array.from({ length: WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes - 2 }, (_, index) => index),
      300,
      301,
    ]);
    expect(clamped.runs[0]!.actors.map((actor) => actor.ordinal)).toContain(300);
    expect(legacyStateSchema.safeParse(clamped).success).toBe(true);
  });

  it("活条目多过旧界时按表序取前 256 条活的（仍然有界）", () => {
    const nodes: WorkflowRunNode[] = Array.from({ length: 400 }, (_, index) => ({
      siteId: "ask#1",
      ordinal: index,
      phase: "executing" as const,
    }));
    const clamped = clampWorkflowRunsForLegacy(stateWith(runWith({ nodes }, 0, 0)));
    expect(clamped.runs[0]!.nodes.map((node) => node.ordinal)).toEqual(
      Array.from({ length: WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes }, (_, index) => index),
    );
  });

  it("没什么可裁时返回**同一个对象**（每次 flush 都要跑一遍，身份不能白丢）", () => {
    const state = stateWith(runWith({}, 10, 10), runWith({ runId: "dwfrun-2" }, 0, 0));
    expect(clampWorkflowRunsForLegacy(state)).toBe(state);
  });

  it("只裁该裁的那条 run，其余保持引用", () => {
    const narrow = runWith({ runId: "dwfrun-narrow" }, 5, 5);
    const state = stateWith(narrow, runWith({ runId: "dwfrun-wide" }, 400, 0));
    const clamped = clampWorkflowRunsForLegacy(state);
    expect(clamped).not.toBe(state);
    expect(clamped.runs[0]).toBe(narrow);
    expect(clamped.runs[1]?.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
  });

  it("裁剪产物始终过旧界 schema：满界的 8 条 run 也一样", () => {
    const state: WorkflowRunsState = {
      revision: 3,
      runs: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns }, (_, index) =>
        runWith({ runId: `dwfrun-${index}` }, WORKFLOW_RUNS_LIMITS.maxNodes, 300),
      ),
    };
    const clamped = clampWorkflowRunsForLegacy(state);
    expect(legacyStateSchema.safeParse(clamped).success).toBe(true);
    // 新界的 schema 当然也过——裁剪只减不增。
    expect(workflowRunsStateSchema.safeParse(clamped).success).toBe(true);
  });
});

/** 只装 apply 会碰到的两处（与 …WorkflowRunsDelta.test.ts 同一个理由）。 */
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
