// 表满时的**腾位**：淘汰已经跑完的，好让正在跑的那些一直在表里。
//
// 这条规则要守的事实很短：读面（run 卡的子代理行、run 面板的站点花名册）画的是**此刻在跑的**
// 子代理，而触界的老语义是拒新——于是一个宽 fan-out 的 run 跑到 1024 之后，新起的子代理一个都
// 进不来，面板永远停在最早那批已经结束的身上。淘汰把这件事反过来：终态的条目让位，活着的进来。
//
// 淘汰因此必须同时满足四件事，本文件逐条钉住：
//   - 淘汰只发生在**活的新人**撞上满表时，且事件抬过水位（重放永不淘汰）；
//   - 受害者是已结算的游离节点或已完成的组，是 run 状态的纯函数（冷回放淘汰出同一个集合）；
//   - 一个 actor 绝不比它最后一个已列节点活得久（否则它会变成一枚永远 pending 的徽章）；
//   - 被淘汰的条目**仍然可数**：run 级两个计数器 + 每个出生阶段一格。
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  coalesceConversationDeltas,
  conversationDeltaSchema,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workflowRunStepCounts,
  workflowRunsStateSchema,
  type ConversationDelta,
  type ConversationSnapshot,
  type WorkflowRunEntryLimits,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/**
 * 测试用的小界。界必须可注入而不是改常量：1024 条要三千多条事件才撞得到，每步再做一次
 * 往返断言就是分钟级的跑时，而被测的规则与界的**大小**无关。
 */
const LIMITS: WorkflowRunEntryLimits = { maxActors: 3, maxNodes: 3, maxPhases: 2 };

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

/** 一条 run 的事件驱动器：sequence 按调用序自增，state 就地推进，重放用原信封再喂一次。 */
function driver(limits: WorkflowRunEntryLimits = LIMITS, runId = RUN_ID) {
  let sequence = -1;
  let state: WorkflowRunsState | undefined;
  return {
    send(
      eventType: string,
      payload: Record<string, unknown> = {},
      extra: Partial<WorkflowRunProgressEnvelope> = {},
    ): WorkflowRunProgressEnvelope {
      sequence += 1;
      const envelope: WorkflowRunProgressEnvelope = {
        runId,
        toolCallId: "tc-1",
        sequence,
        eventType,
        payload,
        ...extra,
      };
      state = reduceWorkflowRunsState(state, envelope, limits) ?? state;
      return envelope;
    },
    /** 重放一条已发过的信封：返回归约结果（null = 逐字节无变化）。 */
    replay(envelope: WorkflowRunProgressEnvelope): WorkflowRunsState | null {
      return reduceWorkflowRunsState(state, envelope, limits);
    },
    get run(): WorkflowRunState {
      return state!.runs[0]!;
    },
    get state(): WorkflowRunsState {
      return state!;
    },
  };
}

const actorRef = (index: number) => ({ siteId: `actor#${index}`, ordinal: 1 });
const askRef = (index: number) => ({ siteId: `ask#${index}`, ordinal: 1 });
const worldRef = (index: number) => ({ siteId: `world#${index}`, ordinal: 1 });

const nodeKeys = (run: WorkflowRunState) => run.nodes.map((node) => node.siteId);
const actorKeys = (run: WorkflowRunState) => run.actors.map((actor) => actor.siteId);

/** 一个子代理跑完一次 ask：建 actor、派一次活、结算。`outcome` 决定这个组算不算失败。 */
function runOneAsk(
  driven: ReturnType<typeof driver>,
  index: number,
  options: { outcome?: "ok" | "failed" | "cancelled"; phaseName?: string; settle?: boolean } = {},
): void {
  const phase = options.phaseName === undefined ? {} : { phaseName: options.phaseName };
  driven.send("actor-created", { actor: actorRef(index), name: `a${index}`, ...phase });
  driven.send("node-queued", {
    instance: askRef(index),
    kind: "ask",
    actor: actorRef(index),
    ...phase,
  });
  driven.send("node-dispatched", { instance: askRef(index) });
  driven.send("node-executing", { instance: askRef(index) });
  if (options.settle === false) return;
  driven.send("node-settled", { instance: askRef(index), outcome: options.outcome ?? "ok" });
}

/**
 * 带**出生事实**的 `node-dispatched`（引擎侧的 Part A）：派发时把这条实例的 `node-queued` 与它
 * 子代理的 `actor-created` 携带过的同一份事实原样重发一遍，于是归约可以在「被派活的那一刻」
 * 把表外的实例与它的子代理放回表上。
 */
function dispatchWithFacts(
  driven: ReturnType<typeof driver>,
  index: number,
  options: {
    phaseName?: string;
    instructionsHead?: string;
    instance?: { siteId: string; ordinal: number };
  } = {},
): WorkflowRunProgressEnvelope {
  return driven.send(
    "node-dispatched",
    {
      instance: options.instance ?? askRef(index),
      kind: "ask",
      actor: actorRef(index),
      actorName: `a${index}`,
      ...(options.phaseName === undefined
        ? {}
        : { actorPhaseName: options.phaseName, phaseName: options.phaseName }),
      ...(options.instructionsHead === undefined
        ? {}
        : { instructionsHead: options.instructionsHead }),
    },
    { actorSessionId: `sess-${index}` },
  );
}

describe("2.1 什么时候淘汰", () => {
  it("actor 表满 + 活的新人：淘汰一个已完成组，新人入座", () => {
    const driven = driver({ maxActors: 3, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2);
    runOneAsk(driven, 3, { settle: false });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);

    driven.send("actor-created", { actor: actorRef(4), name: "a4" });
    // 两个已完成组，同阶段、同类，取表内最靠前的那个。
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3", "actor#4"]);
    // 组是 actor + 它名下全部已列节点，一起走。
    expect(nodeKeys(driven.run)).toEqual(["ask#2", "ask#3"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    expect(driven.run.truncated).toBe(true);
  });

  it("node 表满 + 活的新人：先淘汰已结算的游离节点（world-read 不是任何人的组）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    driven.send("node-settled", { instance: worldRef(1), outcome: "ok" });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    expect(nodeKeys(driven.run)).toEqual(["world#1", "ask#1", "ask#2"]);

    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(2) });
    // 游离节点先走：淘汰它只少一行，淘汰一个组会连着摘掉一个 actor。
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#3"]);
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    // 淘汰照样置 truncated：这条 run 的表已经装不下它自己的事实，而 run-started 正是按这一位
    // 决定新一世要不要从空表重开。
    expect(driven.run.truncated).toBe(true);
  });

  it("没有游离节点时淘汰一个已完成组（actor 与它的节点一起走）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("node-queued", { instance: askRef(9), kind: "ask", actor: actorRef(2) });
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#9"]);

    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(3) });
    expect(nodeKeys(driven.run)).toEqual(["ask#2", "ask#9", "ask#3"]);
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3"]);
  });

  it("重放的事件永不淘汰：水位没抬过，表照旧拒新", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    const queued = driven.send("node-queued", {
      instance: askRef(9),
      kind: "ask",
      actor: actorRef(2),
    });
    const before = driven.run;
    // 同一条信封再喂一次：表里已有这条实例 → 逐字节无变化。
    expect(driven.replay(queued)).toBeNull();
    expect(driven.run).toBe(before);
  });

  it("缓存命中的 node-settled 出生即结算，永不淘汰：它被拒，只进计数", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("node-queued", { instance: askRef(9), kind: "ask", actor: actorRef(2) });
    const before = nodeKeys(driven.run);

    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    driven.send("node-settled", {
      instance: askRef(3),
      actor: actorRef(3),
      outcome: "ok",
      cached: true,
    });
    // 已完成组还在表里（ask#1），但出生即结算的实例没有资格把它挤走。
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("一个可淘汰的受害者都没有时，照旧拒新并置 truncated", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    runOneAsk(driven, 2, { settle: false });
    const before = nodeKeys(driven.run);

    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(1) });
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.truncated).toBe(true);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1 });
    expect(driven.run.usage.nodesUnlistedSettled).toBeUndefined();
  });
});

