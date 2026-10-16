import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript, type CausalityGraph, type OrderEdge } from "../src/index.js";
import { reduceOrdering, type OrderKind } from "../src/analysis/causality-reduce.js";
import { serializeCausalityGraph } from "../src/analysis/serialize.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

/**
 * Behavioural tests for the causality graph. The fixture snapshots in graphs.test.ts
 * pin the whole corpus; these pin the CLAIMS the design rests on, so a silent change in
 * the reduction or the ordering rules fails with a readable message rather than a
 * 179-file snapshot diff. Each block cites the worked example in
 * docs/analysis.md it is derived from.
 */

const graphsDir = join(dirname(fileURLToPath(import.meta.url)), "graphs");

function causalityOf(fixture: string): CausalityGraph {
  const source = readFileSync(join(graphsDir, `${fixture}.ts`), "utf8");
  const result = analyzeWorkflowScript(source);
  expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
  const causality = result.causality;
  if (causality === undefined) throw new Error(`no causality graph for ${fixture}`);
  return causality;
}

const arrows = (graph: CausalityGraph): string[] =>
  graph.edges.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`);

describe("worked example 1: the full vocabulary (planner-reviewer)", () => {
  const graph = causalityOf("planner-reviewer");

  it("draws exactly the arrows the spec derives", () => {
    // Five step-to-step arrows plus two into the returned artifact — the seven of
    // worked example 1, and nothing else.
    expect(arrows(graph)).toEqual([
      "ask#1 -seq-> ask#2", // scan → plan: ordering only, no dependency
      "ask#1 -data-> ask#4", // scan → judge: survives BECAUSE reduction is typed
      "ask#2 -data-> ask#3", // plan → review
      "ask#3 -carry-> ask#2", // review → plan: the loop's back edge
      "ask#3 -seq-> ask#4", // review → judge: the loop must finish first
    ]);
    expect(graph.sink?.fedBy).toEqual(["ask#2", "ask#4"]);
  });

  it("drops the incidental chords a uniform reduction would keep", () => {
    // scan → review is implied by scan → plan → review; plan → judge by plan → review
    // → judge. Both are `seq`, so any longer path removes them.
    expect(arrows(graph)).not.toContain("ask#1 -seq-> ask#3");
    expect(arrows(graph)).not.toContain("ask#2 -seq-> ask#4");
  });

  it("drops the phantom producer→sink edge the actor projection emitted", () => {
    // `scanner → sink` disappears because `scanner →data judge →data sink` carries it.
    expect(graph.sink?.fedBy).not.toContain("ask#1");
  });

  it("keeps the loop body `always` because the literal bound is positive", () => {
    // Finding (a): a blanket "inside a loop ⇒ maybe" would mislabel this.
    const plan = graph.steps.find((step) => step.id === "ask#2");
    expect(plan?.certainty).toBe("always");
    expect(graph.regions.find((region) => region.kind === "loop")?.bound).toBe(5);
  });

  it("makes actors lanes, never nodes, and marks the fan-out lane a family", () => {
    expect(graph.lanes.map((lane) => lane.id)).toEqual(["actor#1", "actor#2", "actor#3", "actor#4"]);
    expect(graph.lanes.find((lane) => lane.id === "actor#4")?.families).toEqual(["fanout#1"]);
  });
});

describe("worked example 3: sequence inside one lane", () => {
  const graph = causalityOf("emission-graph-same-actor-self-edge");

  it("chains three asks on one lane, with no transitive chord", () => {
    // Finding (b): `data` outranks the co-existing fifo/seq claims on assess → refine,
    // and `fifo` outranks `seq` on refine → wrap up, so neither reads as missed
    // parallelism. The assess → wrap up chord is reduced away.
    expect(arrows(graph)).toEqual(["ask#1 -data-> ask#2", "ask#2 -fifo-> ask#3"]);
  });
});

describe("worked example 4: the motivating pair", () => {
  const concurrent = causalityOf("order-map-concurrent");
  const sequential = causalityOf("order-forof-sequential");

  it("splits on concurrency, not cardinality (finding (f))", () => {
    const stacked = concurrent.steps.find((step) => step.kind === "ask");
    const serial = sequential.steps.find((step) => step.kind === "ask");
    expect(stacked?.repeat).toBe("stack");
    expect(serial?.repeat).toBe("serial");
  });

  it("gives the sequential form a self-arrow and the concurrent form none", () => {
    expect(arrows(sequential)).toContain("ask#1 -carry-> ask#1");
    expect(arrows(concurrent).filter((arrow) => arrow.includes("ask#1 -carry-> ask#1"))).toEqual([]);
  });

  it("agrees on everything else — same lanes, same data edge", () => {
    expect(concurrent.lanes.map((lane) => lane.id)).toEqual(sequential.lanes.map((lane) => lane.id));
    expect(arrows(concurrent)).toContain("world-read#1 -data-> ask#1");
    expect(arrows(sequential)).toContain("world-read#1 -data-> ask#1");
  });
});

describe("worked example 5: a Promise.all that does not parallelize", () => {
  it("orders two un-awaited asks on ONE actor (the mailbox serializes them)", () => {
    expect(arrows(causalityOf("order-unawaited-one-actor"))).toEqual(["ask#1 -fifo-> ask#2"]);
  });

  it("leaves two un-awaited asks on DIFFERENT actors incomparable", () => {
    // Concurrency is incomparability in the partial order: arrow versus no arrow is the
    // carrier, which is why collapsing to one arrow style costs nothing here.
    expect(arrows(causalityOf("order-unawaited-two-actors"))).toEqual([]);
  });
});

describe("worked example 6: missed parallelism through helpers", () => {
  it("reads as a straight line, with the data edges surviving reduction", () => {
    expect(arrows(causalityOf("helper-flow-through"))).toEqual([
      "ask#1 -seq-> ask#2", // pure serialization: could have run concurrently
      "ask#1 -data-> ask#3", // survives even though ask#1 → ask#2 → ask#3 implies it
      "ask#2 -seq-> ask#3",
      "ask#2 -data-> ask#4",
      "ask#3 -seq-> ask#4",
    ]);
  });
});

describe("worked example 7: recursion", () => {
  const graph = causalityOf("helper-recursive");

  it("turns the call-graph SCC into a loop region, never unrolling it", () => {
    const loop = graph.regions.find((region) => region.kind === "loop");
    expect(loop?.label).toBe("dig");
    expect(arrows(graph)).toContain("ask#1 -carry-> ask#1");
  });

  it("records the base case as `maybe` without drawing anything for it", () => {
    expect(graph.steps.find((step) => step.id === "ask#1")?.certainty).toBe("maybe");
  });
});

describe("worked example 8: nested fan-outs multiply", () => {
  it("gives the lane a LIST of families, since a single id cannot express a product", () => {
    // Finding (e). Lexical `within` misses this entirely — the ask sits in a helper.
    const graph = causalityOf("nested-fanout-reach");
    expect(graph.lanes.find((lane) => lane.id === "actor#1")?.families).toEqual([
      "fanout#1",
      "fanout#2",
    ]);
    expect(graph.steps.find((step) => step.id === "ask#1")?.repeat).toBe("stack");
  });
});

describe("worked example 9: the workspace is a lane", () => {
  it("gives every world read its own step, positioned in time", () => {
    const graph = causalityOf("actor-agent-to-workspace");
    expect(arrows(graph)).toEqual([
      "ask#1 -data-> world-read#1",
      "world-read#1 -data-> ask#2",
    ]);
    expect(graph.steps.map((step) => step.lane)).toEqual(["actor#1", "workspace", "actor#2"]);
  });
});

describe("worked example 10: a dynamically-selected actor", () => {
  const graph = causalityOf("actor-or-aggregation-and-context-dissolve");

  it("expands the may-set into one copy per candidate lane", () => {
    // The spanning-card drawing is superseded by may-set lane expansion: what finding (d)
    // rejected was the ACTOR graph's cross-product of messages, and a duplicated step
    // carrying `maybe` claims strictly less than that.
    const copies = graph.steps.filter((step) => step.source === "ask#2");
    expect(copies.map((step) => step.id)).toEqual(["ask#2~actor#1", "ask#2~actor#2"]);
    expect(copies.map((step) => step.lane)).toEqual(["actor#1", "actor#2"]);
    expect(copies.every((step) => step.lanes?.join() === "actor#1,actor#2")).toBe(true);
    expect(graph.steps.find((step) => step.id === "ask#2")).toBeUndefined();
  });

  it("attaches the `maybe` FIFO edge to the same-lane copy alone", () => {
    // The copy on beta has no mailbox relation to `a`, so the cross-lane pair is dropped
    // rather than duplicated — the shape is crisper than the single card's `fifo maybe`.
    const fifo = graph.edges.filter((edge) => edge.kind === "fifo");
    expect(fifo).toEqual([
      { certainty: "maybe", from: "ask#2~actor#1", kind: "fifo", to: "ask#3" },
    ]);
  });
});

describe("await resolution and widening", () => {
  it("resolves a stored promise's settle exactly through the taint oracle", () => {
    // Phase 1 widened here (`await held` issues nothing), so ask#1 -> ask#3 was `maybe`.
    // Phase 2's oracle reads a SINGLE exact witness off the awaited operand, which is the
    // settle-certainty rule's `always` case.
    const graph = causalityOf("order-stored-promise-late-await");
    expect(graph.edges).toEqual([
      { certainty: "always", from: "ask#1", kind: "seq", to: "ask#3" },
      { certainty: "always", from: "ask#2", kind: "seq", to: "ask#3" },
    ]);
  });

  it("resolves a promise awaited inside a helper, through the parameter placeholder", () => {
    const graph = causalityOf("order-promise-into-helper");
    expect(graph.edges).toEqual([
      { certainty: "always", from: "ask#1", kind: "seq", to: "ask#3" },
      { certainty: "always", from: "ask#2", kind: "seq", to: "ask#3" },
    ]);
  });

  it("keeps `maybe` when the awaited promise has more than one witness", () => {
    // A dynamically-selected promise resolves to BOTH candidates and only one of them
    // settles at runtime, so the multi-witness half of the settle-certainty rule applies —
    // the same two `maybe` edges phase 1's full-barrier widening produced.
    const graph = causalityOf("order-dynamic-promise-await");
    expect(graph.edges.every((edge) => edge.certainty === "maybe")).toBe(true);
    expect(graph.edges).toHaveLength(2);
  });

  it("settles a stored promise joined with a fresh one (phase 1 invented concurrency)", () => {
    // The awaited expression issues the fresh ask, so phase 1 never widened AND never
    // settled `held` — leaving ask#1 incomparable with ask#3, which is concurrency the
    // script does not have. The join oracle settles it as a may-claim (`Promise.race`
    // shares the join machinery, so settle-all would be unsound).
    const graph = causalityOf("order-mixed-join-stored-promise");
    expect(graph.edges).toEqual([
      { certainty: "maybe", from: "ask#1", kind: "seq", to: "ask#3" },
      { certainty: "always", from: "ask#2", kind: "seq", to: "ask#3" },
    ]);
  });

  it("never settles a step before it is issued (the temporal invariant)", () => {
    // `first.steps.push(extra)` merges ask#2's label into the slot `plan` denotes, so the
    // flow-insensitive oracle offers ask#2 as a witness at the EARLIER `await plan`. That
    // settle is temporally impossible; admitting it cost the await its singleton-exact
    // certainty and demoted a true `data always` edge through the min-certainty dedup.
    const graph = causalityOf("async-promise-double-await-mutate");
    expect(arrows(graph)).toEqual([
      "ask#1 -seq-> ask#2",
      "ask#1 -data-> ask#3",
      "ask#2 -data-> ask#3",
    ]);
    const certainty = (from: string, to: string) =>
      graph.edges.find((edge) => edge.from === from && edge.to === to)?.certainty;
    expect(certainty("ask#1", "ask#2")).toBe("always");
    expect(certainty("ask#2", "ask#3")).toBe("always");
    expect(certainty("ask#1", "ask#3")).toBe("always");
  });

  it("still settles across iterations, where repetition realizes it", () => {
    // The carve-out to the invariant. `await acc` awaits the PREVIOUS round's ask, which is
    // not yet issued in this linear walk but is realizable by repetition (both ends share
    // the fan-out region). A bare already-issued test drops it and the step's cue reverts
    // to `stack` — N concurrent instances for a chain the script serializes.
    const graph = causalityOf("reduce-accumulator");
    expect(graph.steps.find((step) => step.id === "ask#1")?.repeat).toBe("serial");
  });

  it("never claims CERTAINTY for a settle only repetition realizes", () => {
    // A loop whose head awaits the promise its tail issued. The claim fails at both ends:
    // iteration 1 awaits the initial value and settles nothing, and the last iteration's
    // issue escapes the loop unawaited, so that instance is still pending when ask#2
    // issues. `always` here would assert a post-loop ordering the final instance violates.
    const graph = causalityOf("order-loop-head-await-tail-issue");
    const post = graph.edges.find((edge) => edge.from === "ask#1" && edge.to === "ask#2");
    expect(post).toMatchObject({ certainty: "maybe", kind: "seq" });
    // The demotion must not cost the multiplicity cue: settledInside records the step
    // whatever the settle event's certainty.
    expect(graph.steps.find((step) => step.id === "ask#1")?.repeat).toBe("serial");
  });
});

describe("control dependence", () => {
  it("emits a control edge into a guarded ask and drops its certainty", () => {
    const graph = causalityOf("order-control-guarded-ask");
    expect(arrows(graph)).toEqual(["ask#1 -control-> ask#2"]);
    expect(graph.steps.find((step) => step.id === "ask#2")?.certainty).toBe("maybe");
    expect(graph.regions.map((region) => region.kind)).toEqual(["seq", "branch"]);
  });

  it("finds a controller the syntactic symbol map cannot see (the taint oracle)", () => {
    // `const ok = t.escalate` issues nothing, so phase 1 associated no step with `ok` and
    // drew a bare `seq` arrow. The oracle carries ask#1's label through the field read.
    const graph = causalityOf("order-derived-guard-control");
    expect(arrows(graph)).toEqual(["ask#1 -control-> ask#2"]);
    expect(graph.steps.find((step) => step.id === "ask#2")?.certainty).toBe("maybe");
  });

  it("keeps the syntactic controller the oracle cannot see (implicit flow)", () => {
    // `flag` is 1 or 2 — a ternary condition does not join the data contract, so the
    // oracle has nothing on this guard. The union is what preserves the edge; replacing
    // the syntactic scan would regress it.
    const graph = causalityOf("order-implicit-flow-guard");
    expect(arrows(graph)).toEqual(["ask#1 -control-> ask#2"]);
    expect(graph.steps.find((step) => step.id === "ask#2")?.certainty).toBe("maybe");
  });
});

describe("loop repetition", () => {
  it("closes a two-step loop between the steps, with no self-arrow", () => {
    const graph = causalityOf("order-loop-two-steps-carry");
    expect(arrows(graph)).toEqual(["ask#1 -data-> ask#2", "ask#2 -carry-> ask#1"]);
    expect(graph.steps.every((step) => step.repeat === "serial")).toBe(true);
  });

  it("keeps the self-arrow when the loop carries no data at all", () => {
    // The ordering between consecutive iterations produces it, not the data.
    expect(arrows(causalityOf("order-loop-carries-nothing"))).toEqual(["ask#1 -carry-> ask#1"]);
  });

  it("serializes an un-awaited loop on a fixed actor, but stacks a fresh one", () => {
    const fixed = causalityOf("order-loop-unawaited-fixed-actor");
    const fresh = causalityOf("order-loop-unawaited-fresh-actor");
    expect(fixed.steps.find((step) => step.kind === "ask")?.repeat).toBe("serial");
    expect(arrows(fixed)).toContain("ask#1 -carry-> ask#1");
    expect(fresh.steps.find((step) => step.kind === "ask")?.repeat).toBe("stack");
    expect(arrows(fresh)).not.toContain("ask#1 -carry-> ask#1");
  });
});

describe("impossible back edges", () => {
  const graph = causalityOf("game-planner-reviewer");

  it("drops a backwards data fact whose target cannot run again", () => {
    // The site graph's data edges are variable-level, so the reassigned `let plan`
    // yields the full writers × readers cross product: the in-loop revision (ask#3)
    // gets a data fact into the PRE-LOOP review (ask#2), which reads `plan`. ask#2 runs
    // once, before the loop, so no execution realizes it. Because the fact points
    // backwards it used to be retyped `carry` — the one class reduction never touches.
    expect(arrows(graph)).not.toContain("ask#3 -carry-> ask#2");
  });

  it("keeps the carry that closes the refinement cycle, and only that one", () => {
    expect(arrows(graph)).toContain("ask#4 -carry-> ask#3"); // the refinement cycle
    // ask#3 also reads its own last plan, but that self-carry asserts nothing on top
    // of ask#3 -data-> ask#4 -carry-> ask#3: carry minimization drops it
    // (docs/analysis.md, "Typed transitive reduction" step 3).
    expect(arrows(graph)).not.toContain("ask#3 -carry-> ask#3");
  });

  it("leaves a two-agent refinement loop reading as one chain plus its cycle", () => {
    // Four arrows for four steps, down from ten: every surviving arrow asserts an
    // order nothing else in the picture asserts — the carries included.
    expect(arrows(graph)).toEqual([
      "ask#1 -data-> ask#2", // initial plan → initial review
      "ask#2 -control-> ask#3", // the verdict decides whether revision happens
      "ask#3 -data-> ask#4", // revised plan → re-review
      "ask#4 -carry-> ask#3", // …whose verdict feeds the next revision
    ]);
  });
});

describe("phase-1 scope", () => {
  it("ships one step per site, even for a helper called twice", () => {
    // Phase 3's site specialization turns this into `ask#1/1` + `ask#1/2`.
    const graph = causalityOf("order-helper-ask-two-call-sites");
    expect(graph.steps.map((step) => step.id)).toEqual(["ask#1"]);
  });

  it("is deterministic: the same script serializes identically every time", () => {
    const source = readFileSync(join(graphsDir, "planner-reviewer.ts"), "utf8");
    const first = analyzeWorkflowScript(source).causality as CausalityGraph;
    const second = analyzeWorkflowScript(source).causality as CausalityGraph;
    expect(serializeCausalityGraph(first)).toBe(serializeCausalityGraph(second));
  });

  it("emits no `parallel` or `shared` regions (parallel stays derived)", () => {
    const graph = causalityOf("planner-reviewer");
    expect(graph.regions.every((region) => region.kind !== "parallel" && region.kind !== "shared"))
      .toBe(true);
  });
});

