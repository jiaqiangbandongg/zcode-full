// 时间线模型的成本契约（docs/dynamic-workflow/presentation.md「The timeline model」的 Cost 段）：
//   1. 参与者视图按 actors + nodes 线性，而不是两者的乘积——索引化之后输出必须与原来
//      那套「每张卡重扫一遍 run.nodes」的算法逐字节相同，所以旧算法作为**参照实现**留在
//      这个文件里，拿一条宽 run（一条车道上几百个实例、阶段再入、游离节点）对拍。
//   2. 一对 (graph, run) 只建一次模型，两处消费拿到同一个对象。
import { describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  instanceCardId,
  liveParticipantView,
  type LiveParticipantView,
  type ParticipantInstance,
} from "@/components/workflow-graph/participant-model.js";
import { phaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { aggregateRunStatuses, statusOfRunNode } from "@/components/workflow-graph/run-status.js";
import type {
  StepRunStatus,
  WorkflowCausalityGraphData,
  WorkflowHandoffData,
  WorkflowParticipantData,
} from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";

// ============================================================
// 参照实现：索引化之前的 liveParticipantView，逐字保留
// ============================================================

function referenceBoundInstance(
  participantId: string,
  actor: WorkflowRunState["actors"][number],
): ParticipantInstance {
  return {
    bound: true,
    ordinal: actor.ordinal,
    participant: participantId,
    ...(actor.name === undefined ? {} : { name: actor.name }),
  };
}

function referenceLiveParticipantView(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): LiveParticipantView {
  if (run === undefined) return { graph, instances: {}, participantStatuses: {} };
  const siteOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const binder = phaseBinder(graph, run);
  const sitesOf = (participant: WorkflowParticipantData) =>
    new Set(participant.steps.map((id) => siteOf.get(id) ?? id));
  const instancesOfCard = (participant: WorkflowParticipantData) => {
    const sites = sitesOf(participant);
    const seen = new Set<number>();
    const here = new Set<number>();
    for (const node of run.nodes) {
      if (node.actorSiteId !== participant.lane || !sites.has(node.siteId)) continue;
      if (node.actorOrdinal === undefined) continue;
      seen.add(node.actorOrdinal);
      if (binder.has(participant.phase, node.phaseName)) here.add(node.actorOrdinal);
    }
    return run.actors
      .filter(
        (actor) =>
          actor.siteId === participant.lane &&
          (here.has(actor.ordinal) ||
            (!seen.has(actor.ordinal) && binder.has(participant.phase, actor.phaseName))),
      )
      .sort((a, b) => a.ordinal - b.ordinal);
  };
  const statusFor = (participant: WorkflowParticipantData, ordinal: number): StepRunStatus => {
    const sites = sitesOf(participant);
    const values = run.nodes
      .filter(
        (node) =>
          sites.has(node.siteId) &&
          node.actorSiteId === participant.lane &&
          node.actorOrdinal === ordinal &&
          binder.has(participant.phase, node.phaseName),
      )
      .map(statusOfRunNode);
    return aggregateRunStatuses(values) ?? "pending";
  };

  const participants: WorkflowParticipantData[] = [];
  const replacements = new Map<string, string[]>();
  const participantStatuses: Record<string, StepRunStatus> = {};
  const instances: Record<string, ParticipantInstance> = {};
  let changed = false;
  for (const participant of graph.participants) {
    const actors = instancesOfCard(participant);
    if (participant.member !== undefined) {
      const actor = actors[participant.member.index];
      participantStatuses[participant.id] =
        actor === undefined ? "pending" : statusFor(participant, actor.ordinal);
      if (actor !== undefined) {
        instances[participant.id] = referenceBoundInstance(participant.id, actor);
      }
      participants.push(participant);
      continue;
    }
    if (participant.many !== true && actors.length === 1) {
      instances[participant.id] = referenceBoundInstance(participant.id, actors[0]!);
      participants.push(participant);
      continue;
    }
    if (participant.many === true || actors.length > 1) {
      if (actors.length === 0) {
        participants.push(participant);
        continue;
      }
      changed = true;
      const ids: string[] = [];
      for (const actor of actors) {
        const id = instanceCardId(participant.id, actor.ordinal);
        const { many: _many, ...rest } = participant;
        participants.push({ ...rest, id });
        participantStatuses[id] = statusFor(participant, actor.ordinal);
        instances[id] = {
          ordinal: actor.ordinal,
          participant: participant.id,
          ...(actor.name === undefined ? {} : { name: actor.name }),
        };
        ids.push(id);
      }
      replacements.set(participant.id, ids);
      continue;
    }
    participants.push(participant);
  }
  if (!changed) return { graph, instances, participantStatuses };

  const handoffs: WorkflowHandoffData[] = [];
  for (const edge of graph.handoffs) {
    const froms = replacements.get(edge.from) ?? [edge.from];
    const tos = replacements.get(edge.to) ?? [edge.to];
    for (const from of froms) for (const to of tos) handoffs.push({ ...edge, from, to });
  }
  return { graph: { ...graph, handoffs, participants }, instances, participantStatuses };
}

// ============================================================
// 一条宽 run：一条车道上几百个实例、阶段再入、成员卡、游离节点
// ============================================================

const PHASE_ONE = "起草";
const PHASE_TWO = "校订";

// `ask#m2` 带 source：站点键是 `ask#m1`，两张 many 卡因此共享一个站点、只靠阶段戳分开
// （阶段再入正是索引化最容易画错的形状）。
const GRAPH: WorkflowCausalityGraphData = {
  steps: [
    { id: "ask#m1", kind: "ask", label: "写", lane: "actor#many", phase: "phase#1" },
    {
      id: "ask#m2",
      kind: "ask",
      label: "改",
      lane: "actor#many",
      phase: "phase#2",
      source: "ask#m1",
    },
    { id: "ask#t1", kind: "ask", label: "评审", lane: "actor#team", phase: "phase#1" },
    { id: "ask#s1", kind: "ask", label: "汇总", lane: "actor#solo", phase: "phase#2" },
    { id: "world-read#1", kind: "world-read", label: "读稿", lane: "workspace", phase: "phase#1" },
  ],
  lanes: [
    { id: "actor#many", name: "写手" },
    { id: "actor#team", name: "评审" },
    { id: "actor#solo" },
    { id: "workspace" },
  ],
  participants: [
    { id: "phase#1:many", phase: "phase#1", lane: "actor#many", steps: ["ask#m1"], many: true },
    { id: "phase#2:many", phase: "phase#2", lane: "actor#many", steps: ["ask#m2"], many: true },
    {
      id: "phase#1:team#0",
      phase: "phase#1",
      lane: "actor#team",
      steps: ["ask#t1"],
      member: { index: 0, of: 3 },
    },
    {
      id: "phase#1:team#1",
      phase: "phase#1",
      lane: "actor#team",
      steps: ["ask#t1"],
      member: { index: 1, of: 3 },
    },
    {
      id: "phase#1:team#2",
      phase: "phase#1",
      lane: "actor#team",
      steps: ["ask#t1"],
      member: { index: 2, of: 3 },
    },
    { id: "phase#2:solo", phase: "phase#2", lane: "actor#solo", steps: ["ask#s1"] },
    { id: "phase#1:workspace", phase: "phase#1", lane: "workspace", steps: ["world-read#1"] },
  ],
  // 两端都会拆分的边会把交接表炸成乘积；这里各留一端拆分，替换逻辑照样走到。
  handoffs: [
    { from: "phase#1:team#0", to: "phase#1:many" },
    { from: "phase#2:many", to: "phase#2:solo" },
  ],
  phases: [
    { id: "phase#1", name: PHASE_ONE },
    { id: "phase#2", name: PHASE_TWO },
  ],
  phaseEdges: [{ from: "phase#1", to: "phase#2" }],
  exits: ["phase#2"],
};

type Node = WorkflowRunState["nodes"][number];
type Actor = WorkflowRunState["actors"][number];

/** 确定性伪随机：同一个种子每次生成同一条 run，失败可复现。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const NODE_PHASES = ["queued", "dispatched", "executing", "waiting", "settled"] as const;

/**
 * `solo` 车道上的实例数决定单卡走绑定还是拆分（1 张绑定、2 张拆分），两条路都要对拍。
 * actors 刻意**不按 ordinal 排**：认领顺序由算法自己排，顺序错了这里就会红。
 */
function wideRun(options: { solo: number; stamped: boolean; many?: number }): WorkflowRunState {
  const random = seeded(20260920);
  const many = options.many ?? 400;
  const stamp = (phaseName: string) => (options.stamped ? { phaseName } : {});
  const actors: Actor[] = [];
  const nodes: Node[] = [];
  for (let i = many; i >= 1; i -= 1) {
    // 前一半出生在 phase#1，后一半出生在 phase#2：两张 many 卡各认领一半。
    const born = i <= many / 2 ? PHASE_ONE : PHASE_TWO;
    actors.push({
      siteId: "actor#many",
      ordinal: i,
      status: "running",
      ...(i % 7 === 0 ? {} : { name: `写手${i}` }),
      ...stamp(born),
    });
    // 七分之一的实例一个节点都没有：它们按**自己的出生戳**归位（pending 药丸）。
    if (i % 7 === 0) continue;
    const count = 1 + Math.floor(random() * 3);
    for (let k = 0; k < count; k += 1) {
      const phase = NODE_PHASES[Math.floor(random() * NODE_PHASES.length)]!;
      nodes.push({
        siteId: "ask#m1",
        ordinal: k + 1,
        phase,
        ...(phase === "settled"
          ? { outcome: k % 5 === 0 ? ("failed" as const) : ("ok" as const) }
          : {}),
        actorSiteId: "actor#many",
        actorOrdinal: i,
        ...stamp(born),
      });
    }
    // 图里不存在的站点：叠加与认领都必须忽略它。
    if (i % 11 === 0) {
      nodes.push({
        siteId: "ask#gone",
        ordinal: 1,
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#many",
        actorOrdinal: i,
        ...stamp(born),
      });
    }
  }
  // 成员卡：车道上 4 个实例，`of` 是 3——多出来的那个不出卡。
  for (let i = 1; i <= 4; i += 1) {
    actors.push({ siteId: "actor#team", ordinal: i, status: "completed", ...stamp(PHASE_ONE) });
    nodes.push({
      siteId: "ask#t1",
      ordinal: 1,
      phase: "settled",
      outcome: i === 2 ? "failed" : "ok",
      actorSiteId: "actor#team",
      actorOrdinal: i,
      ...stamp(PHASE_ONE),
    });
  }
  for (let i = 1; i <= options.solo; i += 1) {
    actors.push({ siteId: "actor#solo", ordinal: i, status: "waiting", ...stamp(PHASE_TWO) });
  }
  // 游离节点：没有 actor（world-read），以及有 actorSiteId 却没有 ordinal 的旧载荷。
  nodes.push({ siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok" });
  nodes.push({
    siteId: "ask#m1",
    ordinal: 1,
    phase: "executing",
    actorSiteId: "actor#many",
    ...stamp(PHASE_ONE),
  });
  return {
    runId: "dwfrun-wide",
    toolCallId: "tool-wide",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: nodes.length },
    actors,
    nodes,
    lastEventSequence: nodes.length,
  };
}

/** 顺序敏感的对拍：`toEqual` 不看键序，卡序与状态表的键序都要自己比。 */
function expectSameView(actual: LiveParticipantView, expected: LiveParticipantView): void {
  expect(actual.graph.participants.map((participant) => participant.id)).toEqual(
    expected.graph.participants.map((participant) => participant.id),
  );
  expect(actual.graph.handoffs).toEqual(expected.graph.handoffs);
  expect(Object.keys(actual.participantStatuses)).toEqual(
    Object.keys(expected.participantStatuses),
  );
  expect(Object.keys(actual.instances)).toEqual(Object.keys(expected.instances));
  expect(actual).toEqual(expected);
}

describe("liveParticipantView · 索引化与参照实现对拍", () => {
  for (const solo of [1, 2]) {
    for (const stamped of [true, false]) {
      it(`宽 run 逐字节相同（solo=${solo}，${stamped ? "有" : "无"}阶段戳）`, () => {
        const run = wideRun({ solo, stamped });
        expectSameView(liveParticipantView(GRAPH, run), referenceLiveParticipantView(GRAPH, run));
      });
    }
  }

  it("拆分出的实例卡按 ordinal 升序，与 run.actors 的到达序无关", () => {
    const run = wideRun({ solo: 2, stamped: true });
    const ids = liveParticipantView(GRAPH, run)
      .graph.participants.filter((participant) => participant.id.startsWith("phase#1:many@"))
      .map((participant) => Number(participant.id.split("@")[1]));
    expect(ids.length).toBeGreaterThan(100);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
  });

  it("阶段再入：共享站点的两张 many 卡各认领自己那一半实例", () => {
    const view = liveParticipantView(GRAPH, wideRun({ solo: 1, stamped: true }));
    const count = (prefix: string) =>
      view.graph.participants.filter((participant) => participant.id.startsWith(prefix)).length;
    expect(count("phase#1:many@")).toBe(200);
    expect(count("phase#2:many@")).toBe(200);
  });

  it("无 run 时原样返回输入图（引用相等）", () => {
    const view = liveParticipantView(GRAPH, undefined);
    expect(view.graph).toBe(GRAPH);
    expect(view.instances).toEqual({});
  });
});

describe("buildWorkflowTimeline · 一对 (graph, run) 只建一次", () => {
  it("同一对对象两次调用返回同一个模型", () => {
    const run = wideRun({ solo: 1, stamped: true });
    expect(buildWorkflowTimeline(GRAPH, run)).toBe(buildWorkflowTimeline(GRAPH, run));
  });

  it("run 换了新对象就重建——投影每帧发新对象，身份是正确的键", () => {
    const first = wideRun({ solo: 1, stamped: true });
    const second = { ...first };
    const before = buildWorkflowTimeline(GRAPH, first);
    const after = buildWorkflowTimeline(GRAPH, second);
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  it("同一条 run 配两张图各建各的", () => {
    const run = wideRun({ solo: 1, stamped: true });
    const other: WorkflowCausalityGraphData = { ...GRAPH, exits: [] };
    expect(buildWorkflowTimeline(other, run)).not.toBe(buildWorkflowTimeline(GRAPH, run));
  });

  it("无 run 的静态图同样只建一次", () => {
    expect(buildWorkflowTimeline(GRAPH, undefined)).toBe(buildWorkflowTimeline(GRAPH, undefined));
  });
});
