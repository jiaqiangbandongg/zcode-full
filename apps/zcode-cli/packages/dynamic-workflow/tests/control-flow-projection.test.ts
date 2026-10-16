import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript, phaseFlowToMermaid } from "../src/index.js";
import { createStrandPark } from "../src/analysis/flow-strands.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

/**
 * Scale pins for the control-flow projection (docs/analysis.md, 追记 2026-09-03).
 *
 * Two recorded scripts — xiangqi engines whose pure rule helpers get inlined a hundred times
 * each — made `projectControlFlow` exhaust the call stack after 12 s and 74 s of work. Neither
 * failure was deep recursion (33 frames): one was a source multiset doubling at every
 * leafless skippable choice until `push(...spread)` overflowed, the other a tree-ordering
 * comparator that re-walked whole subtrees per comparison. Both shapes are reproduced here
 * synthetically at a size that failed before the fix and completes in milliseconds after it.
 */

function analyze(script: string) {
  const result = analyzeWorkflowScript(script);
  expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
  const flow = result.flow;
  const core = result.core;
  if (flow === undefined || core === undefined) throw new Error("expected a control-flow graph");
  return { core, flow };
}

/** A void helper of `n` skippable choices whose arm holds a nested choice that returns. */
function leaflessChoices(n: number): string {
  let body = "";
  for (let i = 0; i < n; i += 1) body += `  if (x > ${i}) { if (x < 100) return; }\n`;
  return `function bump(x: number): void {\n${body}}
const t = await agent("w").ask<string>("start");
bump(t.length);
return await agent("v").ask<string>(t);
`;
}

/** Helpers h0…hD, each calling the next twice inside choices: ~2^(D+1) inlined call regions. */
function deepInlining(depth: number): string {
  let src = "";
  for (let k = depth; k >= 0; k -= 1) {
    const inner = k === depth ? "if (x < 100) return;" : `h${k + 1}(x); if (x > ${k}) h${k + 1}(x + 1);`;
    src += `function h${k}(x: number): void { if (x > ${k}) { ${inner} } }\n`;
  }
  return `${src}const t = await agent("w").ask<string>("start");
h0(t.length);
return await agent("v").ask<string>(t);
`;
}

