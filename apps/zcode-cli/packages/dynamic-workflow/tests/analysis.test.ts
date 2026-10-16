import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";
import { analyzeWorkflowScript, siteGraphToMermaid, toActorGraph } from "../src/index.js";
import { serializeActorGraph, serializeGraph } from "../src/analysis/serialize.js";
import type { SiteEdge, SiteGraph } from "../src/analysis/types.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

// Unit coverage for the analysis substrate where a full fixture snapshot would be
// awkward: prelude-stripped location mapping and the resolver-driven site table.
describe("createWorkflowProgram", () => {
  it("maps positions to 1-based, prelude-stripped script coordinates", () => {
    const { scriptFile, toScriptLoc } = createWorkflowProgram(`const x = 1;\nconst y = 2;`);
    // The first authored line is line 1 despite the wrapper prelude occupying line 1
    // of the wrapped source; the first character is column 1.
    const firstConst = scriptFile.text.indexOf("const x");
    expect(toScriptLoc(firstConst)).toEqual({ column: 1, line: 1 });
    const secondConst = scriptFile.text.indexOf("const y");
    expect(toScriptLoc(secondConst)).toEqual({ column: 1, line: 2 });
  });
});

describe("collectSites", () => {
  const table = (scriptText: string) => collectSites(createWorkflowProgram(scriptText));

  it("resolves facade Agent.ask via the checker, not by method name", () => {
    const sites = table(`
      const notAnAgent = { ask(q: string): string { return q; } };
      const ignored = notAnAgent.ask("nope");
      const real = await agent("scanner").ask<string>("do it");
      return real;
    `);
    expect(sites.asks).toHaveLength(1);
    expect(sites.asks[0]?.label).toBe("scanner");
    expect(sites.actors).toHaveLength(1);
  });

  it("collects asks inside script-local helper functions", () => {
    const sites = table(`
      async function helper(topic: string): Promise<string> {
        const worker = agent("worker");
        return await worker.ask<string>(topic);
      }
      const out = await helper("x");
      return out;
    `);
    expect(sites.asks).toHaveLength(1);
    expect(sites.asks[0]?.label).toBe("worker");
    // The helper's own `return` is not a top-level (sink) return; only the last one is.
    expect(sites.topLevelReturns).toHaveLength(1);
  });

  it("assigns per-kind source-order ordinal ids", () => {
    const sites = table(`
      const a = await agent("first").ask<string>("a");
      const b = await agent("second").ask<string>("b");
      return a + b;
    `);
    expect(sites.asks.map((s) => s.id)).toEqual(["ask#1", "ask#2"]);
    expect(sites.actors.map((s) => s.id)).toEqual(["actor#1", "actor#2"]);
  });

  it("records array-method fan-out candidates with their binding and iterated node", () => {
    const sites = table(`
      const paths = await files.glob("src/**/*.ts");
      const done = paths.map((p) => agent("r").ask<string>(p));
      return done.length;
    `);
    expect(sites.worldReads).toHaveLength(1);
    expect(sites.iterations).toHaveLength(1);
    expect(sites.iterations[0]?.form).toBe("array-method");
    expect(sites.iterations[0]?.method).toBe("map");
  });
});

/** The data edges of a clean script, for asserting exactness/ports directly. */
function dataEdges(scriptText: string): SiteEdge[] {
  const result = analyzeWorkflowScript(scriptText);
  expect(result.diagnostics).toEqual([]);
  const graph = result.graph;
  if (graph === undefined) throw new Error("expected a graph for a clean script");
  return graph.edges.filter((edge) => edge.kind === "data");
}

function edge(edges: SiteEdge[], from: string, to: string): SiteEdge | undefined {
  return edges.find((e) => e.from === from && e.to === to);
}

