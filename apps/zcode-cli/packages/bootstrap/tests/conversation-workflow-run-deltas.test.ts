// publisher 对 workflowRun 键级增量的两条纯规则（src/zcode-protocol-v4/conversation-workflow-run-deltas.ts）。
// 一条决定旧消费者还能不能看见 run，一条决定 16MiB 闸门算得松不松——两条都不能靠"看起来对"。
import { describe, expect, it } from "vitest";
import type {
  ConversationDelta,
  WorkflowRunEntryLimits,
  WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import {
  encodeConversationDeltasForLegacy,
  workflowRunDeltaGrowthUpperBound,
} from "../src/zcode-protocol-v4/index.js";

function runState(nodeCount: number, actorCount = 0): WorkflowRunsState {
  return {
    revision: 7,
    runs: [
      {
        runId: "dwfrun-1",
        status: "running",
        usage: { spentTokens: 0, nodesUsed: nodeCount },
        actors: Array.from({ length: actorCount }, (_unused, index) => ({
          siteId: "actor#1",
          ordinal: index + 1,
          status: "idle" as const,
        })),
        nodes: Array.from({ length: nodeCount }, (_unused, index) => ({
          siteId: "ask#1",
          ordinal: index + 1,
          phase: "dispatched" as const,
        })),
        lastEventSequence: nodeCount,
      },
    ],
  };
}

function updated(runId: string, revision: number): ConversationDelta {
  return { op: "workflowRun.updated", runId, revision, run: { lastEventSequence: revision } };
}

const ROW: ConversationDelta = {
  op: "row.appended",
  row: {
    rowId: 1,
    kind: "assistantText",
    turnId: "turn-1",
    text: "hi",
    streaming: false,
    createdAt: 0,
  },
};

describe("旧消费者编码", () => {
  it("没有键级增量的批次原样返回**同一个数组**", () => {
    const deltas = [
      ROW,
      { op: "state.updated", patch: { revision: 3 } } satisfies ConversationDelta,
    ];
    expect(encodeConversationDeltasForLegacy(deltas, runState(2))).toBe(deltas);
  });

  it("整批的键级增量折成一条整键 patch，落在**最后一条**被丢掉的位置上", () => {
    const tail: ConversationDelta = { op: "state.updated", patch: { revision: 9 } };
    const deltas: ConversationDelta[] = [
      updated("dwfrun-1", 5),
      ROW,
      updated("dwfrun-1", 6),
      { op: "workflowRun.removed", runId: "dwfrun-2", revision: 7 },
      tail,
    ];
    const encoded = encodeConversationDeltasForLegacy(deltas, runState(2));

    expect(encoded.map((delta) => delta.op)).toEqual([
      "row.appended",
      "state.updated",
      "state.updated",
    ]);
    // 位置在最后一条被丢掉的 op 上：整键替换蕴含这批增量的全部效果，与其余 op 的相对顺序
    // 因此与逐条投递一致（行 op 与状态键互不相干）。
    expect(encoded[0]).toBe(ROW);
    expect(encoded[2]).toBe(tail);
    const patch = (encoded[1] as { patch: { workflowRuns?: WorkflowRunsState } }).patch;
    expect(patch.workflowRuns?.revision).toBe(7);
    expect(patch.workflowRuns?.runs[0]?.nodes).toHaveLength(2);
  });

  it("超过旧界的表裁到 256 并置 truncated（旧二进制的 .max(256) 会让整帧解析失败）", () => {
    const state = runState(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes + 40, 300);
    const encoded = encodeConversationDeltasForLegacy([updated("dwfrun-1", 8)], state);
    const run = (encoded[0] as { patch: { workflowRuns: WorkflowRunsState } }).patch.workflowRuns
      .runs[0]!;

    expect(run.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    expect(run.actors).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors);
    expect(run.truncated).toBe(true);
    // 「前 256 条」不是随手取的：旧归约触界时是拒新，它产出的恰好就是最早那 256 条。
    expect(run.nodes[0]?.ordinal).toBe(1);
    expect(run.nodes.at(-1)?.ordinal).toBe(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
  });

  it("投影里还没有 workflowRuns 键时只丢不补（没有能整键替换成的东西）", () => {
    expect(encodeConversationDeltasForLegacy([ROW, updated("dwfrun-1", 1)], undefined)).toEqual([
      ROW,
    ]);
  });
});

describe("快路径的增长上界", () => {
  it("整批都是键级增量：给出上界，且不小于这批 op 自己的字节数", () => {
    const deltas = [updated("dwfrun-1", 5), updated("dwfrun-2", 6)];
    const bound = workflowRunDeltaGrowthUpperBound(deltas);
    expect(bound).not.toBeNull();
    expect(bound!).toBeGreaterThan(JSON.stringify(deltas).length);
  });

  it("掺了任何其它 op 就必须精确测量", () => {
    expect(workflowRunDeltaGrowthUpperBound([updated("dwfrun-1", 5), ROW])).toBeNull();
  });

  /**
   * 一条 delta 都不产的事件（归约判了幂等重放）对快照的全部改动就是 `seq` 那个数字。让它落回
   * 精确路径等于为"什么都没发生"付一次整份序列化——而一个宽 fan-out 的 run 里重放并不罕见。
   */
  it("空批次走快路径，余量仍然盖得住 seq 位数的增长", () => {
    const bound = workflowRunDeltaGrowthUpperBound([]);
    expect(bound).not.toBeNull();
    expect(bound!).toBeGreaterThan(String(Number.MAX_SAFE_INTEGER).length);
  });

  /**
   * 这一条是快路径的安全边：diff 认不出结构变化时会退化成整键 `state.updated{workflowRuns}`，
   * 那条 op 的字节数**不是**增长的上界（它替换的是整个键，被替换掉的旧值不在其中）。
   */
  it("整键 workflowRuns patch 不走快路径", () => {
    const wholeKey: ConversationDelta = {
      op: "state.updated",
      patch: { workflowRuns: runState(300) },
    };
    expect(workflowRunDeltaGrowthUpperBound([wholeKey])).toBeNull();
    expect(workflowRunDeltaGrowthUpperBound([updated("dwfrun-1", 5), wholeKey])).toBeNull();
  });

  /**
   * 上界的论证是「一条 `workflowRun.updated` 写进快照的每个字节都在它自己的载荷里」。腾位
   * （workflow-runs-eviction.ts）给这条论证添了三处以前不存在的形状，每一处都是它可能破的地方：
   * 一条 op 同时带删除与 upsert、一个 header 键（`unlistedByPhase` / `truncated`）**第一次**出现、
   * 以及 upsert 用**更长**的条目替掉表里原来那条（增长是 new − old，不是 new——得真的是这样）。
   *
   * 所以这一条不靠论证，靠真归约跑一遍：每一步都把「快照长了多少」与「这批 op 有多少字节」摆在
   * 一起。界按 4 注入（归约留的测试口）——规则与界的大小无关，而 1024 要三千多条事件才撞得到。
   */
  it("腾位事件流：每一步的快照增长都不超过这批 op 自己的字节数", () => {
    let prior: WorkflowRunsState | undefined;
    let removals = 0;
    let headerBorn = 0;
    let longerUpserts = 0;
    let fallbacks = 0;

    for (const envelope of evictionEnvelopes()) {
      const next = reduceWorkflowRunsState(prior, envelope, TINY_LIMITS);
      if (next === null) continue;
      const ops = diffWorkflowRunsState(prior, next);
      // 「快照长了多少」按状态键整份量：prior 缺席时整个键是新的，这已经把它的外壳算进去了。
      const growth =
        utf8JsonByteLength(next) - (prior === undefined ? 0 : utf8JsonByteLength(prior));
      const bound = workflowRunDeltaGrowthUpperBound(ops);
      if (bound === null) fallbacks += 1;
      else {
        expect(bound).toBeGreaterThanOrEqual(growth);
        // 更紧的一条：64 的余量是留给 JSON 外壳与 `seq` 位数的，不该被 workflowRuns 自己吃掉。
        expect(utf8JsonByteLength(ops)).toBeGreaterThanOrEqual(growth);
      }
      longerUpserts += countLongerUpserts(prior, next);
      for (const op of ops) {
        if (op.op !== "workflowRun.updated") continue;
        if (op.removedActors !== undefined || op.removedNodes !== undefined) removals += 1;
        if (op.run?.unlistedByPhase !== undefined || op.run?.truncated !== undefined) {
          headerBorn += 1;
        }
      }
      prior = next;
    }

    // 三处形状都真的被走到了，否则上面那串断言只是在证明一条没发生过的事。
    expect(removals).toBeGreaterThan(0);
    expect(headerBorn).toBeGreaterThan(0);
    expect(longerUpserts).toBeGreaterThan(0);
    // 归约认得出的结构变化全程没有退化成整键重发——这一整段都在快路径上。
    expect(fallbacks).toBe(0);
    expect(prior?.runs[0]?.truncated).toBe(true);
    expect(prior?.runs[0]?.unlistedByPhase?.length).toBeGreaterThan(0);
  });
});

/** 界按 4 注入：腾位的规则与界的大小无关，小界让整条路径在几百条事件里走完。 */
const TINY_LIMITS: WorkflowRunEntryLimits = { maxActors: 4, maxNodes: 4, maxPhases: 3 };

/** 这一步里被**更长**的条目原地替掉的节点数（上界论证最容易被想当然的那一处）。 */
function countLongerUpserts(prior: WorkflowRunsState | undefined, next: WorkflowRunsState): number {
  const before = prior?.runs[0];
  const after = next.runs[0];
  if (before === undefined || after === undefined) return 0;
  let count = 0;
  for (const node of after.nodes) {
    const old = before.nodes.find(
      (entry) => entry.siteId === node.siteId && entry.ordinal === node.ordinal,
    );
    if (old !== undefined && utf8JsonByteLength(node) > utf8JsonByteLength(old)) count += 1;
  }
  return count;
}

/**
 * 一段会反复撞界的引擎事件流：具名阶段的 ask 组（腾位的受害者）、无主的 world-read（游离节点）、
 * 越写越长的 `lastTool.target`（更长的 upsert），最后一次重臂 + 一批缓存命中的结算（孤儿规则）。
 */
function evictionEnvelopes(): {
  runId: string;
  toolCallId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
}[] {
  const envelopes: ReturnType<typeof evictionEnvelopes> = [];
  const push = (eventType: string, payload: Record<string, unknown>): void => {
    envelopes.push({
      runId: "dwfrun-1",
      toolCallId: "tc-1",
      sequence: envelopes.length,
      eventType,
      payload,
    });
  };
  push("run-started", { runId: "dwfrun-1" });
  for (let ordinal = 1; ordinal <= 40; ordinal += 1) {
    const actor = { siteId: "agent#1", ordinal };
    const instance = { siteId: "ask#1", ordinal };
    const phaseName = `phase-${ordinal % 5}`;
    push("actor-created", { actor, name: `agent-${ordinal}`, phaseName });
    push("node-queued", { instance, actor, kind: "ask", phaseName });
    push("node-dispatched", { instance });
    push("node-executing", { instance });
    push("node-progress", {
      instance,
      turn: ordinal,
      toolCalls: ordinal * 3,
      lastTool: { name: "Bash", target: "t".repeat((ordinal * 5) % 64) },
    });
    if (ordinal % 4 === 0) {
      // 无主的 world-read：游离节点是 node 表的第一类受害者。
      push("node-queued", { instance: { siteId: "world#1", ordinal }, kind: "world-read" });
      push("node-settled", { instance: { siteId: "world#1", ordinal }, outcome: "ok" });
    }
    push("node-settled", { instance, outcome: ordinal % 9 === 0 ? "failed" : "ok" });
  }
  push("run-started", { runId: "dwfrun-1" });
  for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
    // 出生即结算：它不腾位，被拒时走孤儿规则（连同那个带不进节点的 actor 一起记账）。
    push("node-settled", {
      instance: { siteId: "ask#1", ordinal },
      actor: { siteId: "agent#1", ordinal },
      cached: true,
      outcome: "ok",
      phaseName: `phase-${ordinal % 5}`,
    });
  }
  return envelopes;
}