describe("control-flow projection at scale", () => {
  it("keeps the source list a set through a run of leafless skippable choices", () => {
    // 24 such choices in sequence doubled the incoming source 2^24 times before the fix; the
    // spread in `exits.push(...armExits)` threw RangeError at a stack depth of 33 frames.
    const { flow } = analyze(leaflessChoices(24));
    // The helper contributes no node, so the CFG is the two asks in sequence plus the sink,
    // however large the helper is. Two kinds survive between the asks — the path that skips
    // every choice (`branch`) and the one that returns out of the helper (`next`) — because
    // the CFG keeps one edge per kind (render merges them); what must NOT survive is a copy.
    expect(flow.nodes.map((node) => node.id)).toEqual(["ask#1@1", "ask#2@1"]);
    expect(flow.edges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}`)).toEqual([
      "entry>ask#1@1:next",
      "ask#1@1>ask#2@1:branch",
      "ask#1@1>ask#2@1:next",
      "ask#2@1>sink:jump",
    ]);
  });

  it("orders a 20k-region trace of nested inlined helpers in linear time", () => {
    // The tree ordering used to call `order(child)` inside the sort comparator, re-sorting
    // and re-walking each subtree per comparison — exponential in nesting depth (45 s on a
    // 2,500-region trace). Depth 11 here is ~20k regions; the bound is deliberately loose
    // (the unfixed comparator does not finish in minutes), so it cannot flake on a slow box.
    const started = Date.now();
    const { core, flow } = analyze(deepInlining(11));
    expect(core.trace.regions.length).toBeGreaterThan(10_000);
    expect(flow.nodes.map((node) => node.id)).toEqual(["ask#1@1", "ask#2@1"]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

/**
 * Strands (docs/analysis.md, the concurrent CFG). A `strand` region is one asynchronous
 * activation the walk inlined: control forks into it at the spawn, its exits are parked
 * (flow-strands.ts) instead of continuing the spawner's line, and they rejoin at the
 * barrier whose `joins` names it — or at the sink, when nothing awaits it.
 */

const IDS = "const ids = [1, 2, 3];\n";

/** `phase(name)` and a fan-out of `async` callbacks in it: one strand per phase. */
function strandPhase(name: string, binding: string, tag: string): string {
  return (
    `phase(${JSON.stringify(name)});\n` +
    `const ${binding} = ids.map(async (i) => {\n` +
    `  const r = await agent(\`${tag}-\${i}\`).ask<string>(${JSON.stringify(tag)});\n` +
    "  return r;\n" +
    "});\n"
  );
}

function edgeLines(flow: { edges: readonly { from: string; to: string; kind: string; via?: string }[] }): string[] {
  return flow.edges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kind}${edge.via === undefined ? "" : ` via=${edge.via}`}`);
}

describe("strands", () => {
  // The reference shape of the whole refactor: two phases fan out `async` work, a single
  // barrier joins both, the third phase fans out again and the script returns. A ∥ B → C.
  const REFERENCE =
    IDS +
    strandPhase("A", "aWork", "a") +
    strandPhase("B", "bWork", "b") +
    "const both = await Promise.all([Promise.all(aWork), Promise.all(bWork)]);\n" +
    'phase("C");\n' +
    "const merged = await Promise.all(\n" +
    "  ids.map(async (i) => {\n" +
    '    const r = await agent(`c-${i}`).ask<string>(both.join(",") + String(i));\n' +
    "    return r;\n" +
    "  }),\n" +
    ");\n" +
    "return merged;\n";

  it("forks into each phase's strand and joins both at the one barrier", () => {
    const { flow } = analyze(REFERENCE);
    expect(flow.nodes.map((node) => node.id)).toEqual([
      "phase#1@1",
      "ask#1@1",
      "phase#2@1",
      "ask#2@1",
      "phase#3@1",
      "ask#3@1",
    ]);
    // A's and B's asks reach C's marker by a `join`, not by the sequential line: the
    // spawner walked straight from marker to marker while they ran.
    expect(edgeLines(flow)).toEqual([
      "entry -> phase#1@1 next",
      "phase#1@1 -> ask#1@1 fork",
      "phase#1@1 -> phase#2@1 next",
      "ask#1@1 -> phase#3@1 join via=return",
      "phase#2@1 -> ask#2@1 fork",
      "phase#2@1 -> phase#3@1 next",
      "ask#2@1 -> phase#3@1 join via=return",
      "phase#3@1 -> ask#3@1 fork",
      "phase#3@1 -> sink jump via=return",
      "ask#3@1 -> sink join via=return",
    ]);
  });

  it("records the phases still running at a marker as `alongside`, on the node and the phase", () => {
    const { flow } = analyze(REFERENCE);
    const alongside = Object.fromEntries(
      flow.nodes.filter((node) => node.kind === "mark").map((node) => [node.id, node.alongside]),
    );
    // B is entered while A's strand is parked; C is entered after the barrier joined both.
    expect(alongside).toEqual({ "phase#1@1": undefined, "phase#2@1": ["phase#1"], "phase#3@1": undefined });
    expect(flow.phases?.map((phase) => [phase.id, phase.alongside])).toEqual([
      ["phase#1", undefined],
      ["phase#2", ["phase#1"]],
      ["phase#3", undefined],
    ]);
    // It is a node fact, never an edge: no `alongside` kind exists in the quotient.
    expect(flow.phaseEdges?.every((edge) => edge.kind !== ("alongside" as never))).toBe(true);
  });

  it("draws each alongside pair as one dashed link, earlier phase first", () => {
    const { flow } = analyze(REFERENCE);
    const drawn = phaseFlowToMermaid(flow)
      .split("\n")
      .filter((line) => line.includes("alongside"));
    expect(drawn).toEqual(['  phase_1 -.->|"alongside"| phase_2']);
  });

  it("leaves a marker's own phase out of its `alongside`", () => {
    // The third marker re-enters A while A's OWN strand is still parked; only B's counts.
    const { flow } = analyze(
      IDS +
        strandPhase("A", "aWork", "a") +
        strandPhase("B", "bWork", "b") +
        'phase("A");\n' +
        "const tail = await Promise.all([Promise.all(aWork), Promise.all(bWork)]);\n" +
        "return tail;\n",
    );
    const reentry = flow.nodes.find((node) => node.id === "phase#1@2");
    expect(reentry?.phase).toBe("phase#1");
    expect(reentry?.alongside).toEqual(["phase#2"]);
  });

  it("leaves a strand the marker sits inside out of its `alongside`", () => {
    // Unreachable from a script today — a strand parks only once its body is finished, so
    // a marker inside it is always flowed first — but the rule is what makes `alongside`
    // mean "running BESIDE me", so it is pinned where it lives.
    const park = createStrandPark([
      { id: "phase#1", loc: { column: 1, line: 1 }, name: "A" },
      { id: "phase#2", loc: { column: 1, line: 2 }, name: "B" },
    ]);
    park.park("call#1", [{ from: "ask#1@1", kind: "join" }], ["phase#1"]);
    park.park("fanout#1", [{ from: "ask#2@1", kind: "join" }], ["phase#2"]);
    expect(park.alongside("phase#3", ["seq#1"])).toEqual(["phase#1", "phase#2"]);
    expect(park.alongside("phase#3", ["seq#1", "call#1"])).toEqual(["phase#2"]);
    expect(park.alongside("phase#2", ["seq#1", "call#1"])).toEqual([]);
  });

  it("joins a strand nothing awaits at the sink, and counts it alongside every later phase", () => {
    // `aWork.length` is an opaque position: the walk joins nothing, so the strand is
    // fire-and-forget and the only thing known about it is that the script outlived it.
    const { flow } = analyze(
      IDS +
        strandPhase("A", "aWork", "a") +
        'phase("B");\n' +
        "const tail = await agent(\"tail\").ask<string>(`count ${aWork.length}`);\n" +
        "return tail;\n",
    );
    expect(flow.nodes.find((node) => node.id === "phase#2@1")?.alongside).toEqual(["phase#1"]);
    expect(edgeLines(flow)).toEqual([
      "entry -> phase#1@1 next",
      "phase#1@1 -> ask#1@1 fork",
      "phase#1@1 -> phase#2@1 next",
      "ask#1@1 -> sink join via=return",
      "phase#2@1 -> ask#2@1 next",
      "ask#2@1 -> sink jump via=return",
    ]);
  });

  it("unparks at a barrier that joins a strand but settles nothing new", () => {
    // The second call to one `async` helper: its step was already settled by the FIRST
    // call's join, so the walk emits `settle` with no steps and only `joins`. The join is
    // still a control-flow fact, and the strand's exit must land on the node after it.
    const { core, flow } = analyze(
      "async function fetchOne(topic: string): Promise<string> {\n" +
        "  const r = await agent(\"worker\").ask<string>(`do ${topic}`);\n" +
        "  return r;\n" +
        "}\n" +
        'const alpha = await fetchOne("alpha");\n' +
        'const beta = await fetchOne("beta");\n' +
        "const tail = await agent(\"tail\").ask<string>(`${alpha} ${beta}`);\n" +
        "return tail;\n",
    );
    const joinOnly = core.trace.events.filter(
      (event) => event.at === "settle" && event.steps.length === 0 && event.joins !== undefined,
    );
    expect(joinOnly).toHaveLength(1);
    // Without the unpark, ask#1@2 would fall through to the sink instead of reaching the
    // tail — that edge IS the join-only settle doing its work.
    expect(edgeLines(flow)).toContain("ask#1@2 -> ask#2@1 join via=return");
    expect(edgeLines(flow)).not.toContain("ask#1@2 -> sink join via=return");
  });
  it("never parks the spawner's own source, so no entry placeholder escapes", () => {
    // Mutual recursion through `async` helpers: the recursion SCC is folded into a `loop`,
    // and the strand that carries the base-case ask is spawned as the first thing inside
    // that loop body, so its incoming source is the body's entry PLACEHOLDER. Its `return`
    // met no node on the way out and still stands on `$entry1`; parking it put an edge out
    // of a node that never existed into the finished graph. Note the strand is NOT
    // node-free — it holds `ask#1` — which is why `entries.length === 0` cannot catch this.
    const { flow } = analyze(
      'const judge = agent("judge");\n' +
        "async function even(s: string, n: number): Promise<string> {\n" +
        "  if (n <= 0) return await judge.ask<string>(`final ${s}`);\n" +
        "  return odd(s, n - 1);\n" +
        "}\n" +
        "async function odd(s: string, n: number): Promise<string> {\n" +
        "  return even(s, n - 1);\n" +
        "}\n" +
        'const seed = await agent("s").ask<string>("seed");\n' +
        "const out = await even(seed, 4);\n" +
        "return out;\n",
    );
    const known = new Set([...flow.nodes.map((node) => node.id), "entry", "sink", "abort"]);
    const dangling = flow.edges.filter((edge) => !known.has(edge.from) || !known.has(edge.to));
    expect(dangling).toEqual([]);
    expect(edgeLines(flow)).toEqual([
      "entry -> ask#2@1 next",
      "ask#2@1 -> ask#1@1 fork",
      "ask#2@1 -> ask#1@1 loop via=recur",
      "ask#2@1 -> sink jump via=return",
      "ask#1@1 -> sink join via=return",
    ]);
  });

  it("parks a node-free strand whose barrier joins a strand that is not", () => {
    // `p.then(onOk, onErr).finally(...)`: the `.finally` continuation is a strand holding
    // no call of its own, so nothing the entry placeholder reached is a node — but its
    // barrier joins both `.then` strands, and THEIR exits are the body's exits. Treating
    // it as invisible left `ask#2@1` and `ask#3@1` with no outgoing edge at all.
    const { flow } = analyze(
      'const draft = agent("writer").ask<string>("draft");\n' +
        "const settled = await Promise.resolve(draft)\n" +
        "  .then(\n" +
        "    (t) => agent(\"editor\").ask<string>(`edit ${t}`),\n" +
        "    (e) => agent(\"fixer\").ask<string>(`recover ${String(e)}`),\n" +
        "  )\n" +
        '  .finally(() => log("done"));\n' +
        "return settled;\n",
    );
    expect(edgeLines(flow)).toEqual([
      "entry -> ask#1@1 next",
      "ask#1@1 -> ask#2@1 branch",
      "ask#1@1 -> ask#3@1 branch",
      "ask#1@1 -> sink jump via=return",
      "ask#2@1 -> sink join",
      "ask#3@1 -> sink join",
    ]);
  });
});