describe("heap-write soundness (bug-scan regressions)", () => {
  it("merges mutator argument taint through an unresolvable (computed-index) receiver", () => {
    // Bugfix: `state.buffers[i].push(seed)` has no resolvable receiver place (computed
    // index), and the old transfer dropped seed's taint entirely instead of falling back
    // to the root-identifier smear the assignment paths use.
    const edges = dataEdges(`
      const seed = await agent("a").ask<string>("draft");
      const state = { buffers: [[""]] };
      const i = seed.length % 1;
      state.buffers[i]!.push(seed);
      const out = await agent("b").ask<string>(\`use \${JSON.stringify(state)}\`);
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")).toBeDefined();
  });

  it("writes loop-carried for-of element mutations back to the collection (pass >= 2 flows)", () => {
    // Bugfix: the for-of write-back scanned the current pass's fresh element clone, but the
    // body writes land on the loop variable's persistent env slot — taint that first
    // arrives on fixpoint pass 2 (the loop-carried reviewer feedback) never reached items.
    const edges = dataEdges(`
      let fb = "";
      const items = [{ note: "" }];
      for (let r = 0; r < 2; r++) {
        for (const it of items) {
          it.note = fb;
        }
        fb = await agent("reviewer").ask<string>("review the drafts");
      }
      const out = await agent("writer").ask<string>(items.map((x) => x.note).join(","));
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")).toBeDefined();
  });

  it("writes destructured for-of loop-variable mutations back to the collection", () => {
    // Bugfix: `for (const { doc } of items)` binds doc to a detached clone, so its field
    // writes never populated the element value the old write-back scanned — dropped even
    // on the first pass. The write-back now reads the slots the body actually wrote through.
    const edges = dataEdges(`
      const t = await agent("a").ask<string>("annotate");
      const items = [{ doc: { note: "" } }];
      for (const { doc } of items) {
        doc.note = t;
      }
      const out = await agent("b").ask<string>(JSON.stringify(items));
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")).toBeDefined();
  });

  it("carries a container-level param mutation with a sibling param's value back to the caller", () => {
    // Bugfix: mergeHeapEffects skipped every top-level placeholder of the param slot, so
    // `list.push(v)` inside the callee (which routes ph(fill,1) into the `list` slot's top
    // level) never told the caller its array may contain v — the ask#1 -> ask#2 edge vanished.
    const edges = dataEdges(`
      function fill(list: string[], v: string): void {
        list.push(v);
      }
      const secret = await agent("w").ask<string>("secret");
      const list: string[] = [];
      fill(list, secret);
      const out = await agent("r").ask<string>(\`use \${list.join(" ")}\`);
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")).toBeDefined();
  });

  it("dispatches a script-local method that shares a heap-mutator name (add/set/push)", () => {
    // Bugfix: `inbox.add(...)` was intercepted as Set.add by NAME alone; the tracked method
    // body was never applied, so its parameter actuals stayed empty and the flow from the
    // world read through the method's ask instruction was dropped.
    const edges = dataEdges(`
      const secretary = agent("s");
      const inbox = {
        add(item: string) {
          return secretary.ask<string>(\`file this: \${item}\`);
        },
      };
      const notes = await files.glob("*.md");
      const filed = await inbox.add(notes.join(","));
      return filed;
    `);
    expect(edge(edges, "world-read#1", "ask#1")).toBeDefined();
  });

  it("still folds native mutator arguments into a resolvable receiver (no regression)", () => {
    const edges = dataEdges(`
      const seed = await agent("a").ask<string>("draft");
      const box = { items: [] as string[] };
      box.items.push(seed);
      const out = await agent("b").ask<string>(box.items.join(","));
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")).toBeDefined();
  });
});

describe("taint exactness", () => {
  it("preserves exactness through a directly-referenced helper (placeholder substitution)", () => {
    const edges = dataEdges(`
      function relay(v: string): string { return v; }
      const a = await agent("a").ask<string>("A");
      const c = await agent("c").ask<string>(\`use \${relay(a)}\`);
      return c;
    `);
    expect(edge(edges, "ask#1", "ask#2")?.exact).toBe(true);
  });

  it("clears exactness at a computed index access (the widening rule)", () => {
    const edges = dataEdges(`
      const seed = await agent("s").ask<string>("s");
      const items = [seed, "x"];
      const picked = items[seed.length % 2];
      const out = await agent("o").ask<string>(\`\${picked}\`);
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")?.exact).toBe(false);
  });

  it("clears exactness through a higher-order (non-singleton) callee", () => {
    const edges = dataEdges(`
      function g(x: string): string { return x; }
      function h(x: string): string { return x; }
      const seed = await agent("s").ask<string>("s");
      const f = seed.length > 2 ? g : h;
      const out = await agent("o").ask<string>(\`\${f(seed)}\`);
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")?.exact).toBe(false);
  });

  it("keeps context-sensitive returns from cross-contaminating distinct call sites", () => {
    // relay(a) feeds ask#3 and relay(b) feeds ask#4; there must be no ask#1 -> ask#4.
    const edges = dataEdges(`
      function relay(v: string): string { return v; }
      const a = await agent("a").ask<string>("A");
      const b = await agent("b").ask<string>("B");
      const c = await agent("c").ask<string>(\`\${relay(a)}\`);
      const d = await agent("d").ask<string>(\`\${relay(b)}\`);
      return \`\${c} \${d}\`;
    `);
    expect(edge(edges, "ask#1", "ask#3")).toBeDefined();
    expect(edge(edges, "ask#2", "ask#4")).toBeDefined();
    expect(edge(edges, "ask#1", "ask#4")).toBeUndefined();
    expect(edge(edges, "ask#2", "ask#3")).toBeUndefined();
  });

  it("carries a join element port through static destructuring to the downstream sink", () => {
    const edges = dataEdges(`
      const [x, y] = await Promise.all([
        agent("first").ask<string>("A"),
        agent("second").ask<string>("B"),
      ]);
      const z = await agent("third").ask<string>(\`\${x}\`);
      return \`\${y} \${z}\`;
    `);
    // x is element 0: the join -> ask#3 edge keeps port=0; the additive producer
    // edge ask#1 -> ask#3 is portless.
    expect(edge(edges, "join#1", "ask#3")?.port).toBe(0);
    expect(edge(edges, "ask#1", "ask#3")?.port).toBeUndefined();
  });
});

describe("constructor calls", () => {
  it("carries taint through a constructor call (new Set) into a downstream sink", () => {
    // `new Set([...])` has no script-local constructor summary; the NewExpression
    // rule unions the argument collapses so the ask result is not silently dropped.
    const edges = dataEdges(`
      const a = await agent("a").ask<string>("A");
      const set = new Set([a]);
      const out = await agent("o").ask<string>(JSON.stringify([...set]));
      return out;
    `);
    expect(edge(edges, "ask#1", "ask#2")).toBeDefined();
  });
});

describe("nested heap writes", () => {
  it("walks through a non-null assertion on a nested heap-write target", () => {
    // `report!.sections.intro = r`: the NonNull wrapper sits on the lvalue chain, so
    // the walk to the root identifier `report` must peel it — otherwise the ask taint
    // is silently dropped and `report` never reaches the return.
    const edges = dataEdges(`
      const report = { sections: { intro: "" } };
      const r = await agent("writer").ask<string>("write");
      report!.sections.intro = r;
      return report;
    `);
    expect(edge(edges, "ask#1", "sink")).toBeDefined();
  });
});

describe("ask actor lanes", () => {
  function askNode(scriptText: string, id: string) {
    const result = analyzeWorkflowScript(scriptText);
    expect(result.diagnostics).toEqual([]);
    return result.graph?.nodes.find((node) => node.id === id);
  }

  it("populates ask nodes with the receiver's actor site ids, deduped and ordered", () => {
    // `shared` is asked twice; a distinct `loner` once. Each ask node lists its lane.
    const script = `
      const shared = agent("shared");
      const a = await shared.ask<string>("one");
      const b = await shared.ask<string>("two");
      const loner = agent("loner");
      const c = await loner.ask<string>("three");
      return \`\${a} \${b} \${c}\`;
    `;
    expect(askNode(script, "ask#1")?.actors).toEqual(["actor#1"]);
    expect(askNode(script, "ask#2")?.actors).toEqual(["actor#1"]);
    expect(askNode(script, "ask#3")?.actors).toEqual(["actor#2"]);
  });

  it("resolves the actor lane of an ask on a helper parameter via the summary", () => {
    const script = `
      function interrogate(who: Agent): Node<string> {
        return who.ask<string>("q");
      }
      const shared = agent("shared");
      const out = await interrogate(shared);
      return out;
    `;
    // The ask lives inside the helper on parameter `who`; it resolves to the actor
    // passed in at the call site.
    expect(askNode(script, "ask#1")?.actors).toEqual(["actor#1"]);
  });
});

describe("mermaid emitters", () => {
  function siteMermaid(scriptText: string): string {
    const result = analyzeWorkflowScript(scriptText);
    expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
    const graph = result.graph;
    if (graph === undefined) throw new Error("expected a graph for a clean script");
    return siteGraphToMermaid(graph);
  }

  it("sanitizes node ids to word chars but keeps the original id in the label", () => {
    // Two promoted maps -> fan-out#1/#2. The mermaid node id must be `fan_out_2`
    // (ids forbid `#`/`-`), while the label still reads `fan-out#2`.
    const mermaid = siteMermaid(`
      const logs = await files.glob("*.log");
      const a = logs.map((f) => agent("A").ask<string>(f));
      const b = logs.map((f) => agent("B").ask<string>(f));
      return [...a, ...b];
    `);
    expect(mermaid).toContain('fan_out_2{{"fan-out#2"}}');
    expect(mermaid).not.toContain("fan-out#2{{");
  });

  it("entity-encodes double quotes in a user-derived label", () => {
    // An agent name with an embedded quote must not break the diagram: `"` -> `#quot;`.
    const mermaid = siteMermaid(`
      const out = await agent('say "hi"').ask<string>("go");
      return out;
    `);
    expect(mermaid).toContain("#quot;");
    expect(mermaid).not.toContain('say "hi"');
  });

  it("keeps a multi-actor (may) ask outside any lane subgraph", () => {
    // The receiver may be either actor, so the ask has a two-element actor set and
    // must stay top-level rather than being placed in one actor's lane.
    const mermaid = siteMermaid(`
      const a = agent("a");
      const b = agent("b");
      const who = Math.random() > 0.5 ? a : b;
      const out = await who.ask<string>("go");
      return out;
    `);
    expect(mermaid).not.toContain("subgraph");
  });
});

describe("actor-graph agent-relevance filter", () => {  function actorGraph(scriptText: string) {
    const result = analyzeWorkflowScript(scriptText);
    expect(result.diagnostics).toEqual([]);
    const graph = result.graph;
    if (graph === undefined) throw new Error("expected a graph for a clean script");
    return toActorGraph(graph);
  }

  it("drops endpoint-to-endpoint edges and prunes the now-isolated workspace", () => {
    // The glob result flows straight into the return (world-read -> sink), which
    // projects to `workspace -> sink` — an endpoint-to-endpoint edge that the filter
    // drops; the independent ask keeps its source/sink edges.
    const graph = actorGraph(`
      const raw = await files.glob("*.md");
      const out = await agent("w").ask<string>("go");
      return [raw, out];
    `);
    const ids = graph.nodes.map((node) => node.id);
    expect(graph.edges.some((edge) => edge.from === "workspace")).toBe(false);
    // workspace's only projected edge was the dropped workspace -> sink, so the now
    // edge-less workspace endpoint is pruned; the actor lane is untouched.
    expect(ids).not.toContain("workspace");
    expect(ids).toContain("actor#1");
    expect(graph.edges).toContainEqual({ count: 1, exact: true, from: "source", to: "actor#1" });
    // The ask's `string` artifact type rides the actor#1 -> sink edge as a message type.
    expect(graph.edges).toContainEqual({ count: 1, exact: true, from: "actor#1", to: "sink", types: ["string"] });
  });
});

// Producer-side artifact types (docs/analysis.md, "Edge attributes"): every
// data edge's `from` is a producer with a statically known artifact type, recorded on
// the node, resolved onto the edge (port-refined out of a join), and aggregated as the
// message types of the derived actor edge.
describe("artifact types", () => {
  function analyze(scriptText: string): SiteGraph {
    const result = analyzeWorkflowScript(scriptText);
    expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
    const graph = result.graph;
    if (graph === undefined) throw new Error("expected a graph for a clean script");
    return graph;
  }
  const nodeType = (graph: SiteGraph, id: string): string | undefined =>
    graph.nodes.find((node) => node.id === id)?.artifactType;
  const findEdge = (graph: SiteGraph, from: string, to: string, port?: number): SiteEdge | undefined =>
    graph.edges.find((e) => e.kind === "data" && e.from === from && e.to === to && e.port === port);

  it("labels producer nodes and data edges with named / default / glob types", () => {
    const graph = analyze(`
interface Flaky { findings: string[]; }
const a = await agent("s").ask<Flaky>("f");
const b = await agent("p").ask("plan");
const g = await files.glob("*.ts");
const out = await agent("c").ask<string>(\`\${a.findings} \${b} \${g}\`);
return out;
`);
    // Named interface prints as its NAME, not a structural expansion.
    expect(nodeType(graph, "ask#1")).toBe("Flaky");
    expect(nodeType(graph, "ask#2")).toBe("string"); // default T = string, no type argument
    expect(nodeType(graph, "world-read#1")).toBe("string[]");
    expect(findEdge(graph, "ask#1", "ask#3")?.type).toBe("Flaky");
    expect(findEdge(graph, "world-read#1", "ask#3")?.type).toBe("string[]");
  });

  it("port-refines a join's outgoing edges and takes producer whole types into a join", () => {
    const graph = analyze(`
interface Draft { body: string; }
interface Verdict { approved: boolean; }
const worker = agent("worker");
const [x, y] = await Promise.all([worker.ask<Draft>("a"), worker.ask<Verdict>("b")]);
const z = await agent("c").ask<string>(\`\${x.body} \${y.approved}\`);
return z;
`);
    // Edges OUT of the join are refined to the selected element's type.
    expect(findEdge(graph, "join#1", "ask#3", 0)?.type).toBe("Draft");
    expect(findEdge(graph, "join#1", "ask#3", 1)?.type).toBe("Verdict");
    // Edges INTO the join carry the producer's (from-side) whole type, not a port lookup.
    expect(findEdge(graph, "ask#1", "join#1", 0)?.type).toBe("Draft");
    expect(findEdge(graph, "ask#2", "join#1", 1)?.type).toBe("Verdict");
    // The two same-actor producers collapse into one actor edge aggregating both types.
    const actor = toActorGraph(graph);
    expect(actor.edges.find((e) => e.from === "actor#1" && e.to === "actor#2")?.types).toEqual([
      "Draft",
      "Verdict",
    ]);
  });

  it("omits an uninformative (void) fan-out type", () => {
    const graph = analyze(`
const paths = await files.glob("*.ts");
paths.forEach((p) => { void agent("w").ask<string>(p); });
return paths.length;
`);
    const fanout = graph.nodes.find((node) => node.kind === "fan-out");
    expect(fanout).toBeDefined();
    expect(fanout?.artifactType).toBeUndefined(); // forEach result is `void` -> no label
  });

  it("unwraps the facade wrapper through nested fan-out array levels", () => {
    const graph = analyze(`
const rows = await files.glob("*.md");
const out = rows.map((r) => [r].map((c) => agent("w").ask<string>(c)));
return out;
`);
    // The outer map's collected type is Node<string>[][]; both array levels and the
    // Node<> wrapper peel, so the label is string[][] — never Node<...>.
    const fanouts = graph.nodes.filter((node) => node.kind === "fan-out");
    expect(fanouts.some((f) => f.artifactType === "string[][]")).toBe(true);
    expect(fanouts.every((f) => !(f.artifactType ?? "").includes("Node<"))).toBe(true);
  });

  it("escapes embedded quotes in serialized message and producer types", () => {
    const graph = analyze(`
const a = agent("a");
const decision = await a.ask<"yes" | "no">("decide");
const out = await a.ask<string>(\`route \${decision}\`);
return out;
`);
    // Site node/edge type= and actor-edge types= all escape embedded quotes as \\".
    const site = serializeGraph(graph);
    // The ask#1 producer node and its outgoing data edge both carry the escaped union.
    expect(site).toContain('node ask#1 "a" ');
    expect(site).toContain('type="\\"yes\\" | \\"no\\""');
    const actor = serializeActorGraph(toActorGraph(graph));
    expect(actor).toContain('types="\\"yes\\" | \\"no\\""'); // self-edge message on actor#1
  });
});

// The facade-siting rule (docs/analysis.md, "Diagnostics"): facade
// callables are second-class and may appear only as the callee of a
// direct call. Any escape into value space — aliasing, method extraction, `.bind`,
// passing a facade function as an argument, a computed member call — has no site and
// is rejected. The diagnostic surfaces through analyzeWorkflowScript with ok=false
// and no graph, exactly like a typechecker diagnostic.
describe("facade-siting diagnostics", () => {
  // Asserts a rejection carrying a diagnostic that names `name` at `line:column`. The
  // reference scan and the defense-in-depth pass can both flag one escape (the second
  // is a redundant safety net), so we assert the specific diagnostic is present rather
  // than pin the total count.
  function expectRejected(
    script: string,
    expected: { column: number; line: number; name: string },
  ): void {
    const result = analyzeWorkflowScript(script);
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
    const match = result.diagnostics.find(
      (d) => d.line === expected.line && d.column === expected.column,
    );
    expect(
      match,
      `expected a diagnostic at ${expected.line}:${expected.column}; got ${JSON.stringify(result.diagnostics)}`,
    ).toBeDefined();
    expect(match?.code).toBe(FACADE_SITING_CODE);
    expect(match?.message).toContain(`facade function '${expected.name}' may only be called directly`);
  }

  function expectAccepted(script: string): void {
    const result = analyzeWorkflowScript(script);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.graph).toBeDefined();
  }

  it("rejects const-aliasing the agent factory (const spawn = agent)", () => {
    expectRejected(
      `const spawn = agent;\nconst worker = spawn("worker");\nconst a = await worker.ask<string>("task A");\nreturn a;`,
      { column: 15, line: 1, name: "agent" },
    );
  });

  it("rejects extracting an ask method (const f = planner.ask)", () => {
    expectRejected(
      `const planner = agent("planner");\nconst f = planner.ask;\nconst out = await f("go");\nreturn out;`,
      { column: 19, line: 2, name: "ask" },
    );
  });

  it("rejects .bind on an ask method (const g = reviewer.ask.bind(reviewer))", () => {
    // The inner `reviewer.ask` is a non-callee reference (it is the receiver of `.bind`).
    expectRejected(
      `const reviewer = agent("reviewer");\nconst g = reviewer.ask.bind(reviewer);\nconst review = await g("review");\nreturn review;`,
      { column: 20, line: 2, name: "ask" },
    );
  });

  it("rejects a parenthesized callee ((planner.ask)(…)) — deliberate conservatism", () => {
    // Semantically `(planner.ask)("write")` is still a direct method call (parentheses
    // preserve the reference), but "direct" in the siting rule is syntactic: the site
    // collector does not see through the parens, so allowing the form would leave the
    // call unsited. Rejecting errs on the safe side for a form with no reason to exist.
    expectRejected(
      `const planner = agent("planner");\nconst draft = await (planner.ask)("write");\nreturn draft;`,
      { column: 30, line: 2, name: "ask" },
    );
  });

  it("rejects a non-null-asserted callee (planner.ask!(…)) — same conservatism", () => {
    // The callee is a NonNullExpression, not a PropertyAccess, so the collector never
    // sites the call; the reference scan flags `planner.ask` in non-callee position
    // (and the defense-in-depth pass redundantly flags the unsited facade call).
    expectRejected(
      `const planner = agent("planner");\nconst out = await planner.ask!("go");\nreturn out;`,
      { column: 27, line: 2, name: "ask" },
    );
  });

  it("rejects an as-any-cast callee ((planner.ask as any)(…))", () => {
    // Casting to `any` erases the call signature, blinding the defense-in-depth pass —
    // the reference scan is what still resolves `planner.ask` to the facade method
    // symbol in non-callee position and rejects the escape.
    expectRejected(
      `const planner = agent("planner");\nconst out = await (planner.ask as any)("go");\nreturn out;`,
      { column: 28, line: 2, name: "ask" },
    );
  });

  it("rejects a conditional-expression callee ((flag ? files.read : files.glob)(…))", () => {
    // A dynamically-selected facade FUNCTION (unlike a dynamically-selected ask
    // receiver, which is accepted below): the callee is a ConditionalExpression, so
    // neither branch's call would be sited; both branch references are flagged.
    expectRejected(
      `const flag = "x".length > 1;\nconst c = await (flag ? files.read : files.glob)("ws/x");\nreturn c.length;`,
      { column: 31, line: 2, name: "read" },
    );
  });

  it("rejects passing files.read as a callback argument", () => {
    expectRejected(
      `const paths = await files.glob("*.ts");\nconst bodies = await Promise.all(paths.map(files.read));\nreturn bodies.join("");`,
      { column: 50, line: 2, name: "read" },
    );
  });

  it("rejects passing log as a callback argument", () => {
    expectRejected(
      `const items = ["a", "b"];\nitems.forEach(log);\nconst out = await agent("a").ask<string>("go");\nreturn out;`,
      { column: 15, line: 2, name: "log" },
    );
  });

  it("rejects a computed facade call the collector cannot site (defense in depth)", () => {
    // `files["read"](x)` has no callee symbol for the reference scan and never
    // registers as a world-read site; the signature-resolved defense-in-depth pass
    // catches it. It is the sole diagnostic — the reference scan sees nothing here.
    const result = analyzeWorkflowScript(`const body = await files["read"]("x");\nreturn body;`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: FACADE_SITING_CODE,
      column: 20,
      line: 1,
    });
    expect(result.diagnostics[0]?.message).toContain("facade function 'read'");
  });

  it("accepts a dynamically-selected ask receiver (ternary)", () => {
    // The spec allows dynamic receivers; it is the function VALUE that must not escape.
    expectAccepted(
      `const a = agent("a");\nconst b = agent("b");\nconst useA = Math.random() > 0.5;\nconst out = await (useA ? a : b).ask<string>("go");\nreturn out;`,
    );
  });

  it("accepts an agent-array indexed receiver", () => {
    expectAccepted(
      `const agents = [agent("a"), agent("b")];\nconst out = await agents[0]!.ask<string>("go");\nreturn out;`,
    );
  });

  it("accepts binding the files object and calling through it (still sites)", () => {
    // Binding the `files` OBJECT (not a callable) is allowed: `f.read(...)` still
    // resolves to the facade method and registers as a world-read site.
    expectAccepted(`const f = files;\nconst body = await f.read("x");\nreturn body;`);
  });

  it("accepts a clean planner-reviewer control script", () => {
    expectAccepted(
      `const planner = agent("planner");\nconst draft = await planner.ask<string>("draft");\nconst reviewer = agent("reviewer");\nconst review = await reviewer.ask<string>(\`review: \${draft}\`);\nreturn review;`,
    );
  });

  // Round-2 hardening: destructuring EXTRACTION of a facade callable. A shorthand
  // binding identifier resolves to the freshly-declared local, so the plain identifier
  // scan is blind to it; the fix flags at the extraction site by resolving the source
  // property on the destructured value's type. See docs "Diagnostics".
  it("rejects shorthand destructuring of an ask method (const { ask } = planner)", () => {
    expectRejected(
      `const planner = agent("planner");\nconst { ask } = planner;\nconst topics = ["a", "b", "c"];\nconst answers = await Promise.all(topics.map(ask));\nreturn answers.join("\\n");`,
      { column: 9, line: 2, name: "ask" },
    );
  });

  it("rejects shorthand destructuring of files.read behind a bare .map callback", () => {
    // The dossier bypass: `const { read } = files` launders the facade method into an
    // opaque local, and `paths.map(read)` keeps it out of direct-callee position, so
    // both the pre-fix passes missed it. Now rejected at the extraction.
    expectRejected(
      `const { read } = files;\nconst paths = await files.glob("src/**/*.ts");\nconst bodies = await Promise.all(paths.map(read));\nreturn bodies.join("\\n");`,
      { column: 9, line: 1, name: "read" },
    );
  });

  it("rejects a renamed destructuring binding ({ ask: myAsk })", () => {
    expectRejected(
      `const planner = agent("planner");\nconst { ask: myAsk } = planner;\nconst out = await myAsk("go");\nreturn out;`,
      { column: 9, line: 2, name: "ask" },
    );
  });

  it("rejects a nested destructuring pattern ({ a: { ask } })", () => {
    expectRejected(
      `const planner = agent("planner");\nconst box = { a: planner };\nconst { a: { ask } } = box;\nconst out = await ask("go");\nreturn out;`,
      { column: 14, line: 3, name: "ask" },
    );
  });

  it("rejects destructuring an ask method in parameter position (function f({ ask }: Agent))", () => {
    expectRejected(
      `async function f({ ask }: Agent): Promise<string> {\n  return await ask("go");\n}\nconst planner = agent("planner");\nreturn await f(planner);`,
      { column: 20, line: 1, name: "ask" },
    );
  });

  it("rejects a destructuring assignment onto a pre-declared var (({ ask } = planner))", () => {
    expectRejected(
      `const planner = agent("planner");\nlet ask: Agent["ask"];\n({ ask } = planner);\nconst out = await ask("go");\nreturn out;`,
      { column: 4, line: 3, name: "ask" },
    );
  });

  it("rejects a destructured facade method routed through a script-locally-typed helper", () => {
    // Dossier repro 3: routing the extracted `read` through `run(fn: (p) => …)` (a
    // script-local function type) defeats the defense-in-depth signature check. Flagging
    // at the `const { read } = files` extraction rejects it before the indirection matters.
    expectRejected(
      `const { read } = files;\nfunction run(fn: (p: string) => Promise<string>): Promise<string> {\n  return fn("config.json");\n}\nconst body = await run(read);\nreturn body;`,
      { column: 9, line: 1, name: "read" },
    );
  });

  it("accepts destructuring a non-facade member (the length of an ask result)", () => {
    // Only facade CALLABLES are second-class; destructuring the RESULT of an ask (a plain
    // string) is ordinary data flow and must stay accepted.
    expectAccepted(
      `const planner = agent("planner");\nconst { length } = await planner.ask<string>("x");\nreturn String(length);`,
    );
  });

  it("accepts destructuring a plain (non-facade) object", () => {
    // `const { o } = wrap` off a plain object binds a live field, not a facade callable —
    // this is the destructure-alias fixture shape and must not start rejecting.
    expectAccepted(
      `const wrap = { o: { f: "" } };\nconst { o } = wrap;\nconst secret = await agent("writer").ask<string>("secret");\no.f = secret;\nconst out = await agent("reader").ask<string>(\`use \${wrap.o.f}\`);\nreturn out;`,
    );
  });

  // Round-3 hardening (CRITICAL): structural retyping launders facade symbols.
  // TypeScript resolves members by declared type, so casting or parameter-typing a
  // facade value to a structurally-compatible LOCAL interface makes `.ask` / `.read`
  // resolve to the local declaration — the reference scan sees a non-facade symbol and
  // the defense-in-depth pass's resolved signature points at the local type, so neither
  // pre-fix pass fires and the real facade call runs UNSITED. The retyping-boundary pass
  // flags the conversion of a value carrying a facade site member to a type carrying none.
  it("rejects casting the agent receiver to a local interface (planner as Askable)", () => {
    expectRejected(
      `interface Askable { ask(instructions: string): PromiseLike<string>; }\nconst planner = agent("planner");\nconst seed = await agent("seed").ask<string>("seed");\nconst disguised = planner as Askable;\nconst out = await disguised.ask(\`route \${seed}\`);\nreturn out;`,
      { column: 19, line: 4, name: "ask" },
    );
  });

  it("rejects passing the agent into a locally-typed helper parameter (run(a: Askable))", () => {
    expectRejected(
      `interface Askable { ask(instructions: string): PromiseLike<string>; }\nfunction run(a: Askable, p: string): PromiseLike<string> {\n  return a.ask(\`route \${p}\`);\n}\nconst planner = agent("planner");\nconst seed = await agent("seed").ask<string>("seed");\nconst out = await run(planner, seed);\nreturn out;`,
      { column: 23, line: 7, name: "ask" },
    );
  });

  it("rejects casting the files object to a local reader interface (files as Reader)", () => {
    expectRejected(
      `interface Reader { read(path: string): Promise<string>; }\nconst seed = await agent("seed").ask<string>("pick a path");\nconst fs = files as Reader;\nconst contents = await fs.read(\`workspace/\${seed}\`);\nconst out = await agent("consumer").ask<string>(\`use \${contents}\`);\nreturn out;`,
      { column: 12, line: 3, name: "read" },
    );
  });

  it("accepts retyping an ask RESULT (a Node/awaited value carries no site member)", () => {
    // The retyping boundary keys on the site member, not on any facade-declared symbol:
    // `Node<T>` exposes only `then` and the awaited value is a primitive, so annotating or
    // passing an ask result is ordinary data flow and must stay accepted.
    expectAccepted(
      `const planner = agent("planner");\nconst n: PromiseLike<string> = planner.ask<string>("x");\nconst s: string = await n;\nreturn s;`,
    );
  });

  it("accepts generic passthrough of the agent handle (identity<T>(x: T))", () => {
    // The instantiated parameter type IS `Agent` (facade), so `.ask` still resolves to the
    // facade site — no laundering, no diagnostic. Uses resolved/contextual types, not the
    // raw generic, so this legitimate pattern is not over-rejected.
    expectAccepted(
      `function identity<T>(x: T): T {\n  return x;\n}\nconst planner = identity(agent("planner"));\nconst out = await planner.ask<string>("go");\nreturn out;`,
    );
  });

  // Round-3 hardening: the same laundering through an ASSIGNMENT into an already-typed
  // slot rather than a declaration/cast/parameter. `let d: Askable; d = planner` is the
  // first thing anyone writes; without the assignment-boundary arm the reassigned handle
  // runs `.ask` unsited exactly like the cast form.
  it("rejects assigning the agent into a locally-typed binding (d = planner)", () => {
    expectRejected(
      `interface Askable { ask(instructions: string): PromiseLike<string>; }\nconst planner = agent("planner");\nlet d: Askable = { ask: async (s: string) => s };\nd = planner;\nconst out = await d.ask("go");\nreturn out;`,
      { column: 5, line: 4, name: "ask" },
    );
  });

  it("rejects assigning the agent into a locally-typed property (slot.a = planner)", () => {
    expectRejected(
      `interface Askable { ask(instructions: string): PromiseLike<string>; }\nconst planner = agent("planner");\nconst slot: { a: Askable } = { a: { ask: async (s: string) => s } };\nslot.a = planner;\nconst out = await slot.a.ask("go");\nreturn out;`,
      { column: 10, line: 4, name: "ask" },
    );
  });

  it("rejects assigning the agent into a locally-typed array element (arr[0] = planner)", () => {
    expectRejected(
      `interface Askable { ask(instructions: string): PromiseLike<string>; }\nconst planner = agent("planner");\nconst arr: Askable[] = [{ ask: async (s: string) => s }];\narr[0] = planner;\nconst out = await arr[0]!.ask("go");\nreturn out;`,
      { column: 10, line: 4, name: "ask" },
    );
  });

  it("accepts an evolving-any binding assigned an agent (let x; x = agent(...))", () => {
    // An un-annotated `let` narrows to `Agent` at the use, so `.ask` still resolves to the
    // facade and the call IS sited — this is not a laundering boundary, only an explicit
    // `: any`/`: unknown` annotation is. The assignment-boundary arm must not flag it.
    expectAccepted(`let x;\nx = agent("planner");\nconst out = await x.ask<string>("go");\nreturn out;`);
  });

  // ————————————————————————————————————————————————————————————————
  // The git.log / log() collision (docs/execution-engine.md, "The world-read registry")
  // ————————————————————————————————————————————————————————————————
  // These are the tests that would have caught a bare-name implementation of the
  // registry. `git.log` and the top-level `log` share a member name and nothing else:
  // one is a world-read site subject to the facade-siting rule, the other is chatter
  // that is deliberately outside it. A name-keyed rule has to get one of them wrong.

  it("accepts a script calling both git.log and the top-level log", () => {
    // The positive half of the collision: both spellings, in one script, both legal.
    // A bare-name set that included `log` would mint a world-read site for every progress
    // message; one that excluded it would leave `git.log` unsited — and a facade call with
    // no site has no journal key, which is the unsoundness the siting rule exists to stop.
    expectAccepted(
      `log("starting");\nconst commits = await git.log(5);\nlog(\`saw \${commits.length}\`);\nconst out = await agent("a").ask<string>(commits.map((c) => c.subject).join("; "));\nreturn out;`,
    );
  });

  it("rejects aliasing git.log while the plain log stays legal in the same script", () => {
    // `const l = git.log` is method extraction, exactly like `const f = planner.ask`.
    // The diagnostic names 'log' — resolved from the SYMBOL, so it is git's member, not
    // the top-level function that appears untouched two lines later.
    expectRejected(
      `const l = git.log;\nlog("still fine");\nconst commits = await l(5);\nreturn commits.length;`,
      { column: 15, line: 1, name: "log" },
    );
  });

  it("accepts passing the top-level log's own name around as a direct call target only", () => {
    // Sanity in the other direction: the top-level `log` is still second-class (already
    // covered above by the `items.forEach(log)` rejection), but a direct call is legal
    // even in a script that also holds a git world read. This pins that `git.log`'s
    // arrival did not accidentally pull the top-level `log` into world-read siting.
    const result = analyzeWorkflowScript(
      `const s = await git.status();\nlog(\`clean=\${s.clean}\`);\nreturn s.branch ?? "detached";`,
    );
    expect(result.diagnostics).toEqual([]);
    const table = collectSites(createWorkflowProgram(
      `const s = await git.status();\nlog(\`clean=\${s.clean}\`);\nreturn s.branch ?? "detached";`,
    ));
    expect(table.worldReads.map((site) => site.op)).toEqual(["git-status"]);
  });

  it("rejects aliasing files.grep", () => {
    expectRejected(
      `const g = files.grep;\nconst hits = await g("TODO");\nreturn hits.length;`,
      { column: 17, line: 1, name: "grep" },
    );
  });

  it("rejects computed access to the new members (defense in depth)", () => {
    // Computed member access has no callee symbol for the reference scan and never
    // registers as a site; the signature-resolved defense-in-depth pass is the only
    // thing between `files["grep"](p)` and an unsited world read.
    expectRejected(`const hits = await files["grep"]("TODO");\nreturn hits.length;`, {
      column: 20,
      line: 1,
      name: "grep",
    });
    expectRejected(`const s = await git["status"]();\nreturn s.clean;`, {
      column: 17,
      line: 1,
      name: "status",
    });
    expectRejected(`const c = await git["log"](3);\nreturn c.length;`, {
      column: 17,
      line: 1,
      name: "log",
    });
  });

  it("rejects retyping the git container to a structurally-compatible local type", () => {
    // The laundering shape from round 3, applied to the new container: the local
    // interface's `log` resolves to the LOCAL declaration, so the call would run unsited.
    expectRejected(
      `interface Historian { log(n?: number): Promise<{ hash: string; subject: string; author: string; date: string }[]>; }\nconst h = git as Historian;\nconst commits = await h.log(3);\nreturn commits.length;`,
      { column: 11, line: 2, name: "log" },
    );
  });

  it("accepts binding the git object and calling through it (still sites)", () => {
    // Binding the CONTAINER (not a callable) is allowed, same as `const f = files`:
    // `g.status()` still resolves to the facade method and registers as a world read.
    expectAccepted(`const g = git;\nconst s = await g.status();\nreturn s.clean;`);
  });

  it("accepts a script-local object that merely shares the git member names", () => {
    // Identity is declaration-based, so a hand-rolled `myGit.log()` is ordinary code.
    expectAccepted(
      `const myGit = { log(n: number): number { return n; }, status(): string { return "clean"; } };\nreturn myGit.status() + String(myGit.log(1));`,
    );
  });
});

// report 站点（execution-engine.md 的 "Progressive results"，docs/analysis.md 的
// 「Sites」）。三件事在这里钉住：站点身份存在且有自己的
// per-kind 计数器、facade-siting 规则确实约束它、以及它对两张图**完全没有**影响。
describe("report sites", () => {
  const table = (scriptText: string) => collectSites(createWorkflowProgram(scriptText));

  it("mints report#N on its own per-kind counter and captures the item expression", () => {
    const t = table(
      `report("one");\nconst out = await agent("a").ask<string>("go");\nreport({ out });\nreturn out;`,
    );
    expect(t.reports.map((site) => site.id)).toEqual(["report#1", "report#2"]);
    // 实参被捕获（编译侧的可序列化检查读它），但**不进** taint 的 sink 集合。
    expect(t.reports.every((site) => site.item !== undefined)).toBe(true);
    expect(t.reports[0]?.loc).toEqual({ column: 1, line: 1 });
  });

  it("leaves every other per-kind id counter bit-for-bit unchanged", () => {
    // 站点 id 稳定性规则真正保护的那条不变式：report 有自己的计数器，所以在 ask 之间插
    // report 不会挪动任何 ask#N / actor#N / world-read#N。它只消耗全局 `order` 发现序，
    // 而 order 只是输出的归并键（execution-engine.md 的 "Site-id stability"）。
    const withoutReports = table(
      `const a = agent("a");\nconst paths = await files.glob("src/**");\nconst x = await a.ask<string>("1");\nconst y = await a.ask<string>("2");\nreturn [x, y, paths.length];`,
    );
    const withReports = table(
      `const a = agent("a");\nreport("start");\nconst paths = await files.glob("src/**");\nreport({ n: paths.length });\nconst x = await a.ask<string>("1");\nreport(x);\nconst y = await a.ask<string>("2");\nreturn [x, y, paths.length];`,
    );
    const ids = (t: ReturnType<typeof table>) => ({
      actors: t.actors.map((s) => s.id),
      asks: t.asks.map((s) => s.id),
      worldReads: t.worldReads.map((s) => s.id),
    });
    expect(ids(withReports)).toEqual(ids(withoutReports));
    expect(withReports.reports.map((s) => s.id)).toEqual(["report#1", "report#2", "report#3"]);
    expect(withoutReports.reports).toEqual([]);
  });

  it("mints no report site for a script-local function of the same name", () => {
    // 身份按声明判定，与 registry 的其余部分一致。
    const t = table(
      `const report = (item: unknown): void => { void item; };\nreport({ a: 1 });\nreturn 1;`,
    );
    expect(t.reports).toEqual([]);
  });

  it("draws no node and no edge in either graph", () => {
    // report 发的是进度而不是次序：没有什么能等它，也就没有什么可以让一条边去表示。
    const result = analyzeWorkflowScript(
      `const a = agent("a");\nconst out = await a.ask<string>("go");\nreport({ out });\nreturn out;`,
    );
    expect(result.ok).toBe(true);
    const text = serializeGraph(result.graph!);
    expect(text).not.toContain("report");
    expect(result.graph!.nodes.some((n) => n.id.startsWith("report#"))).toBe(false);
    expect(result.graph!.edges.some((e) => e.from.startsWith("report#") || e.to.startsWith("report#"))).toBe(false);
    expect(result.causality!.steps.some((s) => s.id.startsWith("report#"))).toBe(false);
  });

  it("leaves all three serialized graphs byte-identical when reports are added between asks", () => {
    // 上一条证明 report 不画自己，这一条证明它不**扰动**别人——包括实参没有被当作 sink
    // （否则 `plan` 流进 report 会多出一条 data 边）。这是那条排除规则最容易悄悄破掉的一半。
    const base =
      `interface Plan { steps: string[]; }\nconst p = agent("p");\nconst r = agent("r");\nconst plan = await p.ask<Plan>("draft");\nconst first = await r.ask<string>(plan.steps[0] ?? "x");\nreturn first;`;
    const reported =
      `interface Plan { steps: string[]; }\nconst p = agent("p");\nconst r = agent("r");\nconst plan = await p.ask<Plan>("draft");\nreport(plan);\nreport({ n: plan.steps.length });\nconst first = await r.ask<string>(plan.steps[0] ?? "x");\nreport(first);\nreturn first;`;
    const a = analyzeWorkflowScript(base);
    const b = analyzeWorkflowScript(reported);
    expect(a.ok && b.ok).toBe(true);
    // 位置行号会因插入的行而变，所以比对的是去掉 @line:col 之后的图结构。
    const strip = (text: string): string => text.replace(/ @\d+:\d+/g, "");
    expect(strip(serializeGraph(b.graph!))).toBe(strip(serializeGraph(a.graph!)));
    expect(strip(serializeActorGraph(toActorGraph(b.graph!)))).toBe(
      strip(serializeActorGraph(toActorGraph(a.graph!))),
    );
  });
});

// report 落在 facade-siting 规则的**产生站点**那一半（而不是 log 那一半仅受限的半边）：
// 它有一行按站点建键的 journal，所以身份论证对它完全成立（docs/analysis.md）。
describe("report facade-siting", () => {
  it("rejects const-aliasing report (const r = report)", () => {
    const result = analyzeWorkflowScript(`const r = report;\nr({ a: 1 });\nreturn 1;`);
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
    const match = result.diagnostics.find((d) => d.line === 1 && d.column === 11);
    expect(match?.code).toBe(FACADE_SITING_CODE);
    expect(match?.message).toContain("facade function 'report' may only be called directly");
  });

  it("rejects passing report as an argument", () => {
    const result = analyzeWorkflowScript(
      `function emit(f: (item: unknown) => void): void { f({ a: 1 }); }\nemit(report);\nreturn 1;`,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === FACADE_SITING_CODE)).toBe(true);
  });

  it("accepts a direct report call (no misuse diagnostic for the sited form)", () => {
    // 反向防线：report 加入产生站点的清单之后，**普通用法**绝不能被 pass 2 误伤——
    // 那一趟拒绝的是"产生站点却没被 site 掉"的调用，所以站点表必须收录 report。
    const result = analyzeWorkflowScript(
      `const a = agent("a");\nconst out = await a.ask<string>("go");\nreport({ out });\nlog("done");\nreturn out;`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
