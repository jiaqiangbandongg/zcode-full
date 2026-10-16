import { describe, expect, it } from "vitest";
import {
  IMPLICIT_PHASE_ID,
  participantsOfPhase,
  withImplicitPhase,
} from "../src/components/workflow-graph/participant-model.js";
import {
  collapsePhaseStatus,
  findPhase,
  hasPhaseVocabulary,
  phaseMembers,
} from "../src/components/workflow-graph/phase-model.js";
import { phaseDisplayName, phaseNameMatches } from "../src/components/workflow-graph/phase-name.js";
import type {
  StepRunStatus,
  WorkflowCausalityGraphData,
  WorkflowStepData,
} from "../src/components/workflow-graph/types.js";

/**
 * 阶段层的纯选择器。这一层决定的事都是「画面说不说谎」级别的：无标记脚本合成哪一个模块、
 * 一个模块里有哪些卡、模块灯怎么折叠。下钻过滤（`filterGraphToPhase`）与名册（`phaseActors`）
 * 随 step 级渲染退役（docs/dynamic-workflow/presentation.md）——不要照旧把它们补回来。
 */

function step(
  overrides: Partial<WorkflowStepData> & { id: string; lane: string },
): WorkflowStepData {
  return { kind: "ask", label: overrides.id, ...overrides };
}

// 一段两阶段的图：preflight 里一次 world-read 加一次 ask，gate 里两个 actor 各一次 ask。
const GRAPH: WorkflowCausalityGraphData = {
  exits: ["phase#2"],
  handoffs: [
    { from: "phase#1:workspace", to: "phase#1:actor#1" },
    { from: "phase#2:actor#1", to: "phase#2:actor#2", types: ["Plan"] },
  ],
  lanes: [
    { id: "actor#1", line: 3, name: "optimizer" },
    { id: "actor#2", line: 4, name: "referee" },
    { id: "workspace" },
  ],
  participants: [
    { id: "phase#1:workspace", lane: "workspace", phase: "phase#1", steps: ["world-read#1"] },
    { id: "phase#1:actor#1", lane: "actor#1", phase: "phase#1", steps: ["ask#1"] },
    { id: "phase#2:actor#1", lane: "actor#1", phase: "phase#2", steps: ["ask#2"] },
    { id: "phase#2:actor#2", lane: "actor#2", phase: "phase#2", steps: ["ask#3"] },
  ],
  phaseEdges: [{ from: "phase#1", to: "phase#2" }],
  phases: [
    { id: "phase#1", line: 2, name: "preflight" },
    { id: "phase#2", line: 9, name: "gate" },
  ],
  sink: ["ask#2", "ask#3"],
  steps: [
    step({ id: "world-read#1", kind: "world-read", lane: "workspace", phase: "phase#1" }),
    step({ id: "ask#1", lane: "actor#1", phase: "phase#1" }),
    step({ id: "ask#2", lane: "actor#1", phase: "phase#2" }),
    step({ id: "ask#3", lane: "actor#2", phase: "phase#2" }),
  ],
};

/** 分析器对无标记脚本的输出：参与者恒带 `unphased`，阶段词汇表整体缺席。 */
const MARKERLESS: WorkflowCausalityGraphData = {
  handoffs: [{ from: "unphased:actor#1", to: "unphased:actor#2" }],
  lanes: [
    { id: "actor#1", name: "planner" },
    { id: "actor#2", name: "reviewer" },
  ],
  participants: [
    { id: "unphased:actor#1", lane: "actor#1", phase: "unphased", steps: ["ask#1"] },
    { id: "unphased:actor#2", lane: "actor#2", phase: "unphased", steps: ["ask#2"] },
  ],
  sink: ["ask#2"],
  steps: [step({ id: "ask#1", lane: "actor#1" }), step({ id: "ask#2", lane: "actor#2" })],
};

/** 假 formatter：策略本身与文案无关，所以直接回 key，断言读起来也更明确。 */
const formatMessage = (descriptor: { id: string }): string => descriptor.id;