describe("2.2 受害者顺序", () => {
  it("未失败的先走：失败是读者唯一还想找回来的已结算事实", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { outcome: "failed" });
    runOneAsk(driven, 2, { outcome: "ok" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    // actor#1 在表里更靠前，但它失败了，让位的是没失败的 actor#2。
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1"]);
  });

  it("cancelled 与 failed 同类：都算这个组失败了", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { outcome: "cancelled" });
    runOneAsk(driven, 2, { outcome: "ok" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3"]);
  });

  it("取候选最多的那个阶段：界花在条目拥挤的地方", () => {
    const driven = driver({ maxActors: 3, maxNodes: 8, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    runOneAsk(driven, 3, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(4), name: "a4", phaseName: "p3" });
    // p1 只有一个候选、p2 有两个：受害者出在 p2，取它里面表内最靠前的 actor#2。
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3", "actor#4"]);
  });

  it("组的阶段是它 actor 的出生阶段（节点的戳不参与）", () => {
    const driven = driver({ maxActors: 3, maxNodes: 8, maxPhases: 4 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1", phaseName: "p1" });
    driven.send("node-queued", {
      instance: askRef(1),
      kind: "ask",
      actor: actorRef(1),
      phaseName: "p2",
    });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    runOneAsk(driven, 3, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(4), name: "a4" });
    // actor#1 的节点戳着 p2，但它自己出生在 p1 —— p2 仍然只有 actor#2 / actor#3 两个候选。
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3", "actor#4"]);
  });

  it("新节点自己那个 actor 的组绝不当受害者（否则它会变成一条没有徽章的活节点）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    // actor#1 连做两次 ask，都结算了；actor#2 也做完一次。
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(2), outcome: "ok" });
    runOneAsk(driven, 3);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#3"]);

    // actor#1 的第三次 ask 撞上满表：它自己那个「已完成」组正要重新开工，不能拿它顶账。
    driven.send("node-queued", { instance: askRef(4), kind: "ask", actor: actorRef(1) });
    expect(actorKeys(driven.run)).toContain("actor#1");
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#4"]);
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);
  });

  it("未结算的节点与带着未结算节点的 actor 永远不是受害者", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    // actor#1 有两次 ask，一次结算一次在跑 → 整个组都不算完成。
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(1) });
    driven.send("node-executing", { instance: askRef(2) });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    const before = nodeKeys(driven.run);

    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(1) });
    // 游离节点还没结算，组也没完成 → 没有受害者，照旧拒新。
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.truncated).toBe(true);
  });
});

describe("2.3 孤儿规则", () => {
  it("出生即结算的节点被拒时，名下一个已列节点都没有的 actor 一起摘掉", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3", phaseName: "p1" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);

    driven.send("node-settled", {
      instance: askRef(3),
      actor: actorRef(3),
      outcome: "ok",
      cached: true,
      phaseName: "p1",
    });
    // 带不进自己那条节点的已完成子代理不上表：留着它就是一枚永远不会动的 pending 徽章。
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 1, actorsSettled: 1, settled: 1 },
    ]);
  });

  it("actor 还有别的已列节点时不摘（它不是孤儿）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    driven.send("node-executing", { instance: askRef(2) });

    driven.send("node-settled", {
      instance: askRef(9),
      actor: actorRef(2),
      outcome: "ok",
      cached: true,
    });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
  });

  it("失败的孤儿进 actorsFailed", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3", phaseName: "p1" });
    driven.send("node-settled", {
      instance: askRef(3),
      actor: actorRef(3),
      outcome: "failed",
      cached: true,
      phaseName: "p1",
    });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);
  });
});

describe("2.4 计数", () => {
  it("被淘汰的节点进 run 级两个计数器，步数读法照旧算得对", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    // 表内 1 条（ask#2，未结算）+ 表外 1 条（已结算）。
    expect(workflowRunStepCounts(driven.run)).toEqual({ total: 2, settled: 1 });
  });

  it("unlistedByPhase 按**出生阶段**分格，失败的另计一格子键", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1", outcome: "failed" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    // 未失败的先走：p2 让位。
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
    ]);
    // 再来一个新人 → 只剩失败的那个组可淘汰。
    driven.send("actor-created", { actor: actorRef(4), name: "a4" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 2, nodesUnlistedSettled: 2 });
  });

  it("没有阶段戳的实例进**无阶段**那一格", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    // 无阶段那一格的键就是**缺席的 phaseName**，不是空串（站点侧「没有 phase() 标记」同一个键）。
    expect(driven.run.unlistedByPhase).toEqual([{ actors: 1, actorsSettled: 1, settled: 1 }]);
  });

  it("阶段格满了丢归属，run 级计数照旧准", () => {
    // maxPhases = 1 → 格子表最多 2 条（一条无阶段 + 一条有名字的）。
    const driven = driver({ maxActors: 2, maxNodes: 8, maxPhases: 1 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    runOneAsk(driven, 4, { phaseName: "p3" });
    driven.send("actor-created", { actor: actorRef(5), name: "a5" });
    driven.send("actor-created", { actor: actorRef(6), name: "a6" });
    const buckets = driven.run.unlistedByPhase!;
    expect(buckets).toHaveLength(2);
    // 三个阶段被淘汰过，但格子表只装得下两条 —— 第三条的归属丢掉，总数不丢。
    const attributed = buckets.reduce((sum, bucket) => sum + bucket.settled, 0);
    expect(attributed).toBeLessThan(driven.run.usage.nodesUnlistedSettled!);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 3, nodesUnlistedSettled: 3 });
  });

  it("一条都没被拒 / 淘汰过的 run 一个新键都不多", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    expect(driven.run).not.toHaveProperty("unlistedByPhase");
    expect(driven.run.usage).not.toHaveProperty("nodesUnlisted");
    expect(driven.run).not.toHaveProperty("truncated");
  });

  it("产出始终过 schema（unlistedByPhase 是协议线上的键）", () => {
    const driven = driver({ maxActors: 2, maxNodes: 4, maxPhases: 2 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p2", outcome: "failed" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(workflowRunsStateSchema.safeParse(driven.state).success).toBe(true);
  });
});

describe("2.5 resume：溢出过的 run 从空表重开", () => {
  it("truncated 的 run 在 run-started 后清空两张表并摘掉 unlistedByPhase", () => {
    const driven = driver({ maxActors: 2, maxNodes: 4, maxPhases: 2 });
    driven.send("run-started", {});
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p1", settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.truncated).toBe(true);
    expect(driven.run.unlistedByPhase).toBeDefined();

    driven.send("run-started", {});
    expect(driven.run.actors).toEqual([]);
    expect(driven.run.nodes).toEqual([]);
    expect(driven.run).not.toHaveProperty("unlistedByPhase");
    expect(driven.run.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
  });

  it("没溢出过的 run 照旧留着两张表（普通 resume 的历史不该被抹掉）", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    driven.send("run-started", {});
    runOneAsk(driven, 1);
    const actors = driven.run.actors;
    const nodes = driven.run.nodes;
    driven.send("run-started", {});
    expect(driven.run.actors).toBe(actors);
    expect(driven.run.nodes).toBe(nodes);
  });

  it("两世之后总数不翻倍：新一世每条实例只被列或只被计一次", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("run-started", {});
    runOneAsk(driven, 1);
    runOneAsk(driven, 2);
    runOneAsk(driven, 3, { settle: false });
    const firstLife = workflowRunStepCounts(driven.run);
    expect(firstLife.total).toBe(3);

    // 第二世：引擎把整段前缀重发一遍（已完成的走缓存命中的 settle，没完的重新 queue）。
    driven.send("run-started", {});
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("node-settled", {
      instance: askRef(1),
      actor: actorRef(1),
      outcome: "ok",
      cached: true,
    });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-settled", {
      instance: askRef(2),
      actor: actorRef(2),
      outcome: "ok",
      cached: true,
    });
    runOneAsk(driven, 3, { settle: false });
    // 三条实例，一条都不多：表内 + 表外恰好是这一世出生过的实例数。
    expect(workflowRunStepCounts(driven.run).total).toBe(3);
    expect(workflowRunStepCounts(driven.run).settled).toBe(2);
  });
});