describe("may-set lane expansion", () => {
  it("draws an alternating receiver as the carry cycle between its two copies", () => {
    // The motivating script: the ONLY ask site is `(turn ? black : white).ask(…)`, so
    // under the one-step rule one candidate lane had zero homed steps and the emitter
    // culled it — a two-player game read as a one-player game. Both lanes are now homed.
    const graph = causalityOf("may-set-loop-alternating-receiver");
    expect(graph.steps.map((step) => step.id)).toEqual(["ask#1~actor#1", "ask#1~actor#2"]);
    expect(graph.steps.map((step) => step.lane)).toEqual(["actor#1", "actor#2"]);
    // The self-carry becomes the full k×k product: the alternation cycle, plus a
    // self-loop per copy because the same candidate may be selected twice in a row.
    expect(arrows(graph)).toEqual([
      "ask#1~actor#1 -carry-> ask#1~actor#1",
      "ask#1~actor#1 -carry-> ask#1~actor#2",
      "ask#1~actor#2 -carry-> ask#1~actor#1",
      "ask#1~actor#2 -carry-> ask#1~actor#2",
    ]);
    expect(graph.sink?.fedBy).toEqual(["ask#1~actor#1", "ask#1~actor#2"]);
  });

  it("inherits `repeat` and `region`, and keeps the full may-set on every copy", () => {
    const graph = causalityOf("may-set-loop-alternating-receiver");
    for (const step of graph.steps) {
      expect(step).toMatchObject({
        certainty: "maybe",
        kind: "ask",
        label: "ask",
        lanes: ["actor#1", "actor#2"],
        region: "loop#1",
        repeat: "serial",
        source: "ask#1",
      });
      // One textual ask, so one `loc` — this is what tells the reader they are copies.
      expect(step.loc).toEqual({ column: 40, line: 12 });
    }
  });

  it("forces `maybe` on copies of an `always` step", () => {
    // The ask always runs; each COPY may not. Certainty is per-node and the node changed
    // meaning, so this is the one field expansion overrides rather than inherits.
    const graph = causalityOf("may-set-oneshot-ternary");
    expect(graph.steps.find((step) => step.id === "ask#1")?.certainty).toBe("always");
    const copies = graph.steps.filter((step) => step.source === "ask#2");
    expect(copies.map((step) => step.certainty)).toEqual(["maybe", "maybe"]);
    // No enclosing iteration region, so nothing carries: a plain data fan-out.
    expect(arrows(graph)).toEqual([
      "ask#1 -data-> ask#2~actor#1",
      "ask#1 -data-> ask#2~actor#2",
    ]);
    expect(copies.every((step) => step.repeat === undefined)).toBe(true);
  });

  it("expands a `fifo` edge lane-matched, dropping the cross-lane pair", () => {
    // A cross-lane fifo copy would claim a mailbox relation that cannot exist, while
    // `data` cannot tell which candidate produced the value and so fans out fully.
    const graph = causalityOf("may-set-fifo-against-fixed-lane");
    expect(arrows(graph)).toEqual([
      "ask#1 -data-> ask#2~actor#1",
      "ask#1 -data-> ask#2~actor#2",
      "ask#1 -data-> ask#3",
      "ask#2~actor#1 -fifo-> ask#3",
    ]);
    expect(graph.steps.find((step) => step.id === "ask#3")?.lanes).toBeUndefined();
    expect(graph.sink?.fedBy).toEqual(["ask#2~actor#1", "ask#2~actor#2", "ask#3"]);
  });

  it("falls back to one card past the cap, rather than truncating the may-set", () => {
    // Five candidates: `lanes` is kept in full and the step keeps today's single card in
    // `lanes[0]`, with no `source` — dropping candidates would be a claim the analysis
    // cannot make, and five copies multiply steps and edges past what a reader can follow.
    const graph = causalityOf("may-set-over-cap");
    const step = graph.steps.find((s) => s.label === "picked");
    expect(step?.id).toBe("ask#2");
    expect(step?.source).toBeUndefined();
    expect(step?.lane).toBe("actor#1");
    expect(step?.lanes).toHaveLength(5);
    expect(arrows(graph)).toEqual(["ask#1 -data-> ask#2"]);
  });

  it("re-applies endpoint inheritance, so no edge touching a copy stays `always`", () => {
    // Expansion forces a copy to `maybe`, and an edge inherits the weaker certainty of its
    // endpoints — so re-deriving after the rewrite is what keeps the two rules consistent.
    // Stated as the invariant over every may-set fixture rather than per-fixture, because
    // it is the rule that matters, not the individual demotions.
    for (const fixture of [
      "may-set-oneshot-ternary",
      "may-set-loop-alternating-receiver",
      "may-set-fifo-against-fixed-lane",
      "actor-or-aggregation-and-context-dissolve",
      "actor-nonsingleton-lane-computed",
      "actor-may-pick-inside-fanout",
      "agent-array-indexed-selection",
      "conditional-receiver-may-set",
      "emission-graph-may-receiver-overlap-context",
    ]) {
      const graph = causalityOf(fixture);
      const copies = new Set(
        graph.steps.filter((step) => step.source !== undefined).map((step) => step.id),
      );
      const incident = graph.edges.filter(
        (edge) => copies.has(edge.from) || copies.has(edge.to),
      );
      expect(incident.length).toBeGreaterThan(0);
      expect(incident.filter((edge) => edge.certainty !== "maybe")).toEqual([]);
    }
  });

  it("agrees with the branch form on certainty (refactoring invariance)", () => {
    // `(cond ? a : b).ask(p)` and `cond ? a.ask(p) : b.ask(p)` are the same program, which
    // is the whole premise of expansion — so they must draw the same certainty. This is the
    // argument that fixes the edge rule to endpoint inheritance re-applied: preserving an
    // `always` edge into a copy would make two identical programs disagree.
    //
    // Edge KIND and region legitimately differ and are NOT part of the claim: the branch
    // form's guard yields `control` edges and its own `branch` regions, where the receiver
    // -selection form yields `data` out of the taint oracle inside one `seq` region.
    const expanded = causalityOf("may-set-oneshot-ternary");
    const branch = causalityOf("may-set-branch-form-parity");
    const receivers = (graph: CausalityGraph): string[] =>
      graph.steps
        .filter((step) => step.lane !== "actor#3")
        .map((step) => `${step.lane} ${step.certainty}`)
        .sort();
    expect(receivers(expanded)).toEqual(["actor#1 maybe", "actor#2 maybe"]);
    expect(receivers(branch)).toEqual(receivers(expanded));
    for (const graph of [expanded, branch]) {
      const fromSeed = graph.edges.filter((edge) => edge.from === "ask#1");
      expect(fromSeed).toHaveLength(2);
      expect(fromSeed.filter((edge) => edge.certainty !== "maybe")).toEqual([]);
      expect(graph.sink?.fedBy).toHaveLength(2);
    }
  });

  it("emits `source` only on copies, so untouched fixtures are unperturbed", () => {
    // The field is what a downstream consumer joins runtime instances on, so a step that
    // did not expand must not carry it — `source` would then duplicate `id` exactly.
    for (const fixture of ["planner-reviewer", "may-set-over-cap", "order-loop-two-steps-carry"]) {
      expect(causalityOf(fixture).steps.every((step) => step.source === undefined)).toBe(true);
    }
  });

  it("expands within the lane list the pre-expansion pass already computed", () => {
    // Expansion is a rewrite of the FINISHED graph: it homes steps in lanes that were
    // always in the list (every candidate contributes one), so it adds no lane and
    // removes none, and the region tree is untouched.
    const graph = causalityOf("may-set-loop-alternating-receiver");
    expect(graph.lanes.map((lane) => lane.id)).toEqual(["actor#1", "actor#2"]);
    expect(graph.regions.map((region) => region.id)).toEqual(["seq#1", "loop#1"]);
  });
});

