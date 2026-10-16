import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript } from "../src/index.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

/**
 * Fixpoint convergence pins (docs/analysis.md, "Convergence": the canonical-heap rule).
 *
 * The taint fixpoint is gen-only over a finite lattice, so the only way it fails to settle
 * is a transfer that reports a change every pass without the state growing: a persistent
 * merge INTO a value that is recreated each pass. Each case here is a shape that once did
 * exactly that. The assertion is the analysis completing at all — `analyzeWorkflowScript`
 * throws at ITERATION_CAP — plus, where the fix changed what the graph can see, the fact it
 * now sees.
 */

function analyze(script: string) {
  const result = analyzeWorkflowScript(script);
  expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
  const causality = result.causality;
  if (causality === undefined) throw new Error("expected a causality graph");
  return { causality, result };
}

const hasEdge = (edges: ReadonlyArray<{ from: string; to: string }>, from: string, to: string): boolean =>
  edges.some((edge) => edge.from === from && edge.to === to);

describe("convergence — container literals are allocation-site places", () => {
  it("converges when a callee writes a NEW field through a parameter bound to an inline object literal", () => {
    // The minimal shape: nothing here is exotic. Before literals had a persistent place this
    // failed on every analyzer generation since 2026-08-17.
    analyze(`
function tag(box: { name: string; note?: string }, t: string): void { box.note = t; }
const t = await agent("s").ask<string>("q");
tag({ name: "x" }, t);
return t;
`);
  });

  it("converges for an inline array literal mutated by the callee", () => {
    analyze(`
function fill(xs: string[], t: string): void { xs.push(t); }
const t = await agent("s").ask<string>("q");
fill([], t);
return t;
`);
  });

  it("converges when the write-back carries no taint at all", () => {
    // The re-reported change was the write-back's own doing, not the data it carried.
    analyze(`
function tag(box: { name: string; note?: string }, t: string): void { box.note = t; }
tag({ name: "x" }, "plain");
return await agent("s").ask<string>("q");
`);
  });

  it("converges for a nested literal argument written through two levels", () => {
    analyze(`
function deep(p: { inner: { items: string[] } }, t: string): void { p.inner.items.push(t); }
const t = await agent("s").ask<string>("q");
deep({ inner: { items: [] } }, t);
return t;
`);
  });

  it("makes the field written on the literal visible through the reference the callee returns", () => {
    // Persistence is not only about termination: the note now survives to the reader.
    const { causality } = analyze(`
function tag(box: { name: string; note?: string }, t: string): { name: string; note?: string } {
  box.note = t;
  return box;
}
const t = await agent("writer").ask<string>("draft");
const r = tag({ name: "x" }, t);
return agent("reader").ask<string>(\`use \${r.note}\`);
`);
    expect(hasEdge(causality.edges, "ask#1", "ask#2")).toBe(true);
  });

  it("keeps a literal's field that stores a live place aliased to that place", () => {
    // `{ box }` stores box's slot itself; the persistent literal place must not turn that alias
    // into a copy on later passes (heap-aliasing-param-literal-wrap pins the golden).
    const { causality } = analyze(`
const box: { f: string } = { f: "" };
async function poke(p: { box: { f: string } }): Promise<void> {
  p.box.f = await agent("writer").ask<string>("secret");
}
await poke({ box });
return agent("reader").ask<string>(\`use \${box.f}\`);
`);
    expect(hasEdge(causality.edges, "ask#1", "ask#2")).toBe(true);
  });

  it("re-evaluates the literal every pass (a site inside it is never short-circuited)", () => {
    // The place is reached only through evaluation, never through resolvePlace, so the ask
    // nested in the literal keeps its node and its edge.
    const { causality } = analyze(`
const seed = await agent("seed").ask<string>("s");
const bundle = { text: await agent("writer").ask<string>(seed), tag: "x" };
return agent("reader").ask<string>(bundle.text);
`);
    expect(hasEdge(causality.edges, "ask#1", "ask#2")).toBe(true);
    expect(hasEdge(causality.edges, "ask#2", "ask#3")).toBe(true);
  });
});

describe("convergence — the keystone-leak family (recorded real scripts, 2026-09-03)", () => {
  // Seven recorded workflows stopped converging when a library member call started dispatching
  // on tracked functions carried by its receiver: the keystone pot had leaked the callback
  // itself into the result of `sort(cmp)` / `JSON.parse(text, reviver)`, so a later
  // `top.push({ … })` applied the callback with the literal as its actual and hit the
  // write-back above. Two independent tightenings close the path (the pot strips callables,
  // library members never dispatch on receiver fns); the literal place removes the cliff.
  it("sort comparator, then push of a literal into the sorted result", () => {
    analyze(`
interface C { name: string; confidence: number }
const candidates = await agent("s").ask<C[]>("q");
const top = candidates.sort((a, b) => b.confidence - a.confidence);
top.push({ name: "x", confidence: 0.5 });
return top;
`);
  });

  it("JSON.parse reviver (no registry entry), then push of a literal", () => {
    analyze(`
interface C { name: string; confidence: number }
const text = await agent("s").ask<string>("q");
const top = JSON.parse(text, (k, v) => v) as C[];
top.push({ name: "x", confidence: 0.5 });
return top;
`);
  });

  it("String.replace callback, then a literal pushed into a sibling field", () => {
    analyze(`
interface C { name: string; confidence: number }
const text = await agent("s").ask<string>("q");
const holder = { items: [] as C[], text: text.replace(/x/g, (m) => m.toUpperCase()) };
holder.items.push({ name: holder.text, confidence: 0.5 });
return holder;
`);
  });
});