describe("B2 溢出之后，认不出主人的 queued 不上表", () => {
  it("truncated 的 run 里 actor 不在表上的 node-queued 被拒——哪怕节点表还空着", () => {
    const driven = driver({ maxActors: 1, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    expect(driven.run.truncated).toBe(true);
    const before = nodeKeys(driven.run);

    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    // 节点表还有五个位子，但这条节点画不出徽章（pill 按 run.actors 过滤），列上去只是白占一个
    // 位子，而后面被派下去的活正需要它。
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1 });
  });

  it("游离节点不受这条规则约束（world-read 本来就没有主人）", () => {
    const driven = driver({ maxActors: 1, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    expect(nodeKeys(driven.run)).toContain("world#1");
  });

  it("界之下照旧：没溢出过的 run 里这条 queued 正常上表", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    expect(nodeKeys(driven.run)).toEqual(["ask#2"]);
    expect(driven.run).not.toHaveProperty("truncated");
  });
});

describe("B3 派发即入座", () => {
  /** 事故形状：先把全部 actor 建好、再把全部活入队，然后 FIFO 派活。 */
  function incident(driven: ReturnType<typeof driver>, agents: number): void {
    for (let index = 1; index <= agents; index += 1) {
      driven.send(
        "actor-created",
        { actor: actorRef(index), name: `a${index}`, phaseName: "p1" },
        { actorSessionId: `sess-${index}` },
      );
    }
    for (let index = 1; index <= agents; index += 1) {
      driven.send("node-queued", {
        instance: askRef(index),
        kind: "ask",
        actor: actorRef(index),
        phaseName: "p1",
        instructionsHead: `do ${index}`,
      });
    }
  }

  it("被拒的子代理在**被派活的那一刻**连人带活回到表上", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    incident(driven, 3);
    // 出生的那一刻一个终态条目都没有：前两个占满，第三个连人带活都被拒。
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1 });

    dispatchWithFacts(driven, 1, { phaseName: "p1", instructionsHead: "do 1" });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    dispatchWithFacts(driven, 2, { phaseName: "p1", instructionsHead: "do 2" });
    driven.send("node-settled", { instance: askRef(2), outcome: "ok" });

    dispatchWithFacts(driven, 3, { phaseName: "p1", instructionsHead: "do 3" });
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3"]);
    expect(driven.run.actors.at(-1)).toEqual({
      siteId: "actor#3",
      ordinal: 1,
      name: "a3",
      sessionId: "sess-3",
      status: "waiting",
      phaseName: "p1",
    });
    expect(driven.run.nodes.at(-1)).toMatchObject({
      siteId: "ask#3",
      kind: "ask",
      phase: "dispatched",
      actorSiteId: "actor#3",
      actorOrdinal: 1,
      phaseName: "p1",
      instructionsHead: "do 3",
    });
    // 三条实例，一条不多：表内两条 + 表外一条（被淘汰的 ask#1）。
    expect(workflowRunStepCounts(driven.run)).toEqual({ total: 3, settled: 2 });
  });

  it("只缺 actor 位时已完成组先于空闲组让位", () => {
    const driven = driver({ maxActors: 3, maxNodes: 4, maxPhases: 2 });
    incident(driven, 4);
    dispatchWithFacts(driven, 1, { phaseName: "p1", instructionsHead: "do 1" });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });

    dispatchWithFacts(driven, 4, { phaseName: "p1", instructionsHead: "do 4" });
    // actor#1 已完成、actor#2 / actor#3 只排着队 —— 让位的是已完成的那个。
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3", "actor#4"]);
  });

  it("只剩空闲组时让位的是**表内最靠后**的那个（FIFO 下它最后才轮到）", () => {
    const driven = driver({ maxActors: 3, maxNodes: 6, maxPhases: 2 });
    incident(driven, 4);
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);

    dispatchWithFacts(driven, 4, { phaseName: "p1", instructionsHead: "do 4" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#4"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#4"]);
    // 让位的是一条**排队中**的节点：它进 nodesUnlisted，但一条都没结算。
    expect(driven.run.usage.nodesUnlisted).toBe(1);
    expect(driven.run.usage.nodesUnlistedSettled).toBeUndefined();
  });

  it("只缺节点位时先淘汰已结算的游离节点", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    // world#1 还没结算 → 一个受害者都没有，ask#2 被拒。
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    expect(nodeKeys(driven.run)).toEqual(["world#1", "ask#1"]);
    driven.send("node-settled", { instance: worldRef(1), outcome: "ok" });

    dispatchWithFacts(driven, 2);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("只缺节点位时，先丢自己名下最老的那条已结算节点（actor 留着，徽章就留着）", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    // actor#1 的第二次 ask 撞上满表：出生这一刻挤不动任何人（自己那个组不顶账，别人那个
    // 还排着队）→ 被拒。
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);

    dispatchWithFacts(driven, 1, { instance: second });
    // 让位的是**自己**那条已结算的节点：actor#1 还在表上（徽章不动），而别人那个空闲组
    // 一行都没少——一个子代理在拿走别人的位子之前先交出自己的历史。
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(driven.run.nodes.map((node) => `${node.siteId}#${node.ordinal}`)).toEqual([
      "ask#2#1",
      "ask#1#2",
    ]);
    // 记账与淘汰一条游离节点同规：两个计数器各加一，格子表只加节点那一格。
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    expect(driven.run.unlistedByPhase).toEqual([{ actors: 0, settled: 1 }]);
  });

  it("自己那个**组**仍然绝不当受害者：没有自己的已结算节点可丢时才动别人", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    // actor#1 名下只有一条**排队中**的节点：它不是可丢的历史。
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });

    dispatchWithFacts(driven, 1, { instance: second });
    // 动的是别人那个空闲组，actor#1 连人带两条活都留着。
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);
    expect(driven.run.nodes.map((node) => `${node.siteId}#${node.ordinal}`)).toEqual([
      "ask#1#1",
      "ask#1#2",
    ]);
  });

  it("在跑的组永远不是受害者：腾不出位就照旧拒新", () => {
    const driven = driver({ maxActors: 1, maxNodes: 1, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    const before = driven.run.usage.nodesUnlisted;

    dispatchWithFacts(driven, 2);
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1"]);
    expect(driven.run.usage.nodesUnlisted).toBe(before);
  });

  it("最后一档：一张全是零节点 actor 的表也腾得出位（resume 的形状）", () => {
    const driven = driver({ maxActors: 3, maxNodes: 2, maxPhases: 2 });
    // 先让这条 run 溢出过（truncated）：零节点这一档只在溢出之后、且只在 activation 时生效。
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read", phaseName: "p1" });
    driven.send("node-queued", { instance: worldRef(2), kind: "world-read", phaseName: "p1" });
    driven.send("node-queued", { instance: worldRef(3), kind: "world-read", phaseName: "p1" });
    expect(driven.run.truncated).toBe(true);
    driven.send("node-settled", { instance: worldRef(1), outcome: "ok" });

    // resume 的形状：actor 重新建出来，而命中完结缓存的结算**不带 actor**（引擎的 node-settled
    // 没有这个字段），于是这些子代理名下一条已列节点都没有——三档老规则里它们谁都不是。
    for (const index of [1, 2, 3]) {
      driven.send(
        "actor-created",
        { actor: actorRef(index), name: `a${index}`, phaseName: "p1" },
        { actorSessionId: `sess-${index}` },
      );
    }
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);
    for (const actor of driven.run.actors) expect(nodesOfActor(driven.run, actor)).toEqual([]);

    // 第四个子代理出生时被拒（表满、一个已完成组都没有）：先记一格。
    driven.send(
      "actor-created",
      { actor: actorRef(4), name: "a4", phaseName: "p1" },
      { actorSessionId: "sess-4" },
    );
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p1", actors: 1, settled: 0 }]);

    // 它被派活：表满、一个组都没有，让位的是**表内最靠后**的零节点 actor。
    dispatchWithFacts(driven, 4, { phaseName: "p1", instructionsHead: "do 4" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#4"]);
    expect(driven.run.nodes.at(-1)).toMatchObject({
      siteId: "ask#4",
      phase: "dispatched",
      actorSiteId: "actor#4",
    });
    // 零节点 actor 离场只记 actors：它的结局这一格并不知道（没结算过，也可能只是还没被问）。
    // 一进一出之后这一格仍是 1，而那 1 正是让了位的 actor#3；同一格上的 settled 来自那条让出
    // 节点位的游离节点。
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p1", actors: 1, settled: 1 }]);

    // 而它自己下一次被派活时照样回得来——这正是这一档安全的理由。
    driven.send("node-settled", { instance: askRef(4), outcome: "ok" });
    dispatchWithFacts(driven, 3, { phaseName: "p1", instructionsHead: "do 3" });
    expect(actorKeys(driven.run)).toContain("actor#3");
  });

  it("不带事实的 dispatch 照老样子（旧 journal、world-read 的派发）", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    incident(driven, 3);
    driven.send("node-dispatched", { instance: askRef(3) });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);
  });

  it("重放的 dispatch 不入座：水位没抬过", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    incident(driven, 3);
    const stale: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: 0,
      eventType: "node-dispatched",
      payload: { instance: askRef(3), kind: "ask", actor: actorRef(3), actorName: "a3" },
      actorSessionId: "sess-3",
    };
    expect(driven.replay(stale)).toBeNull();
  });

  it("界之下不凭空造 actor：没溢出过的 run 照旧只落节点", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    dispatchWithFacts(driven, 1, { phaseName: "p1" });
    expect(driven.run.actors).toEqual([]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1"]);
  });

  it("两次 ask 之间被淘汰的子代理，在下一次派发时拿回自己的徽章", () => {
    const driven = driver({ maxActors: 2, maxNodes: 3, maxPhases: 2 });
    driven.send(
      "actor-created",
      { actor: actorRef(1), name: "a1", phaseName: "p1" },
      { actorSessionId: "sess-1" },
    );
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-dispatched", { instance: askRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    driven.send("node-dispatched", { instance: askRef(2) });
    // actor#3 出生 → 已完成组 actor#1 让位，它连着 ask#1 一起离场。
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(3) });
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3"]);

    // 脚本又给 actor#1 派了第二次活：queued 认不出主人被拒，派发时它连人带活回来。
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });
    dispatchWithFacts(driven, 1, { instance: second, phaseName: "p1" });
    expect(driven.run.actors.at(-1)).toEqual({
      siteId: "actor#1",
      ordinal: 1,
      name: "a1",
      sessionId: "sess-1",
      status: "waiting",
      phaseName: "p1",
    });
  });
});