describe("interpolated actor names", () => {
  // docs/analysis.md, "Labels and names". The five outcomes are pinned
  // by name here rather than only by the fixture snapshot, because each one encodes a
  // separate judgement and a snapshot diff cannot say which of them regressed.
  const graph = causalityOf("interpolated-actor-name");
  const laneNamed = (id: string) => graph.lanes.find((lane) => lane.id === id);

  it("takes the literal run before the first hole", () => {
    expect(laneNamed("actor#1")?.namePattern).toEqual({ head: "研究员" });
  });

  it("takes the literal run after the last hole", () => {
    expect(laneNamed("actor#2")?.namePattern).toEqual({ tail: "-worker" });
  });

  it("takes both affixes when the template has literal text on each side", () => {
    expect(laneNamed("actor#3")?.namePattern).toEqual({ head: "a", tail: "b" });
  });

  it("drops literal middles rather than rendering the expression", () => {
    // `pre${x}mid${y}post` is a name on a row, not a rendering of the template that
    // produced it — `mid` would only be readable as `pre…mid…post`.
    expect(laneNamed("actor#4")?.namePattern).toEqual({ head: "pre", tail: "post" });
  });

  it("leaves a lane anonymous when the affixes carry nothing to read", () => {
    // Whitespace-only trims to empty; `-` has no letter or digit, and `…-` is strictly
    // worse than the localized anonymous fallback.
    expect(laneNamed("actor#5")?.namePattern).toBeUndefined();
    expect(laneNamed("actor#6")?.namePattern).toBeUndefined();
  });

  it("never displaces a real name with a pattern", () => {
    // A literal argument and a `const` binding name are both names; the pattern is the
    // last resort, so no lane may carry both.
    for (const lane of graph.lanes) {
      if (lane.namePattern !== undefined) expect(lane.name).toBeUndefined();
    }
  });

  it("gives the inline receiver's step the same pattern", () => {
    // `askLabel` answers the bare "ask" for an inline `agent(...)` receiver, so the card
    // is exactly as uninformative as the lane head was.
    const first = graph.steps.find((step) => step.id === "ask#1");
    expect(first?.label).toBe("ask");
    expect(first?.labelPattern).toEqual({ head: "研究员" });
  });

  it("leaves an identifier receiver's label alone", () => {
    // `chiefEditor.ask(...)` already produced a real label; there is nothing to rebuild,
    // and a pattern there would be a second name competing with the first.
    const named = causalityOf("emission-graph-same-actor-self-edge");
    for (const step of named.steps) expect(step.labelPattern).toBeUndefined();
  });
});

