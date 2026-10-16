import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  actorGraphToMermaid,
  analyzeWorkflowScript,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  serializeControlFlow,
  serializeCore,
  serializeHandoffGraph,
  siteGraphToMermaid,
  toActorGraph,
  type CausalityGraph,
  type ControlFlowGraph,
} from "../src/index.js";
import {
  serializeActorGraph,
  serializeCausalityGraph,
  serializeGraph,
} from "../src/analysis/serialize.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

// Fixture-driven site-graph tests: every tests/graphs/*.ts file must typecheck
// clean (9006 excepted — see corpusDiagnostics), and its serialized graph is
// snapshotted under tests/graphs/expected/. Four
// derived views are snapshotted alongside: the actor-graph projection as
// <name>.actor.txt (model-facing summary), the causality graph as
// <name>.causality.txt (the GUI's subject; see docs/analysis.md), the
// analysis core as <name>.core.txt (the one artifact every graph projects from;
// see docs/analysis.md — a fusion bug surfaces HERE, not
// only downstream), and the control-flow graph as <name>.cfg.txt (where execution
// can go next; docs/analysis.md).
// Run `pnpm test -- -u` to (re)generate snapshots, then review them by hand.
const graphsDir = join(dirname(fileURLToPath(import.meta.url)), "graphs");

/**
 * A `phase("…")` marker call or a `hole<T>(…)` call in the fixture source, ignoring `.phase` /
 * `.hole` property reads. A hole is a phase (docs/analysis.md「Sites」), so its presence opens the
 * phase vocabulary exactly as a marker does.
 */