describe("B4 表外的子代理也按出生阶段可数", () => {
  it("被拒的 actor-created 记一格 actors", () => {
    const driven = driver({ maxActors: 1, maxNodes: 4, maxPhases: 2 });
    runOneAsk(driven, 1, { phaseName: "p1", settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2", phaseName: "p2" });
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p2", actors: 1, settled: 0 }]);
  });

  it("已完成组让位：actors 与 actorsSettled 一起加，失败的再加一格", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1", outcome: "failed" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3", phaseName: "p3" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
    ]);
    driven.send("actor-created", { actor: actorRef(4), name: "a4", phaseName: "p3" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);
  });

  it("空闲组让位只加 actors；回表的子代理把自己那一格减回去，归零即摘格", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 4 });
    for (const index of [1, 2, 3]) {
      driven.send(
        "actor-created",
        { actor: actorRef(index), name: `a${index}`, phaseName: `p${index}` },
        { actorSessionId: `sess-${index}` },
      );
    }
    for (const index of [1, 2, 3]) {
      driven.send("node-queued", {
        instance: askRef(index),
        kind: "ask",
        actor: actorRef(index),
        phaseName: `p${index}`,
      });
    }
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p3", actors: 1, settled: 0 }]);

    dispatchWithFacts(driven, 3, { phaseName: "p3" });
    // 空闲组 actor#2 让位（只加 actors，它的活还没开始）；actor#3 回表，p3 那一格归零被摘掉。
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p2", actors: 1, settled: 0 }]);
    expect(driven.run.usage.nodesUnlistedSettled).toBeUndefined();
  });

  it("被拒的出生即结算节点：actor 不在表上时**只**记节点那一格", () => {
    const driven = driver({ maxActors: 1, maxNodes: 1, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1", settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2", phaseName: "p2" });
    driven.send("node-settled", {
      instance: askRef(2),
      actor: actorRef(2),
      outcome: "failed",
      cached: true,
      phaseName: "p2",
    });
    // 这条结算**不**记 actorsSettled：这个子代理已经作为 actors 计在**它自己**的出生阶段上，
    // 而节点的阶段戳未必是同一个；何况一个有两次缓存命中的子代理会因此被记两次「已结束」。
    // 它仍然是个未列出的子代理，读面把它算作 pending，直到它重新上表为止。
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p2", actors: 1, settled: 1 }]);
  });

  it("每一格恒满足 actorsFailed ≤ actorsSettled ≤ actors（夹取是这一格的法律）", () => {
    const driven = driver({ maxActors: 1, maxNodes: 2, maxPhases: 4 });
    // actor#1 跑完一次 ask（失败），随后被 actor#2 的出生挤走：p1 那一格记下「走了一个、
    // 已结束、而且是失败的」。
    runOneAsk(driven, 1, { phaseName: "p1", outcome: "failed" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2", phaseName: "p2" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);

    // actor#1 其实还有第二次 ask。它入队时认不出主人（B2 拒），派发时把 actor#2 那个空闲组
    // 挤掉、自己回表。
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });
    dispatchWithFacts(driven, 1, { phaseName: "p1", instance: second });
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);

    // 回表让 p1 的 actors 归零，而这一格认不出是谁回来的——夹取把 actorsSettled 与
    // actorsFailed 一并压回零，读面于是不会把一个正在跑的子代理算成已完成的。
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 0, settled: 1 },
      { phaseName: "p2", actors: 1, settled: 0 },
    ]);
    for (const bucket of driven.run.unlistedByPhase ?? []) {
      expect(bucket.actorsFailed ?? 0).toBeLessThanOrEqual(bucket.actorsSettled ?? 0);
      expect(bucket.actorsSettled ?? 0).toBeLessThanOrEqual(bucket.actors);
    }
  });
});

// ── 不变量 I1–I6：用生成的单世事件流驱动真归约 ─────────────────────────────

/** 确定性 PRNG：随机化的输入必须可复现，否则红一次就再也不红了。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface GeneratedStream {
  envelopes: WorkflowRunProgressEnvelope[];
  /** 本世出生过的实例键（node-queued，或出生即结算的 cached settle）。 */
  born: Set<string>;
  /** 本世结算过的实例键。 */
  settled: Set<string>;
}

/**
 * 一条**单世**事件流：若干阶段、每个子代理 1–3 次 ask、夹着 world-read、若干失败，
 * 外加几条**重放**（原信封再喂一次）。宽度刻意超过界：淘汰路径必须被走满。
 */
function generateLife(seed: number, agents: number): GeneratedStream {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const envelopes: WorkflowRunProgressEnvelope[] = [];
  const born = new Set<string>();
  const settled = new Set<string>();
  let sequence = -1;
  const emit = (eventType: string, payload: Record<string, unknown>) => {
    sequence += 1;
    const envelope: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence,
      eventType,
      payload,
    };
    envelopes.push(envelope);
    return envelope;
  };
  const phases = ["p1", "p2", "p3", "p4"];
  emit("run-started", {});
  for (let index = 1; index <= agents; index += 1) {
    const phaseName = pick(phases);
    if (random() < 0.2) emit("phase-entered", { name: phaseName, ordinal: 1 });
    if (random() < 0.25) {
      // 游离节点：world-read 不属于任何人的组。
      const world = worldRef(index);
      const worldKey = `${world.siteId}\u0000${world.ordinal}`;
      if (random() < 0.5) {
        emit("node-settled", { instance: world, outcome: "ok", cached: true, phaseName });
      } else {
        emit("node-queued", { instance: world, kind: "world-read", phaseName });
        emit("node-settled", { instance: world, outcome: "ok" });
      }
      born.add(worldKey);
      settled.add(worldKey);
    }
    emit("actor-created", { actor: actorRef(index), name: `a${index}`, phaseName });
    const asks = 1 + Math.floor(random() * 3);
    for (let ask = 0; ask < asks; ask += 1) {
      const instance = { siteId: `ask#${index}`, ordinal: ask };
      const key = `${instance.siteId}\u0000${instance.ordinal}`;
      if (random() < 0.2) {
        // resume 命中：出生即结算，不经 queued。
        emit("node-settled", {
          instance,
          actor: actorRef(index),
          outcome: "ok",
          cached: true,
          phaseName,
        });
        born.add(key);
        settled.add(key);
        continue;
      }
      const queued = emit("node-queued", {
        instance,
        kind: "ask",
        actor: actorRef(index),
        phaseName,
      });
      born.add(key);
      emit("node-dispatched", { instance });
      emit("node-executing", { instance });
      // 几条重放：原信封原样再来一次，归约必须当它不存在。
      if (random() < 0.15) envelopes.push(queued);
      if (random() < 0.85) {
        emit("node-settled", { instance, outcome: pick(["ok", "ok", "failed", "cancelled"]) });
        settled.add(key);
      }
    }
  }
  return { envelopes, born, settled };
}

const entryKey = (entry: { siteId: string; ordinal: number }) =>
  `${entry.siteId}\u0000${entry.ordinal}`;
const nodeKeySet = (run: WorkflowRunState) => new Set(run.nodes.map(entryKey));
const actorKeySet = (run: WorkflowRunState) => new Set(run.actors.map(entryKey));
const nodesOfActor = (run: WorkflowRunState, actor: { siteId: string; ordinal: number }) =>
  run.nodes.filter(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );

/** 归约走过的每一步：施加这一步增量之前的状态，以及这一步产出的增量。 */
interface ReducedStep {
  prior: WorkflowRunsState | undefined;
  deltas: ConversationDelta[];
}

/**
 * coalesce 契约：任取若干窗口，合并后施加与逐条施加逐字节一致。
 *
 * 第二组界（`tight`）把规则 6 的**拒绝合并**那一支逼出来：真界 1024 下它要几千条事件才走得到，
 * 而它恰好是「合并等于顺序施加」最容易破的地方——被拒之后窗口里留下不止一条同 run 的 op，
 * 后来的 op 必须并进**最后**那条，否则它的 upsert 会跳到中间那条的删除之前。
 */