describe("typed transitive reduction", () => {
  const edge = (
    from: string,
    to: string,
    kind: OrderKind,
    carryOf?: Exclude<OrderKind, "carry">,
  ) => ({ from, kind, to, ...(carryOf === undefined ? {} : { carryOf }) });
  const shown = (edges: ReturnType<typeof edge>[]) =>
    reduceOrdering(edges).map((e) => `${e.from}-${e.kind}->${e.to}`);

  it("keeps a data edge a mixed-kind path implies", () => {
    // The planner-reviewer case in miniature: a → d is real, a → b → c → d is not.
    expect(
      shown([
        edge("a", "b", "seq"),
        edge("b", "c", "data"),
        edge("c", "d", "seq"),
        edge("a", "d", "data"),
      ]),
    ).toContain("a-data->d");
  });

  it("drops a data edge a pure data path implies", () => {
    expect(
      shown([edge("a", "b", "data"), edge("b", "c", "data"), edge("a", "c", "data")]),
    ).toEqual(["a-data->b", "b-data->c"]);
  });

  it("drops a seq edge any longer path implies", () => {
    expect(shown([edge("a", "b", "fifo"), edge("b", "c", "fifo"), edge("a", "c", "seq")])).toEqual([
      "a-fifo->b",
      "b-fifo->c",
    ]);
  });

  it("keeps a carry edge no carry composition implies", () => {
    // A back-edge asserts a cross-iteration order; only a forward-leg → one-carry-hop
    // → forward-leg composition implies that, and there is no second carry here.
    // (Whether a carry is REALIZABLE at all is decided upstream — see the
    // "impossible back edges" block below.)
    expect(
      shown([edge("a", "b", "data"), edge("b", "c", "data"), edge("c", "a", "carry")]),
    ).toEqual(["a-data->b", "b-data->c", "c-carry->a"]);
  });

  it("drops a hard edge that a path of hard edges implies", () => {
    // `data` and `control` are both non-removable, so either justifies either. This is
    // what keeps a refinement loop from growing a second arrow for every data fact a
    // guard already ordered: `initial plan → revision` says nothing on top of
    // `initial plan → initial review → (guards) → revision`.
    expect(
      shown([edge("a", "b", "data"), edge("b", "c", "control"), edge("a", "c", "data")]),
    ).toEqual(["a-data->b", "b-control->c"]);
    expect(
      shown([edge("a", "b", "control"), edge("b", "c", "data"), edge("a", "c", "control")]),
    ).toEqual(["a-control->b", "b-data->c"]);
  });

  it("keeps a hard edge whose only path runs through serialization", () => {
    // The reader is meant to be able to delete `seq`/`fifo` mentally (that is what
    // "missed parallelism" means); the real constraint has to survive that deletion.
    expect(
      shown([edge("a", "b", "seq"), edge("b", "c", "fifo"), edge("a", "c", "data")]),
    ).toContain("a-data->c");
  });

  it("lifts carry edges out so a cyclic input still reduces, and minimizes them", () => {
    // review → plan is a carry; without lifting it the relation has a cycle. The
    // self-carry p → p then says nothing on top of p -data-> r -carry-> p (one carry
    // hop), so carry minimization drops it — the loop still closes through r.
    expect(
      shown([edge("p", "r", "data"), edge("r", "p", "carry"), edge("p", "p", "carry")]),
    ).toEqual(["p-data->r", "r-carry->p"]);
  });

  it("keeps connectivity when justifying paths overlap, without a restore pass", () => {
    // a→c is implied by a→b→c, and a→d by the chain through c. Deciding every edge
    // against the SURVIVING set keeps the chain and drops both chords directly; the
    // old pass decided against the ORIGINAL set and needed a restore loop here.
    const kept = shown([
      edge("a", "b", "seq"),
      edge("b", "c", "seq"),
      edge("c", "d", "seq"),
      edge("a", "c", "seq"),
      edge("a", "d", "seq"),
    ]);
    expect(kept).toEqual(["a-seq->b", "b-seq->c", "c-seq->d"]);
  });

  it("stays irredundant on a residual cycle (the over-restoration bug)", () => {
    // Regression (2026-08-27): the old algorithm batch-removed against the ORIGINAL
    // relation, then monotonically restored edges whose witness path was itself
    // removed. On this input it removed all four chords in one batch, every witness
    // was gone by restore time, and ALL FOUR came back — 7 edges, 4 redundant. The
    // real-world shape is a shared helper making the forward relation cyclic
    // (fixture order-shared-helper-residual-cycle; jsonl-db rendered 66 forward
    // edges, 55 implied by the rest). Greedy decisions against the surviving set
    // leave an irredundant set: no kept edge has a length-≥2 witness among the
    // others. (Irredundant, not minimum — visit order decides which chord survives.)
    const kept = shown([
      edge("a", "b", "seq"),
      edge("b", "c", "seq"),
      edge("c", "d", "seq"),
      edge("a", "c", "seq"),
      edge("a", "d", "seq"),
      edge("b", "d", "seq"),
      edge("d", "a", "seq"), // the residual cycle-closer
    ]);
    expect(kept).toEqual(["a-seq->b", "c-seq->d", "a-seq->c", "b-seq->d", "d-seq->a"]);
  });

  it("drops a soft carry a one-carry composition implies", () => {
    // q@k → p@k+1 is already told by q -seq-> r (inside round k), then r -carry-> p
    // (into round k+1). A seq-underlying carry yields to any composition, exactly as
    // a forward seq edge yields to any path.
    expect(
      shown([
        edge("q", "r", "seq"),
        edge("r", "p", "carry", "seq"),
        edge("q", "p", "carry", "seq"),
      ]),
    ).toEqual(["q-seq->r", "r-carry->p"]);
  });

  it("keeps a hard carry whose only composition runs through serialization", () => {
    // Same shape, but q's answer FEEDS p's next round. The data fact must survive the
    // reader mentally deleting the seq hop — the same precedence rule as for forward
    // data edges.
    expect(
      shown([
        edge("q", "r", "seq"),
        edge("r", "p", "carry", "seq"),
        edge("q", "p", "carry", "data"),
      ]),
    ).toEqual(["q-seq->r", "r-carry->p", "q-carry->p"]);
  });

  it("drops a hard carry a hard one-carry composition implies", () => {
    expect(
      shown([
        edge("q", "r", "data"),
        edge("r", "p", "carry", "data"),
        edge("q", "p", "carry", "data"),
      ]),
    ).toEqual(["q-data->r", "r-carry->p"]);
  });

  it("lets the forward leg of a composition sit in the next round", () => {
    // r@k → s@k+1 via the carry into p@k+1, then p -data-> s inside round k+1.
    expect(
      shown([
        edge("p", "s", "data"),
        edge("r", "p", "carry", "data"),
        edge("r", "s", "carry", "data"),
      ]),
    ).toEqual(["p-data->s", "r-carry->p"]);
  });

  it("never composes two carry hops (that would assert k → k+2)", () => {
    expect(
      shown([
        edge("a", "b", "carry", "data"),
        edge("b", "c", "carry", "data"),
        edge("a", "c", "carry", "data"),
      ]),
    ).toEqual(["a-carry->b", "b-carry->c", "a-carry->c"]);
  });

  it("keeps one of two mutually-justifying carries (the loop still closes)", () => {
    // u→v and w→v justify each other through the forward 2-cycle u ⇄ w (the shared
    // helper shape again). A batch decision would drop both and lose the back
    // ordering entirely; greedy decisions against the surviving set drop exactly one.
    expect(
      shown([
        edge("u", "w", "data"),
        edge("w", "u", "data"),
        edge("u", "v", "carry", "data"),
        edge("w", "v", "carry", "data"),
      ]),
    ).toEqual(["u-data->w", "w-data->u", "w-carry->v"]);
  });
});