describe("phase vocabulary", () => {
  it("is absent when the payload carries no phases at all", () => {
    expect(hasPhaseVocabulary(MARKERLESS)).toBe(false);
  });

  it("is absent when the vocabulary is present but empty", () => {
    // 整体降级（阶段数超上限）与「作者一个标记都没写」在 UI 眼里必须是同一件事。
    expect(hasPhaseVocabulary({ ...GRAPH, phaseEdges: [], phases: [] })).toBe(false);
  });

  it("is present as soon as the author said something", () => {
    expect(hasPhaseVocabulary(GRAPH)).toBe(true);
  });
});

describe("withImplicitPhase", () => {
  it("synthesizes a single `workflow` phase for a marker-less graph and rehomes everything into it", () => {
    const board = withImplicitPhase(MARKERLESS);

    expect(board.phases).toEqual([{ id: IMPLICIT_PHASE_ID }]);
    expect(board.phaseEdges).toEqual([]);
    // 有返回物 → 控制流在隐式阶段之后正常完成。
    expect(board.exits).toEqual([IMPLICIT_PHASE_ID]);
    expect(board.participants.map((participant) => participant.phase)).toEqual([
      IMPLICIT_PHASE_ID,
      IMPLICIT_PHASE_ID,
    ]);
    // 卡 id 不变：`unphased` 只是分析器的占位前缀，运行状态与检视器仍按原 id 找。
    expect(board.participants.map((participant) => participant.id)).toEqual([
      "unphased:actor#1",
      "unphased:actor#2",
    ]);
    expect(board.steps.every((member) => member.phase === IMPLICIT_PHASE_ID)).toBe(true);
    // 其余载荷原样：交接、车道、返回物。
    expect(board.handoffs).toEqual(MARKERLESS.handoffs);
    expect(board.lanes).toBe(MARKERLESS.lanes);
    expect(board.sink).toEqual(["ask#2"]);
    expect(hasPhaseVocabulary(board)).toBe(true);
  });

  it("has no exit when the script returns nothing", () => {
    const { sink: _sink, ...noSink } = MARKERLESS;
    expect(withImplicitPhase(noSink).exits).toEqual([]);
    expect(withImplicitPhase({ ...MARKERLESS, sink: [] }).exits).toEqual([]);
  });

  it("returns a graph with vocabulary untouched — by reference, so memo holds", () => {
    expect(withImplicitPhase(GRAPH)).toBe(GRAPH);
    // 空词汇表也算无：合成隐式阶段，而不是画一张空的阶段图。
    const empty = { ...GRAPH, phaseEdges: [], phases: [] };
    expect(withImplicitPhase(empty).phases).toEqual([{ id: IMPLICIT_PHASE_ID }]);
  });

  it("is idempotent", () => {
    const once = withImplicitPhase(MARKERLESS);
    expect(withImplicitPhase(once)).toBe(once);
  });

  it("names the implicit phase at render time, never in the payload", () => {
    expect(phaseDisplayName({ id: IMPLICIT_PHASE_ID }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.phase.workflow",
    );
  });
});

describe("participantsOfPhase", () => {
  it("buckets by phase, keeping the payload's hand-off order", () => {
    expect(participantsOfPhase(GRAPH, "phase#1").map((participant) => participant.id)).toEqual([
      "phase#1:workspace",
      "phase#1:actor#1",
    ]);
    expect(participantsOfPhase(GRAPH, "phase#2").map((participant) => participant.id)).toEqual([
      "phase#2:actor#1",
      "phase#2:actor#2",
    ]);
  });

  it("is empty for a phase with no cards, and for an unknown phase", () => {
    expect(participantsOfPhase(GRAPH, "phase#404")).toEqual([]);
    // 分析器给的 `unphased` 在无标记图上不是阶段：先合成隐式阶段才有卡可分。
    expect(participantsOfPhase(MARKERLESS, IMPLICIT_PHASE_ID)).toEqual([]);
    expect(participantsOfPhase(withImplicitPhase(MARKERLESS), IMPLICIT_PHASE_ID)).toHaveLength(2);
  });
});

describe("phase membership and naming", () => {
  it("buckets steps by their phase, keeping the phase table's order", () => {
    const members = phaseMembers(GRAPH);

    expect([...members.keys()]).toEqual(["phase#1", "phase#2"]);
    expect(members.get("phase#1")?.map((member) => member.id)).toEqual(["world-read#1", "ask#1"]);
    expect(members.get("phase#2")?.map((member) => member.id)).toEqual(["ask#2", "ask#3"]);
  });

  it("finds a phase by id for the inspector's naming material", () => {
    expect(findPhase(GRAPH, "phase#2")?.name).toBe("gate");
    expect(findPhase(GRAPH, "phase#404")).toBeUndefined();
    expect(findPhase(MARKERLESS, IMPLICIT_PHASE_ID)).toBeUndefined();
  });

  it("shows the author's word", () => {
    expect(phaseDisplayName(GRAPH.phases![1]!, formatMessage)).toBe("gate");
    expect(phaseDisplayName(GRAPH.phases![0]!, formatMessage)).toBe("preflight");
  });

  it("localizes the synthetic `unphased` phase, which has no name of its own", () => {
    expect(phaseDisplayName({ id: "unphased" }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.phase.unphased",
    );
  });
});

describe("phase status re-collapse", () => {
  const members = [step({ id: "a", lane: "actor#1" }), step({ id: "b", lane: "actor#1" })];
  const collapse = (a: StepRunStatus, b: StepRunStatus) => collapsePhaseStatus(members, { a, b });

  it("reports running first — the reader's first question is whether it still moves", () => {
    expect(collapse("failed", "running")).toBe("running");
    expect(collapse("done", "running")).toBe("running");
  });

  it("reports failed once nothing runs any more", () => {
    expect(collapse("done", "failed")).toBe("failed");
  });

  it("reports done only when every member settled cleanly; settled + queued is running", () => {
    expect(collapse("done", "done")).toBe("done");
    expect(collapse("done", "pending")).toBe("running");
  });

  it("ignores members without an entry: a branch the run did not take is absent, not pending", () => {
    expect(collapsePhaseStatus(members, { a: "done" })).toBe("done");
  });

  it("has no dot at all in the static view", () => {
    expect(collapsePhaseStatus(members, undefined)).toBeUndefined();
    // 叠加在场但这个阶段一个成员都没被观察到：同样不点亮，而不是谎报 pending。
    expect(collapsePhaseStatus(members, {})).toBeUndefined();
  });
});

/**
 * display 名 ↔ 运行时名的唯一关联规则（docs/dynamic-workflow/presentation.md
 * 2026-09-09「名字关联」）：进入记录、`currentPhase`、实例的出生戳三处共用它。
 */
describe("phaseNameMatches", () => {
  const long = "x".repeat(128);

  it("matches the same word", () => {
    expect(phaseNameMatches("attempt", "attempt")).toBe(true);
    expect(phaseNameMatches("attempt", "gate")).toBe(false);
  });

  it("falls back to a prefix only when the display name really was truncated", () => {
    // display 名恰好顶到上界（128）→ 线上的完整名以它开头就算同一个阶段。
    expect(phaseNameMatches(long, `${long}yyy`)).toBe(true);
    // 没顶到上界的短名不做前缀匹配：「计划」不认「计划修复」。
    expect(phaseNameMatches("计划", "计划修复")).toBe(false);
    // 方向不能反：线上名是被截断的那一侧时不匹配。
    expect(phaseNameMatches(`${long}yyy`, long)).toBe(false);
  });

  it("says no when either side has no name — matching needs two names", () => {
    // 「无名」不是一个可匹配的名字；无名 display 阶段与无戳实例的配对是 `phasesOf` 的事。
    expect(phaseNameMatches(undefined, "attempt")).toBe(false);
    expect(phaseNameMatches("attempt", undefined)).toBe(false);
    expect(phaseNameMatches(undefined, undefined)).toBe(false);
  });
});