function expectCoalesceEquivalence(steps: readonly ReducedStep[], seed: number): void {
  const random = rng(seed + 99);
  const tight = { maxActors: 1, maxNodes: 1 };
  let declined = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const from = Math.floor(random() * steps.length);
    const to = Math.min(steps.length, from + 1 + Math.floor(random() * 20));
    const window = steps.slice(from, to).flatMap((step) => step.deltas);
    const base = snapshotWith(steps[from]!.prior);
    const direct = applyConversationDeltas(base, window);
    for (const bounds of [undefined, tight]) {
      const merged = coalesceConversationDeltas(window, bounds);
      expect(JSON.stringify(applyConversationDeltas(base, merged).workflowRuns)).toBe(
        JSON.stringify(direct.workflowRuns),
      );
      if (bounds !== undefined && merged.length > 1) declined += 1;
    }
  }
  // 这条断言守的是上面那段注释：小界真的让合并被拒过，否则那一支从没被走到。
  expect(declined).toBeGreaterThan(0);
}

describe("不变量 I1–I6（生成的单世事件流）", () => {
  for (const seed of [1, 7, 42, 1_337]) {
    it(`seed ${seed}：界、淘汰对象、孤儿、总数、幂等、归属都成立`, () => {
      const limits: WorkflowRunEntryLimits = { maxActors: 5, maxNodes: 7, maxPhases: 3 };
      const { envelopes, born, settled } = generateLife(seed, 24);
      let state: WorkflowRunsState | undefined;
      const everListed = new Set<string>();
      const steps: ReducedStep[] = [];

      for (const envelope of envelopes) {
        const next = reduceWorkflowRunsState(state, envelope, limits);
        // I5（一半）：重放一条刚归约过的事件是彻底的 no-op。
        if (next !== null) {
          expect(reduceWorkflowRunsState(next, envelope, limits)).toBeNull();
        }
        if (next === null) continue;
        const prior = state;
        const run = next.runs[0]!;

        // I1：两张表都在界内。
        expect(run.actors.length).toBeLessThanOrEqual(limits.maxActors);
        expect(run.nodes.length).toBeLessThanOrEqual(limits.maxNodes);

        if (prior !== undefined) {
          const priorRun = prior.runs[0]!;
          const keptNodes = nodeKeySet(run);
          const keptActors = actorKeySet(run);
          // I2：走掉的节点一定已结算；走掉的 actor 名下一条未结算节点都没有。
          for (const node of priorRun.nodes) {
            if (keptNodes.has(entryKey(node))) continue;
            expect(node.phase).toBe("settled");
          }
          for (const actor of priorRun.actors) {
            if (keptActors.has(entryKey(actor))) continue;
            for (const node of nodesOfActor(priorRun, actor)) expect(node.phase).toBe("settled");
          }
        }

        // I3：列过节点的 actor 永远不会掉到零条节点。
        for (const actor of run.actors) {
          const key = entryKey(actor);
          if (nodesOfActor(run, actor).length > 0) {
            everListed.add(key);
            continue;
          }
          expect(everListed.has(key)).toBe(false);
        }

        // I6：归属之和不超过 run 级已结算计数，且每一格恒满足
        // actorsFailed ≤ actorsSettled ≤ actors。
        const attributed = (run.unlistedByPhase ?? []).reduce(
          (sum, bucket) => sum + bucket.settled,
          0,
        );
        expect(attributed).toBeLessThanOrEqual(run.usage.nodesUnlistedSettled ?? 0);
        for (const bucket of run.unlistedByPhase ?? []) {
          expect(bucket.actorsFailed ?? 0).toBeLessThanOrEqual(bucket.actorsSettled ?? 0);
          expect(bucket.actorsSettled ?? 0).toBeLessThanOrEqual(bucket.actors);
        }

        // diff 契约：增量施加到 prior 之后与 next 逐字节一致。
        const deltas = diffWorkflowRunsState(prior, next);
        expect(deltas.some((delta) => delta.op === "state.updated")).toBe(false);
        for (const delta of deltas) {
          expect(conversationDeltaSchema.safeParse(delta).success).toBe(true);
        }
        const applied = applyConversationDeltas(snapshotWith(prior), deltas);
        expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(next));
        expect(workflowRunsStateSchema.safeParse(next).success).toBe(true);
        steps.push({ prior, deltas });
        state = next;
      }

      const run = state!.runs[0]!;
      // I4：表内 + 表外 = 本世出生过的实例数；已结算同理。
      expect(run.nodes.length + (run.usage.nodesUnlisted ?? 0)).toBe(born.size);
      expect(workflowRunStepCounts(run)).toEqual({ total: born.size, settled: settled.size });

      // I5（另一半）：同一串事件冷回放一遍得到逐字节相同的状态。
      let replayed: WorkflowRunsState | undefined;
      for (const envelope of envelopes) {
        replayed = reduceWorkflowRunsState(replayed, envelope, limits) ?? replayed;
      }
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(state));

      expectCoalesceEquivalence(steps, seed);
    });
  }

  it("界之下的乱序投递一条都不丢：在线事件先开头、journal 前缀随后补齐", () => {
    // 这一条守的是收紧规则**不能**越界生效。归约照常施加水位之下的事件（它只拒绝把水位拉
    // 回去），而 CLI 的冷物化把 journal 重放与在线事件喂进同一个归约：真要是在线事件先给一条
    // run 开了头，它整段 journal 前缀就全落在水位之下。无差别按水位收紧会让这条 run 的卡片
    // 空着——那是界之下每一条普通 run 的退化，为的却是只有溢出之后才存在的问题。
    const limits: WorkflowRunEntryLimits = { maxActors: 64, maxNodes: 64, maxPhases: 8 };
    const { envelopes, born } = generateLife(11, 10);
    const reduceSeq = (stream: readonly WorkflowRunProgressEnvelope[]) => {
      let state: WorkflowRunsState | undefined;
      for (const envelope of stream)
        state = reduceWorkflowRunsState(state, envelope, limits) ?? state;
      return state!.runs[0]!;
    };
    const inOrder = reduceSeq(envelopes);
    // 最后一条先到，水位直接抬到最高；其余整段都在水位之下。
    const seeded = reduceSeq([envelopes.at(-1)!, ...envelopes]);
    expect(inOrder.nodes).toHaveLength(born.size);
    expect(new Set(seeded.nodes.map(entryKey))).toEqual(new Set(inOrder.nodes.map(entryKey)));
    expect(new Set(seeded.actors.map(entryKey))).toEqual(new Set(inOrder.actors.map(entryKey)));
    // 没撞过界 → 一条都没被拒、也没被淘汰。
    expect(seeded).not.toHaveProperty("truncated");
    expect(seeded.usage).not.toHaveProperty("nodesUnlisted");
  });

  it("真实的界（1024）下也照样跑：小界不是规则的前提", () => {
    const { envelopes } = generateLife(3, 12);
    let state: WorkflowRunsState | undefined;
    for (const envelope of envelopes) {
      state = reduceWorkflowRunsState(state, envelope) ?? state;
    }
    const run = state!.runs[0]!;
    // 没撞界 → 一条都没被淘汰，新键一个都不多。
    expect(run.actors.length).toBeLessThanOrEqual(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(run).not.toHaveProperty("unlistedByPhase");
    expect(run).not.toHaveProperty("truncated");
  });
});

// ── 不变量 I7 / I8：引擎形状的事件流 ───────────────────────────────────────
//
// 上面那个生成器把出生与结算**交织**在一起（建一个、跑一个、结算一个），于是表里永远有
// 一个刚跑完的组可以让位——2026-09-20 的事故（5 × 2000 个子代理、并发 13）正是它没能逮到的
// 那个形状：一个阶段在头几秒里把**全部** actor-created 与**全部** node-queued 发完，头 1024 条
// 还排着队就把两张表塞满，一条终态都没有，于是后面 976 个子代理连人带活全被拒；调度器随后
// 按 FIFO 派活，从第 1025 个开始，**每一个正在跑的子代理都不在表上**。
//
// 所以这个生成器照着引擎的形状来：先建全部 actor、再入队全部第一次 ask、然后在并发上限之内
// FIFO 派活，每条 node-dispatched 带着出生事实。一个子代理连做 1–3 次 ask，有失败的，
// world-read 夹在中间（它的派发不带事实），偶尔重放一条信封。

/** 生成流里的一个子代理：串行做 `asks` 次 ask，第 k+1 次要等第 k 次结算之后才入队。 */
interface EngineAgent {
  index: number;
  phaseName: string;
  asks: number;
  /** 已经开始过的次数，同时就是下一次 ask 的 ordinal。 */
  done: number;
}