const MARKER_CALL = /(^|[^.\w])(phase\s*\(|hole\s*<)/;

/**
 * The phase vocabulary is ALL-OR-NOTHING, asserted on every fixture in the corpus rather
 * than left to the eye on ~205 unchanged snapshots:
 *
 *  - no marker → `phases`, `phaseEdges` and every `Step.phase` absent, which is what makes
 *    the pre-phase snapshots byte-identical (a regression that emitted `phases: []` instead
 *    of nothing would pass the snapshots and break the UI's view-switch condition);
 *  - at least one marker → all three present, and every step carries exactly one phase
 *    drawn from the phase list — the spec's「划分是全的」invariant, mechanized.
 */
function assertPhaseVocabulary(source: string, causality: CausalityGraph, flow: ControlFlowGraph): void {
  if (!MARKER_CALL.test(source)) {
    expect(causality.phases).toBeUndefined();
    expect(causality.phaseEdges).toBeUndefined();
    expect(causality.steps.filter((step) => step.phase !== undefined)).toEqual([]);
    // The control-flow quotient rides the same all-or-nothing contract.
    expect(flow.phases).toBeUndefined();
    expect(flow.phaseEdges).toBeUndefined();
    return;
  }
  const phases = causality.phases ?? [];
  expect(phases.length).toBeGreaterThan(0);
  expect(causality.phaseEdges).toBeDefined();
  const ids = new Set(phases.map((phase) => phase.id));
  for (const step of causality.steps) {
    expect(ids.has(step.phase ?? ""), `step ${step.id} must name a listed phase`).toBe(true);
  }
  expect(flow.phases).toBeDefined();
  expect(flow.phaseEdges).toBeDefined();
  const flowIds = new Set((flow.phases ?? []).map((phase) => phase.id));
  for (const node of flow.nodes) {
    expect(flowIds.has(node.phase), `flow node ${node.id} must name a listed phase`).toBe(true);
  }
}

/**
 * Fixtures whose script contains a function NO call ever applies. Only such a body may be
 * swept to a `detached` region (docs/analysis.md): every function
 * value that reaches a call — as callee, through a parameter, or as a callback a library
 * invokes — is inlined where it is applied. A new `detached` anywhere else is a call the
 * oracle failed to record, i.e. the bug family this pins.
 */
const DEAD_CODE_FIXTURES = new Set(["callback-dead-function-sweep"]);

describe("site graph fixtures", () => {
  const fixtures = readdirSync(graphsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(fixture, async () => {
      const source = readFileSync(join(graphsDir, fixture), "utf8");
      const result = analyzeWorkflowScript(source);
      expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
      // `ok` 不在这里断言：语料里 26 个 fan-out fixture 用静态 actor 名，那是 9006
      // （不可提交但完全可分析，见 tests/helpers/analysis-corpus.ts）。真正的断言是下面
      // 两行——图与因果图都必须产出。
      const graph = result.graph;
      if (graph === undefined) throw new Error("expected a graph for a clean script");
      const causality = result.causality;
      if (causality === undefined) throw new Error("expected a causality graph for a clean script");
      const core = result.core;
      if (core === undefined) throw new Error("expected an analysis core for a clean script");
      const flow = result.flow;
      if (flow === undefined) throw new Error("expected a control-flow graph for a clean script");
      const handoff = result.handoff;
      if (handoff === undefined) throw new Error("expected a hand-off graph for a clean script");
      const base = fixture.replace(/\.ts$/, "");
      assertPhaseVocabulary(source, causality, flow);
      if (!DEAD_CODE_FIXTURES.has(base)) {
        const detached = core.trace.regions.filter((region) => region.detached === true);
        expect(detached, `${fixture}: only dead code may be swept to a detached region`).toEqual([]);
      }
      await expect(serializeGraph(graph)).toMatchFileSnapshot(join(graphsDir, "expected", `${base}.txt`));
      await expect(serializeActorGraph(toActorGraph(graph))).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.actor.txt`),
      );
      await expect(serializeCausalityGraph(causality)).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.causality.txt`),
      );
      await expect(serializeCore(core)).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.core.txt`),
      );
      await expect(serializeControlFlow(flow)).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.cfg.txt`),
      );
      // Who takes part in each phase and who hands off to whom — the board's second level
      // (docs/dynamic-workflow/presentation.md).
      await expect(serializeHandoffGraph(handoff, causality.lanes)).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.handoff.txt`),
      );
    });
  }
});

// Mermaid rendering: snapshot a representative subset only (not the whole corpus).
// Each is hand-justified against the fixture's .txt / .actor.txt / .causality.txt shape.
// `may-set-loop-alternating-receiver` is the regression guard for the symptom that
// motivated lane expansion: under the one-step rule one candidate lane had no homed step,
// the emitter culled it, and a two-player game rendered as a one-player game.
const MERMAID_FIXTURES = [
  "planner-reviewer",
  "glob-fanout",
  "within-fanout",
  "join-ports",
  "computed-index",
  "may-set-loop-alternating-receiver",
];

describe("mermaid rendering", () => {
  for (const base of MERMAID_FIXTURES) {
    it(base, async () => {
      const source = readFileSync(join(graphsDir, `${base}.ts`), "utf8");
      const result = analyzeWorkflowScript(source);
      expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
      const graph = result.graph;
      const causality = result.causality;
      if (graph === undefined || causality === undefined) {
        throw new Error("expected graphs for a clean script");
      }
      await expect(siteGraphToMermaid(graph)).toMatchFileSnapshot(join(graphsDir, "expected", `${base}.site.mmd`));
      await expect(actorGraphToMermaid(toActorGraph(graph))).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.actor.mmd`),
      );
      await expect(causalityGraphToMermaid(causality)).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.causality.mmd`),
      );
    });
  }
});

// The phase quotient's mermaid form: one fixture only. The phase vocabulary is a node,
// one arrow form and the sink terminal — far narrower than the step graph's, so the
// motivating example's real shape is the whole surface worth pinning. The control-flow
// quotient of the same fixture sits beside it (.phase-flow.mmd): the two diagrams are
// meant to be read together — "what must precede what" next to "where execution can go".
describe("phase mermaid rendering", () => {
  it("phase-jsonl-db", async () => {
    const source = readFileSync(join(graphsDir, "phase-jsonl-db.ts"), "utf8");
    const result = analyzeWorkflowScript(source);
    expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
    const causality = result.causality;
    const flow = result.flow;
    if (causality === undefined || flow === undefined) throw new Error("expected graphs for a clean script");
    await expect(phaseGraphToMermaid(causality)).toMatchFileSnapshot(
      join(graphsDir, "expected", "phase-jsonl-db.phase.mmd"),
    );
    await expect(phaseFlowToMermaid(flow)).toMatchFileSnapshot(
      join(graphsDir, "expected", "phase-jsonl-db.phase-flow.mmd"),
    );
  });
});

// The occurrence-level CFG and the hand-off graph in mermaid form (the portfolio's
// projection switcher, docs/chat/workflow-portfolio.md): three fixtures each, chosen for
// the vocabulary they exercise rather than breadth — the corpus-wide guard is the .cfg.txt
// / .handoff.txt snapshot above; these pin only the drawing conventions.
//  - CFG: phase subgraphs + marks + loops/exits/throws (phase-jsonl-db), a recursion SCC
//    folded into a `recur` self-loop (control-flow-recursive-helper), may-throw into a catch
//    and an uncaught throw to abort (control-flow-throw-in-catch), plus a detached body
//    (all-catch).
//  - hand-off: phases + literal-cardinality members + typed and back edges
//    (handoff-earth-v5), family-to-family fan-in with a `many` card
//    (handoff-family-to-family), mutual back edges from a may-set alternation
//    (handoff-mayset-two-cards).
const CFG_MERMAID_FIXTURES = [
  "phase-jsonl-db",
  "control-flow-recursive-helper",
  "control-flow-throw-in-catch",
  "all-catch",
];
const HANDOFF_MERMAID_FIXTURES = ["handoff-earth-v5", "handoff-family-to-family", "handoff-mayset-two-cards"];

describe("control-flow mermaid rendering", () => {
  for (const base of CFG_MERMAID_FIXTURES) {
    it(base, async () => {
      const source = readFileSync(join(graphsDir, `${base}.ts`), "utf8");
      const result = analyzeWorkflowScript(source);
      expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
      const flow = result.flow;
      if (flow === undefined) throw new Error("expected a control-flow graph for a clean script");
      await expect(controlFlowToMermaid(flow)).toMatchFileSnapshot(join(graphsDir, "expected", `${base}.cfg.mmd`));
    });
  }
});

describe("hand-off mermaid rendering", () => {
  for (const base of HANDOFF_MERMAID_FIXTURES) {
    it(base, async () => {
      const source = readFileSync(join(graphsDir, `${base}.ts`), "utf8");
      const result = analyzeWorkflowScript(source);
      expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
      const causality = result.causality;
      const handoff = result.handoff;
      if (causality === undefined || handoff === undefined) throw new Error("expected graphs for a clean script");
      await expect(handoffGraphToMermaid(handoff, causality)).toMatchFileSnapshot(
        join(graphsDir, "expected", `${base}.handoff.mmd`),
      );
    });
  }
});
