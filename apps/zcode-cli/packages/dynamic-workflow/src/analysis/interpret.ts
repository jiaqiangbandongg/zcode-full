import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";
import { provisionalFanoutId, type TaintFacts, type TaintOcc } from "./domain.js";
import { computeArtifactTypes, type ArtifactTypes } from "./artifact-types.js";
import { Evaluator } from "./taint.js";
import { traceOrder, type OrderTrace } from "./causality-order.js";
import { literalCardinality } from "./fanout-cardinality.js";
import type { ApplicationVia } from "./state.js";
import type {
  AnalysisCore,
  CoreActorSite,
  CoreAskSite,
  CoreFacts,
  CoreFanoutSite,
  CoreHoleSite,
  CoreSimpleSite,
  CoreSites,
  CoreTypes,
} from "./core.js";

/**
 * The fused interpreter: ONE interpretation of
 * the script that produces the {@link AnalysisCore}. Engine schedule:
 *
 *  1. the taint listener runs alone to a fixpoint ({@link Evaluator.converge} — global
 *     env, placeholder summaries, semantics untouched);
 *  2. ONE final temporal walk ({@link traceOrder}) rides the evaluation-order spine,
 *     reading the converged state directly as its oracle ({@link TaintState.emitOracle})
 *     — the settle-certainty judgements need converged facts, so logging events on
 *     earlier iterations would be waste plus per-iteration state resets for nothing.
 *     The order-insensitivity lemma makes this schedule safe: a gen-only, kill-free,
 *     monotone fixpoint's result does not depend on visitation order, so the temporal
 *     walk's evaluation order is not a second semantics.
 *  3. minting ({@link mintCore}) digests everything position- or checker-shaped into
 *     plain data: `within` containment resolved onto sites, provisional `fan-out@order`
 *     ids renamed to final `fan-out#N` everywhere (occurrences and type keys included),
 *     artifact types materialized as strings.
 *
 * Downstream, graph.ts / causality-graph.ts are pure projections of the core — no
 * `typescript` import, no AST, no checker.
 */
export function interpret(workflow: WorkflowProgram, table: SiteTable): AnalysisCore {
  const evaluator = new Evaluator(workflow, table);
  evaluator.converge();
  const facts = evaluator.s.emitFacts();
  const oracle = evaluator.s.emitOracle();
  const trace = traceOrder(workflow, table, oracle);
  return mintCore(workflow, table, facts, trace, oracle.applications);
}