/** 一条生成流的形状。并发上界与两张表界的**相对大小**决定 I7 的豁免用不用得上。 */
interface EngineShape {
  phases: number;
  agentsPerPhase: number;
  concurrency: number;
  /**
   * 一次 ask 命中完结缓存的概率（replay / amend-resume 的短路）：它不入队、不派发，直接发
   * 一条出生即结算的 `node-settled { cached: true }`。
   */
  cachedRate: number;
  /**
   * 缓存结算带不带出生事实。现在的引擎带（kind / actor / actorSeq / instructionsHead，导入命中
   * 另带前驱的 `sourceSessionId`，信封上补本 run 的 `actorSessionId`），它落成一条归属到子代理
   * 的节点；更早的 journal 不带，它落成一条游离节点。两种形状都要跑：老 run 冷回放的仍是后者。
   */
  cachedNamesActor: boolean;
  /**
   * 第一世跑到第 n 次结算就被掐断（用户 stop），然后 `run-started` 重开一世：溢出过的 run 从
   * 空表重来，重放的前缀把**全部** actor 重新建一遍、给做完的 ask 补一条不带 actor 的缓存结算、
   * 给没做完的重新入队，然后照旧 FIFO 派活。0 = 只跑一世。
   */
  interruptAfter: number;
  /** 每个子代理最多做几次 ask（1 = 一次就走完，于是「结算过」等于「彻底做完」）。 */
  maxAsks: number;
}

function generateEngineLife(seed: number, shape: EngineShape): WorkflowRunProgressEnvelope[] {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const envelopes: WorkflowRunProgressEnvelope[] = [];
  let sequence = -1;
  let worldNumber = 0;
  const emit = (
    eventType: string,
    payload: Record<string, unknown>,
    extra: Partial<WorkflowRunProgressEnvelope> = {},
  ): WorkflowRunProgressEnvelope => {
    sequence += 1;
    const envelope: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence,
      eventType,
      payload,
      ...extra,
    };
    envelopes.push(envelope);
    return envelope;
  };
  /** 偶尔把一条刚发过的信封原样再喂一次：归约必须当它不存在。 */
  const maybeReplay = (envelope: WorkflowRunProgressEnvelope): void => {
    if (random() < 0.12) envelopes.push(envelope);
  };
  const askInstance = (agent: EngineAgent) => ({
    siteId: `ask#${agent.index}`,
    ordinal: agent.done,
  });
  const instructionsHead = (agent: EngineAgent) => `task ${agent.index}.${agent.done}`;
  /**
   * 缓存命中的结算（scheduler.ts 的 tryImportedSettle / settleCachedAsk）。`imported` 只在第一世
   * 的命中上为真：那是修订 run 的导入命中，答案读自前驱的会话；第二世的前缀是本 run 自己的重放。
   */
  const settleCached = (agent: EngineAgent, phaseName: string, imported: boolean): void => {
    const facts = shape.cachedNamesActor
      ? {
          kind: "ask",
          actor: actorRef(agent.index),
          actorSeq: agent.done,
          instructionsHead: instructionsHead(agent),
          ...(imported ? { sourceSessionId: `sess-a-${agent.index}` } : {}),
        }
      : {};
    maybeReplay(
      emit(
        "node-settled",
        { instance: askInstance(agent), outcome: "ok", cached: true, phaseName, ...facts },
        shape.cachedNamesActor ? { actorSessionId: `sess-${agent.index}` } : {},
      ),
    );
  };
  // 调度器的 node-queued（scheduler.ts）：kind / actor / actorSeq / instructionsHead 在这里落，
  // 出生阶段名由引擎随后补（engine-phase-stamp.ts）。
  const queueAsk = (agent: EngineAgent): void => {
    maybeReplay(
      emit("node-queued", {
        instance: askInstance(agent),
        kind: "ask",
        actor: actorRef(agent.index),
        actorSeq: agent.done,
        phaseName: agent.phaseName,
        instructionsHead: instructionsHead(agent),
      }),
    );
  };
  // 派发重发出生事实（DESIGN-3 Part A）：kind / actor / 节点阶段戳 / 任务摘要来自这条实例的
  // node-queued，名字与出生阶段来自它的 actor-created，会话 id 与 actor-created 同一条信封字段
  // （dynamic-workflow-run-launch.ts 的 actorSessionRefOf 在这两种事件上补它）。
  const dispatchAsk = (agent: EngineAgent): void => {
    maybeReplay(
      emit(
        "node-dispatched",
        {
          instance: askInstance(agent),
          kind: "ask",
          actor: actorRef(agent.index),
          actorName: `a${agent.index}`,
          actorPhaseName: agent.phaseName,
          phaseName: agent.phaseName,
          instructionsHead: instructionsHead(agent),
        },
        { actorSessionId: `sess-${agent.index}` },
      ),
    );
    emit("node-executing", { instance: askInstance(agent) });
    // 一次已解析轮次的读数。不是生命周期事件（不落相位、不计步），但它确实夹在这两条中间，
    // 而它对一条**表外**实例必须是彻底的 no-op——否则表外的实例会被它凭空建出一行。
    if (random() < 0.4) {
      emit("node-progress", {
        instance: askInstance(agent),
        turn: 1,
        toolCalls: 1,
        lastTool: { name: "submit_result" },
      });
    }
  };
  const worldRead = (phaseName: string): void => {
    worldNumber += 1;
    const instance = worldRef(worldNumber);
    emit("node-queued", { instance, kind: "world-read", phaseName });
    // 世界读的派发紧跟自己的入队，而且**不带事实**（engine-world.ts）。
    emit("node-dispatched", { instance });
    emit("node-settled", { instance, outcome: "ok" });
  };
  /**
   * 这个子代理的下一次 ask 开工。命中完结缓存的直接结算、接着看再下一次；真要跑的才入队。
   * 串行由此成立：一个子代理同一时刻最多有一条 ask 在队列或在跑。
   */
  const beginNextAsk = (agent: EngineAgent, queue: EngineAgent[]): void => {
    while (agent.done < agent.asks) {
      if (random() < shape.cachedRate) {
        settleCached(agent, agent.phaseName, true);
        agent.done += 1;
        continue;
      }
      queueAsk(agent);
      queue.push(agent);
      return;
    }
  };

  emit("run-started", {});
  let agentNumber = 0;
  let settles = 0;
  let interrupted = false;
  /** 每个阶段的全部子代理，按出生序：第二世的重放前缀要照原样再走一遍。 */
  const roster: EngineAgent[][] = [];
  for (let phase = 1; phase <= shape.phases; phase += 1) {
    const phaseName = `p${phase}`;
    emit("phase-entered", { name: phaseName, ordinal: 1 });
    const agents: EngineAgent[] = [];
    roster.push(agents);
    // 先把这一阶段**全部** actor 建出来：事故里的 2000 条 actor-created 就是在这里一口气发完的。
    for (let index = 0; index < shape.agentsPerPhase; index += 1) {
      agentNumber += 1;
      const agent: EngineAgent = {
        index: agentNumber,
        phaseName,
        asks: 1 + Math.floor(random() * shape.maxAsks),
        done: 0,
      };
      agents.push(agent);
      maybeReplay(
        emit(
          "actor-created",
          { actor: actorRef(agent.index), name: `a${agent.index}`, phaseName },
          { actorSessionId: `sess-${agent.index}` },
        ),
      );
    }
    // 再把**全部**第一次 ask 入队，一条都还没派下去：这一刻表已经满了，而一条终态都没有。
    const queue: EngineAgent[] = [];
    for (const agent of agents) beginNextAsk(agent, queue);
    const running: EngineAgent[] = [];
    while (queue.length > 0 || running.length > 0) {
      while (running.length < shape.concurrency && queue.length > 0) {
        const agent = queue.shift()!;
        dispatchAsk(agent);
        running.push(agent);
      }
      if (random() < 0.2) worldRead(phaseName);
      const agent = running.splice(Math.floor(random() * running.length), 1)[0]!;
      emit("node-settled", {
        instance: askInstance(agent),
        outcome: pick(["ok", "ok", "ok", "failed", "cancelled"]),
      });
      agent.done += 1;
      settles += 1;
      // 用户按了停止：在飞的 ask 与排着队的都留在原地，脚本不再往下走。
      if (shape.interruptAfter > 0 && settles >= shape.interruptAfter) {
        interrupted = true;
        break;
      }
      beginNextAsk(agent, queue);
    }
    if (interrupted) break;
  }
  if (!interrupted) return envelopes;

  // ── 第二世（resume）。溢出过的 run 从空表重开，脚本整段重跑：每个阶段的 actor 全部重建，
  // 做完的 ask 补一条缓存结算（老形状不带 actor，落成游离节点、那个子代理名下一条已列节点都
  // 没有；新形状带，落成它名下的一条已结算节点），没做完的重新入队，然后照旧派活。
  emit("run-started", {});
  for (const agents of roster) {
    const phaseName = agents[0]!.phaseName;
    emit("phase-entered", { name: phaseName, ordinal: 1 });
    for (const agent of agents) {
      maybeReplay(
        emit(
          "actor-created",
          { actor: actorRef(agent.index), name: `a${agent.index}`, phaseName },
          { actorSessionId: `sess-${agent.index}` },
        ),
      );
    }
    const queue: EngineAgent[] = [];
    for (const agent of agents) {
      const replayed = agent.done;
      agent.done = 0;
      for (; agent.done < replayed; agent.done += 1) settleCached(agent, phaseName, false);
      beginNextAsk(agent, queue);
    }
    const running: EngineAgent[] = [];
    while (queue.length > 0 || running.length > 0) {
      while (running.length < shape.concurrency && queue.length > 0) {
        const agent = queue.shift()!;
        dispatchAsk(agent);
        running.push(agent);
      }
      if (random() < 0.2) worldRead(phaseName);
      const agent = running.splice(Math.floor(random() * running.length), 1)[0]!;
      emit("node-settled", {
        instance: askInstance(agent),
        outcome: pick(["ok", "ok", "ok", "failed", "cancelled"]),
      });
      agent.done += 1;
      beginNextAsk(agent, queue);
    }
  }
  return envelopes;
}