/**
 * Strands (docs/analysis.md, "Strands and frames"). A strand is one asynchronous activation
 * the walk inlines: an `async` body applied at a call, an `async` literal fan-out callback,
 * a deferred `.then` continuation. Its `await`s suspend the strand, never the spawner, so
 * the walk keeps a settled set per open strand (a FRAME) and the projection reads settles by
 * frame visibility. The corpus snapshots pin the resulting graphs; these pin the four claims
 * the design rests on — frame visibility, the summary a join replays, the lift rule, and the
 * awaited-position scan that decides what a barrier joins at all.
 */
describe("strands: frames, summaries and what a barrier joins", () => {
  type Core = NonNullable<ReturnType<typeof analyzeWorkflowScript>["core"]>;

  function analyzeScript(script: string): { causality: CausalityGraph; core: Core } {
    const result = analyzeWorkflowScript(script);
    expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
    const causality = result.causality;
    const core = result.core;
    if (causality === undefined || core === undefined) throw new Error("expected graphs");
    return { causality, core };
  }

  const analyzeFixture = (fixture: string): { causality: CausalityGraph; core: Core } =>
    analyzeScript(readFileSync(join(graphsDir, `${fixture}.ts`), "utf8"));

  /** The settle events in trace order, in `serializeCore`'s wording minus the `settle` token. */
  function settleLines(core: Core): string[] {
    const out: string[] = [];
    for (const event of core.trace.events) {
      if (event.at !== "settle") continue;
      const steps = event.steps.length === 0 ? "" : `${event.steps.join(",")} `;
      out.push(
        `${event.maybe ? "maybe " : ""}${steps}in=${event.regions.join(">")}` +
          (event.joins === undefined ? "" : ` joins=${event.joins.join(",")}`),
      );
    }
    return out;
  }

  /** Forward phase edges only: `carry` is the back edge of a repetition, not an ordering. */
  const forwardPhaseEdges = (graph: CausalityGraph): string[] =>
    (graph.phaseEdges ?? [])
      .filter((edge) => edge.kind !== "carry")
      .map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`);

  const HELPER =
    'async function h(): Promise<string> {\n  return await agent("h").ask<string>("h");\n}\n';

  it("leaves two unawaited fan-outs incomparable, and orders them once each is awaited", () => {
    // FRAME VISIBILITY, the defect the refactor exists to fix. The `await` inside A's
    // callback used to settle ask#1 in the one global set, so ask#2 (issued after it) read
    // as ordered after it and the two fixtures below produced byte-identical output — one
    // of them genuinely sequential, the other not.
    const concurrent = arrows(causalityOf("strand-fanout-two-phases-join"));
    expect(
      concurrent.filter((arrow) => arrow.includes("ask#1") && arrow.includes("ask#2")),
    ).toEqual([]);
    expect(concurrent).toContain("ask#1 -data-> ask#3");
    expect(concurrent).toContain("ask#2 -data-> ask#3");

    const sequential = arrows(causalityOf("strand-fanout-awaited-per-phase"));
    expect(sequential).toContain("ask#1 -seq-> ask#2");
  });

  it("quotients to A ∥ B → C, and keeps A → B when each phase awaits its own work", () => {
    expect(forwardPhaseEdges(causalityOf("strand-fanout-two-phases-join"))).toEqual([
      "phase#1 -data-> phase#3",
      "phase#2 -data-> phase#3",
    ]);
    expect(forwardPhaseEdges(causalityOf("strand-fanout-awaited-per-phase"))).toContain(
      "phase#1 -seq-> phase#2",
    );
  });

  it("replays an unawaited helper's summary at the await of its promise", () => {
    // THE SUMMARY. The helper's own await settles ask#1 in the strand's frame alone, so the
    // middle ask is ordered against nothing; `await p` joins the strand — the awaited-position
    // scan on a bare identifier — and settles what the strand itself awaited.
    const { causality, core } = analyzeFixture("strand-async-helper-unawaited");
    expect(settleLines(core)).toEqual([
      "ask#1 in=seq#1>call#1",
      "ask#2 in=seq#1",
      "ask#1 in=seq#1 joins=call#1",
      "ask#3 in=seq#1",
    ]);
    // ask#2 is the middle ask: its only arrow is the data it feeds forward. Nothing from
    // the helper reaches it.
    expect(arrows(causality).filter((arrow) => arrow.includes("ask#2"))).toEqual([
      "ask#2 -data-> ask#3",
    ]);
  });

  it("lifts a strand whose promise reaches the barrier only through a container", () => {
    // THE LIFT RULE. The syntactic half cannot fire here: nothing was spawned while
    // `const box = [p]` was evaluated, so `box` names no strand, and `p` itself is not in an
    // awaited position of the operand. What joins call#1 is the lift — the barrier's claim
    // names ask#1, ask#1 was issued inside that strand, so the strand is waited for too.
    const lifted = analyzeScript(
      HELPER +
        "const p = h();\n" +
        "const box = [p];\n" +
        'const mid = await agent("m").ask<string>("m");\n' +
        "const hv = await Promise.all(box);\n" +
        'return await agent("l").ask<string>(hv.join("") + mid);\n',
    );
    expect(settleLines(lifted.core)).toContain("ask#1 in=seq#1 joins=call#1");

    // The same join reached syntactically, for contrast: each element of an array literal IS
    // an awaited position, so `p` is scanned and the strand bound to it joins without a lift.
    const syntactic = analyzeScript(
      HELPER +
        "const p = h();\n" +
        'const mid = await agent("m").ask<string>("m");\n' +
        "const hv = await Promise.all([p]);\n" +
        'return await agent("l").ask<string>(hv.join("") + mid);\n',
    );
    expect(settleLines(syntactic.core)).toContain("ask#1 in=seq#1 joins=call#1");
  });

  it("joins nothing from an opaque position", () => {
    // THE AWAITED-POSITION SCAN, negative half. `work.length` reads the ARRAY, not the
    // promises in it, so `await f(work.length)` waits for none of them and the settle carries
    // no `joins` at all. This is the accepted residual under-ordering of the plan's soundness
    // boundary: the analyzer would rather say nothing than claim an order the runtime lacks.
    const { core } = analyzeScript(
      "const ids = [1, 2, 3];\n" +
        "const work = ids.map(async (i) => {\n" +
        "  const r = await agent(`a-${i}`).ask<string>(`a ${i}`);\n" +
        "  return r;\n" +
        "});\n" +
        'return await agent("x").ask<string>(String(work.length));\n',
    );
    expect(settleLines(core)).toEqual(["ask#1 in=seq#1>fanout#1", "ask#2 in=seq#1"]);
  });

  it("joins a `.then` strand through the variable it was bound to, summary and all", () => {
    // The bound-variable half of the scan. `q` is the operand of `await q`, and the strand
    // spawned while its declaration was evaluated is bound to it, so the join carries BOTH
    // the receiver's step (settled by the strand's prologue) and the step the continuation
    // awaited inside itself. The side ask, issued between registration and join, gets
    // nothing — the edge the old global may-settle drew here is exactly what disappears.
    const { causality, core } = analyzeFixture("strand-then-internal-await");
    expect(settleLines(core)).toEqual([
      "ask#1 in=seq#1>choice#1>branch#1>call#1",
      "ask#2 in=seq#1>choice#1>branch#1>call#1",
      "ask#3 in=seq#1",
      "ask#1,ask#2 in=seq#1 joins=call#1",
    ]);
    expect(arrows(causality).filter((arrow) => arrow.includes("ask#3"))).toEqual([]);
  });
});

describe("reduction irredundancy (property over the whole corpus)", () => {
  // Every surviving forward edge must assert an order no path of at-least-as-strong
  // surviving forward edges asserts (docs/analysis.md, "Typed transitive reduction" step 2).
  // The old batch-remove-then-restore pass violated this on every
  // graph with a residual cycle — the jsonl-db workflow rendered 66 forward edges of
  // which 55 were implied by the rest. Checked over the full fixture corpus with an
  // independent reimplementation of the justification rule.
  const JUSTIFIERS: Record<string, ReadonlySet<string>> = {
    control: new Set(["data", "control"]),
    data: new Set(["data", "control"]),
    fifo: new Set(["data", "control", "fifo"]),
    seq: new Set(["data", "control", "fifo", "seq"]),
  };

  const fixtures = readdirSync(graphsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  const impliedByTheOthers = (edges: readonly OrderEdge[]): string[] => {
    const forward = edges.filter((edge) => edge.kind !== "carry");
    const outgoing = new Map<string, typeof forward>();
    for (const edge of forward) {
      const list = outgoing.get(edge.from);
      if (list === undefined) outgoing.set(edge.from, [edge]);
      else list.push(edge);
    }
    const redundant = forward.filter((edge) => {
      if (edge.from === edge.to) return false;
      const allowed = JUSTIFIERS[edge.kind] as ReadonlySet<string>;
      // BFS for a length-≥2 witness path over allowed kinds, skipping direct hops.
      const seen = new Set<string>([edge.from]);
      const stack: string[] = [];
      for (const hop of outgoing.get(edge.from) ?? []) {
        if (hop.to === edge.to || !allowed.has(hop.kind)) continue;
        if (!seen.has(hop.to)) {
          seen.add(hop.to);
          stack.push(hop.to);
        }
      }
      while (stack.length > 0) {
        const node = stack.pop() as string;
        for (const hop of outgoing.get(node) ?? []) {
          if (!allowed.has(hop.kind)) continue;
          if (hop.to === edge.to) return true;
          if (!seen.has(hop.to)) {
            seen.add(hop.to);
            stack.push(hop.to);
          }
        }
      }
      return false;
    });
    return redundant.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`);
  };

  for (const fixture of fixtures) {
    it(`${fixture}: no forward edge is implied by the others`, () => {
      const graph = causalityOf(fixture.replace(/\.ts$/, ""));
      expect(impliedByTheOthers(graph.edges)).toEqual([]);
      // The quotient projects step edges onto phases and then runs the SAME
      // `reduceOrdering`, so the property has to survive projection too: a phase edge
      // implied by the surviving others is a reader being told an order twice. Folded
      // into this `it` rather than filtered into its own loop so any fixture that grows
      // a phase vocabulary is covered without being named here.
      if (graph.phaseEdges !== undefined) {
        expect(impliedByTheOthers(graph.phaseEdges)).toEqual([]);
      }
    });
  }
});