/** Mint the core: the one place raw offsets and the checker are still consulted. */
function mintCore(
  workflow: WorkflowProgram,
  table: SiteTable,
  facts: TaintFacts,
  trace: OrderTrace,
  applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>,
): AnalysisCore {
  const { scriptFile } = workflow;

  // Fan-out ordinals over promoted candidates (already source-ordered), and the rename
  // from the taint pass's provisional ids. Moved here from graph assembly: the core
  // speaks final ids only, the provisional vocabulary dies at this boundary.
  const fanoutId = new Map<string, string>();
  facts.promoted.forEach((fanout, index) => fanoutId.set(fanout.id, `fan-out#${index + 1}`));
  const rename = (site: string): string => fanoutId.get(site) ?? site;

  // Fan-out containment: a site executes once per element when it sits in a promoted
  // candidate's BODY — lexically, or in the body of a function the candidate's body invokes
  // (a named callback `xs.map(review)`, a helper called from the inline callback, and so on
  // transitively, per the call oracle). "Nearest" = the innermost containing span, i.e. the
  // one with the greatest start offset.
  const spanOf = (node: ts.Node): { start: number; end: number } => ({ end: node.getEnd(), start: node.getStart(scriptFile) });
  const insideSpan = (pos: number, span: { start: number; end: number }): boolean => span.start <= pos && pos < span.end;
  const promotedSpans: Array<{ id: string; start: number; end: number }> = [];
  for (const cand of table.iterations) {
    const id = fanoutId.get(provisionalFanoutId(cand.order));
    if (id === undefined) continue;
    const seedSpans = [spanOf(cand.body)];
    if (cand.call !== undefined) {
      // A non-literal callback's body is the argument expression: no steps live in it, but
      // the functions applied AT the call do.
      for (const [fn, via] of applications.get(cand.call) ?? []) {
        if (via === "argument") seedSpans.push(spanOf(fn));
      }
    }
    // Closure: every function applied at a call site inside a span already in the set.
    const spans = [...seedSpans];
    const seen = new Set<ts.Node>();
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i] as { start: number; end: number };
      for (const [site, fns] of applications) {
        if (!insideSpan(site.getStart(scriptFile), span)) continue;
        for (const fn of fns.keys()) {
          if (seen.has(fn)) continue;
          seen.add(fn);
          spans.push(spanOf(fn));
        }
      }
    }
    for (const span of spans) promotedSpans.push({ id, ...span });
  }
  const within = (pos: number): string | undefined => {
    let best: { id: string; start: number } | undefined;
    for (const span of promotedSpans) {
      if (insideSpan(pos, span) && (best === undefined || span.start > best.start)) {
        best = { id: span.id, start: span.start };
      }
    }
    return best?.id;
  };
  const withinOf = (node: ts.Node): { within?: string } => {
    const enclosing = within(node.getStart(scriptFile));
    return enclosing === undefined ? {} : { within: enclosing };
  };

  const asks: CoreAskSite[] = table.asks.map((site) => ({
    id: site.id,
    label: site.label,
    ...(site.labelPattern === undefined ? {} : { labelPattern: site.labelPattern }),
    loc: site.loc,
    order: site.order,
    ...withinOf(site.call),
  }));
  const simple = (site: { id: string; order: number; label: string; loc: CoreSimpleSite["loc"]; call: ts.Node }): CoreSimpleSite => ({
    id: site.id,
    label: site.label,
    loc: site.loc,
    order: site.order,
    ...withinOf(site.call),
  });
  const actors: CoreActorSite[] = table.actors.map((site) => ({
    id: site.id,
    loc: site.loc,
    ...(site.name === undefined ? {} : { name: site.name }),
    ...(site.namePattern === undefined ? {} : { namePattern: site.namePattern }),
    order: site.order,
    ...withinOf(site.call),
  }));
  // A fan-out's own containment is anchored at its iterated expression, which sits
  // outside its own body — so a candidate never reports itself, only an enclosing one.
  const candByOrder = new Map(table.iterations.map((cand) => [cand.order, cand]));
  const checker = workflow.program.getTypeChecker();
  const fanouts: CoreFanoutSite[] = facts.promoted.map((fanout) => {
    const cand = candByOrder.get(fanout.order);
    // 字面量基数也是铸造期的事：它要看被迭代表达式的 AST 与绑定，投影只读一个数。
    const cardinality = cand === undefined ? undefined : literalCardinality(cand.iterated, checker);
    return {
      id: fanoutId.get(fanout.id) as string,
      label: fanout.label,
      loc: fanout.loc,
      order: fanout.order,
      ...(cand === undefined ? {} : withinOf(cand.iterated)),
      ...(cardinality === undefined ? {} : { cardinality }),
    };
  });
  // 只有开放的留白是站点（docs/analysis.md「Sites」）：已补全的留白是一个阶段，不是一步。
  // 名字 / 类型缺席的留白在 9012 处已挡下，这里的兜底只是把不变量写下来。
  const holes: CoreHoleSite[] = table.holes
    .filter((site) => site.body === undefined)
    .map((site) => ({
      ...(site.fill === undefined ? {} : { fill: site.fill }),
      id: site.id,
      loc: site.loc,
      name: site.name ?? site.id,
      order: site.order,
      ...(site.tail ? { tail: true as const } : {}),
      type: site.typeText ?? "unknown",
      ...withinOf(site.call),
    }));
  const sites: CoreSites = {
    actors,
    asks,
    fanouts,
    holes,
    joins: table.joins.map(simple),
    worldReads: table.worldReads.map(simple),
  };

  return {
    facts: mintFacts(facts, fanoutId, rename),
    sites,
    trace,
    types: mintTypes(computeArtifactTypes(workflow, table), rename),
  };
}

/** Rewrite every occurrence and every `fanoutIn` key to final ids; drop non-promoted
 * fan-out sinks (a candidate that never promoted is a graph node in nothing — the same
 * `continue` graph assembly used to apply at edge emission). */
function mintFacts(
  facts: TaintFacts,
  fanoutId: Map<string, string>,
  rename: (site: string) => string,
): CoreFacts {
  const renameOccs = (occs: TaintOcc[]): TaintOcc[] =>
    occs.map((occ) => ({ exact: occ.exact, site: rename(occ.site), ...(occ.port === undefined ? {} : { port: occ.port }) }));
  const renameMap = (map: Map<string, TaintOcc[]>): Map<string, TaintOcc[]> => {
    const out = new Map<string, TaintOcc[]>();
    for (const [sink, occs] of map) out.set(sink, renameOccs(occs));
    return out;
  };
  const fanoutIn = new Map<string, TaintOcc[]>();
  for (const [provId, occs] of facts.fanoutIn) {
    const finalId = fanoutId.get(provId);
    if (finalId === undefined) continue;
    fanoutIn.set(finalId, renameOccs(occs));
  }
  return {
    askActor: renameMap(facts.askActor),
    askData: renameMap(facts.askData),
    fanoutIn,
    holeData: renameMap(facts.holeData),
    joinIn: renameMap(facts.joinIn),
    returnData: renameOccs(facts.returnData),
    worldReadData: renameMap(facts.worldReadData),
  };
}

/** Rename the fan-out keys of the checker's type answers to final ids. */
function mintTypes(types: ArtifactTypes, rename: (site: string) => string): CoreTypes {
  const siteType = new Map<string, string>();
  for (const [id, type] of types.siteType) siteType.set(rename(id), type);
  return { joinPortTypes: types.joinPortTypes, siteType };
}