/**
 * 此刻表里可以为一个新人腾出位子的条目数。恒为 0 才算这次拒绝合法——这是 I7 / I8 唯一的豁免。
 *
 * 要分两种缺位来数，因为两种缺位的受害者不是一回事：
 *   - 缺 **actor 位**（这个子代理不在表上、actor 表满）：只有整行的人能腾出一个 actor 位，
 *     也就是非 live 的组与零节点 actor；游离节点和自己名下的节点都不行。豁免因此收紧成
 *     「每个已列 actor 都在跑」。
 *   - 只缺 **节点位**：newcomer 自己名下那些已结算的节点先算（丢一条只少一行历史，徽章不动），
 *     然后是已结算的游离节点，最后才是别人的组——零节点 actor 在这里帮不上忙，它腾的是
 *     actor 位。
 */
function spareRoomFor(
  run: WorkflowRunState,
  instance: { siteId: string; ordinal: number },
  owner: { siteId: string; ordinal: number },
  limits: WorkflowRunEntryLimits,
): number {
  const ownerKey = entryKey(owner);
  let groups = 0;
  let zeroNode = 0;
  for (const actor of run.actors) {
    if (entryKey(actor) === ownerKey) continue;
    const owned = nodesOfActor(run, actor);
    if (owned.length === 0) {
      zeroNode += 1;
      continue;
    }
    // 非 live 的组都可以让位：全已结算的（活干完了）与还排着队的（在等槽位）。
    if (owned.every((node) => node.phase === "settled" || node.phase === "queued")) groups += 1;
  }
  const needsActorSlot = !actorKeySet(run).has(ownerKey) && run.actors.length >= limits.maxActors;
  if (needsActorSlot) return groups + zeroNode;
  if (nodeKeySet(run).has(entryKey(instance)) || run.nodes.length < limits.maxNodes) return 1;
  let rows = 0;
  for (const node of run.nodes) {
    if (node.phase !== "settled") continue;
    const loose = node.actorSiteId === undefined;
    const own = node.actorSiteId === owner.siteId && node.actorOrdinal === owner.ordinal;
    if (loose || own) rows += 1;
  }
  return groups + rows;
}

/** 一条生成流跑一遍要断言的全部东西。 */
interface EngineCase extends Omit<EngineShape, "cachedNamesActor"> {
  seed: number;
  limits: WorkflowRunEntryLimits;
}

const ENGINE_CASES: readonly EngineCase[] = [
  // 事故的比例（并发远小于表界）。
  {
    seed: 2,
    phases: 2,
    agentsPerPhase: 12,
    concurrency: 3,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 6, maxNodes: 12, maxPhases: 3 },
  },
  // 节点界紧到连 3 × 并发都装不下：在跑的子代理名下压着自己的已结算历史，只有「先丢自己的」
  // 那条规则能把位子腾出来。改这条规则之前，这组界会让 3 个在跑的子代理掉出表。
  {
    seed: 13,
    phases: 3,
    agentsPerPhase: 10,
    concurrency: 5,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 7, maxNodes: 9, maxPhases: 4 },
  },
  // 线上那条 run 的并发（13）与它的比例（子代理数远多于表界）。
  {
    seed: 71,
    phases: 2,
    agentsPerPhase: 30,
    concurrency: 13,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 20, maxNodes: 45, maxPhases: 3 },
  },
  // 并发**高于** actor 表界：一张全是 live 组的表腾不出位，豁免这时才该用上。
  {
    seed: 404,
    phases: 2,
    agentsPerPhase: 14,
    concurrency: 9,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 5, maxNodes: 7, maxPhases: 2 },
  },
  // 夹着完结缓存命中：出生即结算的游离节点 + 一批名下没有任何已列节点的 actor。
  {
    seed: 909,
    phases: 3,
    agentsPerPhase: 9,
    concurrency: 6,
    cachedRate: 0.25,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 8, maxNodes: 10, maxPhases: 4 },
  },
  // 两世：第一世跑到一半被掐断，第二世重放整段前缀——全部 actor 重建 + 不带 actor 的缓存结算，
  // 于是 actor 表会先被一批**零节点** actor 占满。少了零节点这一档，第二世的每一次派发都会被拒。
  {
    seed: 5_150,
    phases: 2,
    agentsPerPhase: 12,
    concurrency: 4,
    cachedRate: 0,
    interruptAfter: 8,
    // 每人只做一次 ask：于是第一世结算过的那 8 个在第二世是**彻底做完**的，重放只给它们补一条
    // 不带 actor 的缓存结算 —— actor 表因此被一批零节点 actor 占满，没有任何组可以让位。
    maxAsks: 1,
    limits: { maxActors: 6, maxNodes: 8, maxPhases: 3 },
  },
];

describe("不变量 I1–I9（引擎形状：先建全部 actor、再入队、FIFO 派活）", () => {
  const CACHE_SHAPES = [
    { cachedNamesActor: true, label: "缓存结算带出生事实" },
    { cachedNamesActor: false, label: "老 journal：缓存结算不带 actor" },
  ] as const;
  const CASES = CACHE_SHAPES.flatMap(({ cachedNamesActor, label }) =>
    ENGINE_CASES.map((engineCase) => ({ shape: { ...engineCase, cachedNamesActor }, label })),
  );
  for (const { shape, label } of CASES) {
    const { seed, limits } = shape;
    it(`seed ${seed}（并发 ${shape.concurrency} / actor 界 ${limits.maxActors}，${label}）：两张账都对得上`, () => {
      const envelopes = generateEngineLife(seed, shape);
      let state: WorkflowRunsState | undefined;
      const bornNodes = new Set<string>();
      const settledNodes = new Set<string>();
      const bornAgents = new Set<string>();
      const everListed = new Set<string>();
      /** 此刻在跑的实例 → 它的 actor 键（world-read 记 null）。 */
      const live = new Map<string, string | null>();
      /** 被派发的那一刻就没位子的实例：I8 对它们豁免，与 I7 同一条理由。 */
      const homeless = new Set<string>();
      const steps: ReducedStep[] = [];
      let activations = 0;
      let truncatedAt = -1;

      for (const [step, envelope] of envelopes.entries()) {
        const priorRun = state?.runs[0];
        const advanced = envelope.sequence! > (priorRun?.lastEventSequence ?? -1);
        const payload = envelope.payload as Record<string, unknown>;
        const instance = payload.instance as { siteId: string; ordinal: number } | undefined;
        const actor = payload.actor as { siteId: string; ordinal: number } | undefined;

        const next = reduceWorkflowRunsState(state, envelope, limits);
        // I5（一半）：重放一条刚归约过的事件是彻底的 no-op。
        if (next !== null) {
          expect(reduceWorkflowRunsState(next, envelope, limits)).toBeNull();
        }
        const run = (next ?? state)!.runs[0]!;

        // 新一世：溢出过的 run 从空表重开，所以这几本地面真相的账也从头记。I4 比的是**本世**
        // 出生过的实例数，而 run-started 正是把两个计数器清零的那条事件。
        if (envelope.eventType === "run-started" && advanced) {
          bornNodes.clear();
          settledNodes.clear();
          bornAgents.clear();
          everListed.clear();
          live.clear();
          homeless.clear();
        }

        if (envelope.eventType === "actor-created" && actor !== undefined) {
          bornAgents.add(entryKey(actor));
        }
        if (instance !== undefined) {
          const key = entryKey(instance);
          if (envelope.eventType === "node-queued" || payload.cached === true) bornNodes.add(key);
          if (envelope.eventType === "node-settled") {
            settledNodes.add(key);
            live.delete(key);
          }
          // 只跟子代理的 ask：world-read 没有主人，也画不出徽章，I8 说的是「在跑的子代理」。
          if (envelope.eventType === "node-dispatched" && actor !== undefined) {
            live.set(key, entryKey(actor));
          }
        }

        // I1：两张表都在界内。
        expect(run.actors.length).toBeLessThanOrEqual(limits.maxActors);
        expect(run.nodes.length).toBeLessThanOrEqual(limits.maxNodes);

        // I2：走掉的节点只能是已结算的或还排着队的；走掉的 actor 名下一条**在跑**的都没有。
        // `run-started` 不在此列：溢出过的 run 新一世从**空表**重开，那是重置而不是淘汰。
        if (priorRun !== undefined && envelope.eventType !== "run-started") {
          const keptNodes = nodeKeySet(run);
          const keptActors = actorKeySet(run);
          for (const node of priorRun.nodes) {
            if (keptNodes.has(entryKey(node))) continue;
            expect(["settled", "queued"]).toContain(node.phase);
          }
          for (const actor_ of priorRun.actors) {
            if (keptActors.has(entryKey(actor_))) continue;
            for (const node of nodesOfActor(priorRun, actor_)) {
              expect(["settled", "queued"]).toContain(node.phase);
            }
          }
        }

        // I3：列过节点的 actor 永远不会掉到零条节点。
        for (const actor_ of run.actors) {
          const key = entryKey(actor_);
          if (nodesOfActor(run, actor_).length > 0) {
            everListed.add(key);
            continue;
          }
          expect(everListed.has(key)).toBe(false);
        }

        // I7：带事实的 dispatch 之后，这条实例与它的子代理都在表上——除非那一刻表里
        // 一个可让位的组都没有（全是在跑的组，或名下一条已列节点都没有的 actor）。
        if (
          envelope.eventType === "node-dispatched" &&
          advanced &&
          instance !== undefined &&
          actor !== undefined
        ) {
          const nodeListed = nodeKeySet(run).has(entryKey(instance));
          const actorListed = actorKeySet(run).has(entryKey(actor));
          if (nodeListed && actorListed) {
            if (!nodeKeySet(priorRun ?? run).has(entryKey(instance))) activations += 1;
          } else {
            expect(spareRoomFor(priorRun!, instance, actor, limits)).toBe(0);
            homeless.add(entryKey(instance));
          }
        }

        // I9：点名了子代理的已列节点，它的子代理一定也在表上。反过来就是一行永远淘汰不掉的节点
        // （它不是游离节点，而组是按已列 actor 建的）——缓存结算重发 actor ref 之后，B2 必须连它
        // 一起拒，否则这一行会在溢出过的 run 里卡死一个节点位。
        for (const node of run.nodes) {
          if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
          expect(
            actorKeySet(run).has(
              entryKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal }),
            ),
          ).toBe(true);
        }

        // I8：此刻在跑的每条实例（与它的子代理）都在表上，豁免同 I7。
        const listedNodes = nodeKeySet(run);
        const listedActors = actorKeySet(run);
        for (const [key, owner] of live) {
          if (homeless.has(key)) continue;
          expect(listedNodes.has(key)).toBe(true);
          expect(listedActors.has(owner)).toBe(true);
        }

        // I6：每一格恒满足 actorsFailed ≤ actorsSettled ≤ actors（夹取是这一格的法律），
        // 且 Σ actors 恰是「出生过但此刻不在表上」的子代理数——溢出之前没有格子，之后每一次
        // 拒绝、淘汰与回表都要对得上。
        for (const bucket of run.unlistedByPhase ?? []) {
          expect(bucket.actorsFailed ?? 0).toBeLessThanOrEqual(bucket.actorsSettled ?? 0);
          expect(bucket.actorsSettled ?? 0).toBeLessThanOrEqual(bucket.actors);
        }
        if (run.truncated === true && truncatedAt < 0) truncatedAt = step;
        const attributedActors = (run.unlistedByPhase ?? []).reduce(
          (sum, bucket) => sum + bucket.actors,
          0,
        );
        let unlistedAgents = 0;
        for (const key of bornAgents) if (!listedActors.has(key)) unlistedAgents += 1;
        expect(attributedActors).toBe(unlistedAgents);

        if (next === null) continue;
        // diff 契约：增量施加到 prior 之后与 next 逐字节一致。
        const deltas = diffWorkflowRunsState(state, next);
        for (const delta of deltas) {
          expect(conversationDeltaSchema.safeParse(delta).success).toBe(true);
        }
        const applied = applyConversationDeltas(snapshotWith(state), deltas);
        expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(next));
        expect(workflowRunsStateSchema.safeParse(next).success).toBe(true);
        steps.push({ prior: state, deltas });
        state = next;
      }

      const run = state!.runs[0]!;
      // 这条流真的走过了界，也真的走过了「派发即入座」那条路。
      expect(truncatedAt).toBeGreaterThan(0);
      expect(activations).toBeGreaterThan(0);
      // I4：表内 + 表外 = 本世出生过的实例数；已结算同理。
      expect(run.nodes.length + (run.usage.nodesUnlisted ?? 0)).toBe(bornNodes.size);
      expect(workflowRunStepCounts(run)).toEqual({
        total: bornNodes.size,
        settled: settledNodes.size,
      });

      // I5（另一半）：同一串事件冷回放一遍得到逐字节相同的状态。
      let replayed: WorkflowRunsState | undefined;
      for (const envelope of envelopes) {
        replayed = reduceWorkflowRunsState(replayed, envelope, limits) ?? replayed;
      }
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(state));

      expectCoalesceEquivalence(steps, seed);
    });
  }
});

// 子代理的模型（docs/dynamic-workflow/presentation.md「Reduction」）：`actor-created` 的 `model`，
// 以及派发时收回表的那条路上 `node-dispatched` 的 `actorModel`——两条出生路径长出同一个条目。
describe("子代理的模型", () => {
  it("actor-created 带 model 即落进条目；超界整个丢掉，不截断", () => {
    const driven = driver({ maxActors: 3, maxNodes: 3, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1", model: "zhipu/GLM-5.3$high" });
    driven.send("actor-created", {
      actor: actorRef(2),
      name: "a2",
      model: "x".repeat(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength + 1),
    });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.actors.map((actor) => actor.model)).toEqual([
      "zhipu/GLM-5.3$high",
      undefined,
      undefined,
    ]);
    expect(workflowRunsStateSchema.safeParse(driven.state).success).toBe(true);
  });

  it("被拒的子代理在派发时回到表上，带着 actorModel", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    // 三个子代理都点了模型；第三个出生时表已满，连同它的 `model` 一起被拒。
    for (let index = 1; index <= 3; index += 1) {
      driven.send(
        "actor-created",
        {
          actor: actorRef(index),
          name: `a${index}`,
          phaseName: "p1",
          model: "zhipu/GLM-5.3-Flash",
        },
        { actorSessionId: `sess-${index}` },
      );
      driven.send("node-queued", {
        instance: askRef(index),
        kind: "ask",
        actor: actorRef(index),
        phaseName: "p1",
      });
    }
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    dispatchWithFacts(driven, 1, { phaseName: "p1" });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    dispatchWithFacts(driven, 2, { phaseName: "p1" });
    driven.send("node-settled", { instance: askRef(2), outcome: "ok" });

    driven.send(
      "node-dispatched",
      {
        instance: askRef(3),
        kind: "ask",
        actor: actorRef(3),
        actorName: "a3",
        actorPhaseName: "p1",
        actorPersonaModel: "GLM-5.3-Flash",
        actorModel: "zhipu/GLM-5.3-Flash",
        phaseName: "p1",
      },
      { actorSessionId: "sess-3" },
    );
    expect(driven.run.actors.at(-1)).toMatchObject({
      siteId: "actor#3",
      name: "a3",
      model: "zhipu/GLM-5.3-Flash",
    });
  });

  it("已在表上的子代理：派发不改写它的条目", () => {
    const driven = driver({ maxActors: 3, maxNodes: 3, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1", model: "zhipu/GLM-5.3" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-dispatched", {
      instance: askRef(1),
      kind: "ask",
      actor: actorRef(1),
      actorName: "a1",
    });
    expect(driven.run.actors[0]?.model).toBe("zhipu/GLM-5.3");
  });
});
