import { KIND_RANK } from "./causality-reduce.js";
import { holePrefixOf } from "./hole-id.js";
import {
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Fact,
  type OrderEdge,
  type Step,
} from "./causality-graph-types.js";

// causality-graph.ts 顶到 oxlint max-lines 上限（400 行），把成品图上的机械改写与
// 事实层的小工具（may-set 车道展开 expandMaySetLanes 及其两个常量、dedupeFacts、weakest）拆到
// 本文件；公开面仍从 causality-graph.ts 导出。本文件不 import `typescript`。

/**
 * Upper bound on an expandable may-set. Past it the step keeps its single card: a capped
 * may-set FALLS BACK rather than truncating, since dropping candidates would assert
 * something the analysis cannot. The cap keeps the multiplication (k steps, up to k² on a
 * self-carry) well inside the payload limits of 64 steps / 256 edges.
 */
const MAY_SET_LANE_CAP = 4;

/** Copy id separator: collides with neither `ask#3/2` nor the runtime's `ask#3@7`. */
const COPY_SEPARATOR = "~";

/**
 * The LAST pass: rewrite a may-set step into one copy per candidate lane.
 *
 * `(cond ? a : b).ask(p)` is the same program as `cond ? a.ask(p) : b.ask(p)`, and the
 * analyzer already draws the second form as one `maybe` step per lane. Drawing the first
 * form as a single card made the picture depend on where the ternary sits, and on a
 * script whose every ask is a may-set it left candidate lanes with no homed step at all —
 * which the mermaid emitter culls, erasing an actor from the workflow.
 *
 * This runs AFTER ordering and reduction by contract: reduction never sees copies, so
 * every reduction rule and its corpus behaviour are unchanged and this stays a mechanical
 * rewrite of the finished graph.
 */
export function expandMaySetLanes(graph: CausalityGraph): CausalityGraph {
  const copiesOf = new Map<string, Step[]>();
  for (const step of graph.steps) {
    const lanes = step.lanes ?? [];
    if (lanes.length < 2 || lanes.length > MAY_SET_LANE_CAP) continue;
    // `workspace` cannot occur in a may-set and `unknown` is only ever a lone lane, so
    // this guard is the invariant written down rather than a case the corpus reaches.
    if (lanes.some((lane) => lane === WORKSPACE_LANE || lane === UNKNOWN_LANE)) continue;
    copiesOf.set(
      step.id,
      lanes.map((lane) => ({
        ...step,
        // The ask always runs; each copy may not. Certainty is per-node and the node
        // changed meaning, so this is the one field overridden rather than inherited.
        certainty: "maybe" as const,
        id: `${step.id}${COPY_SEPARATOR}${lane}`,
        lane,
        source: step.id,
      })),
    );
  }
  if (copiesOf.size === 0) return graph;

  // An endpoint stands for either a step's copies, in `lanes` order, or the step itself.
  // The lane and the certainty ride along: `fifo` matches pairs on the lane, and every
  // rewritten edge re-derives its certainty from the endpoints it actually connects.
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));
  const endpointsOf = (id: string): { certainty?: Certainty; id: string; lane?: string }[] => {
    const copies = copiesOf.get(id);
    if (copies !== undefined) {
      return copies.map((copy) => ({ certainty: copy.certainty, id: copy.id, lane: copy.lane }));
    }
    const step = stepById.get(id);
    return [{ certainty: step?.certainty, id, lane: step?.lane }];
  };

  const edges: OrderEdge[] = [];
  for (const edge of graph.edges) {
    if (!copiesOf.has(edge.from) && !copiesOf.has(edge.to)) {
      // Untouched pair: the main pass already applied endpoint inheritance to it and
      // `weakest` is idempotent, so re-deriving here would be a no-op.
      edges.push(edge);
      continue;
    }
    // A `fifo` edge exists only because two steps MAY share a mailbox, so a copy on lane
    // M has no mailbox relation to anything on lane L != M and the cross-lane pairs are
    // garbage ink; if nothing matches, the edge goes. Every other kind fans out fully:
    // taint cannot tell which candidate produced or consumed a value, and restricting it
    // would invent precision. A self-`carry` therefore becomes the full k×k product — the
    // cross pairs AND the per-copy self-loops, since the analysis cannot rule out the same
    // candidate being selected in consecutive iterations.
    for (const tail of endpointsOf(edge.from)) {
      for (const head of endpointsOf(edge.to)) {
        if (edge.kind === "fifo" && tail.lane !== head.lane) continue;
        edges.push({
          ...edge,
          // Endpoint inheritance, re-applied to the copies rather than a special case: a
          // copy is `maybe`, so every edge incident to one weakens. This is what keeps
          // refactoring invariance honest — the branch form `cond ? a.ask(p) : b.ask(p)`
          // already yields `maybe` steps and `maybe` edges into them, and the expanded
          // ternary must agree or the two identical programs draw different certainty.
          certainty: weakest([
            edge.certainty,
            tail.certainty ?? edge.certainty,
            head.certainty ?? edge.certainty,
          ]),
          from: tail.id,
          to: head.id,
        });
      }
    }
  }

  const steps = graph.steps.flatMap((step) => copiesOf.get(step.id) ?? [step]);
  const sink = graph.sink;
  return {
    edges,
    lanes: graph.lanes,
    regions: graph.regions,
    steps,
    ...(sink === undefined
      ? {}
      : { sink: { fedBy: sink.fedBy.flatMap((id) => endpointsOf(id).map((end) => end.id)) } }),
  };
}

/** Collapse facts to one edge per ordered pair, keeping the strongest claim. */
export function dedupeFacts(facts: readonly Fact[]): Fact[] {
  const byPair = new Map<string, Fact>();
  for (const fact of facts) {
    const key = `${fact.from}|${fact.to}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      // The phase set is cloned, not aliased: the merge below mutates it in place and the
      // input facts must stay untouched.
      byPair.set(key, {
        ...fact,
        ...(fact.toPhases === undefined ? {} : { toPhases: new Set(fact.toPhases) }),
      });
      continue;
    }
    if (KIND_RANK[fact.kind] > KIND_RANK[existing.kind]) existing.kind = fact.kind;
    if (fact.exact !== undefined && existing.exact === undefined) existing.exact = fact.exact;
    else if (fact.exact === true) existing.exact = true;
    if (fact.certainty === "maybe") existing.certainty = "maybe";
    // 一条不经跳转就成立的事实让这一对回到普通前向边：全部贡献都只能靠下一轮，才算回边。
    if (fact.viaJump !== true) delete existing.viaJump;
    // ABSENT DOMINATES: one contributing fact with no provenance means the merged fact has
    // none, so it fans out fully. A `data` fact (never provenanced, and fanning out by
    // contract) merging onto a provenanced `seq` fact must not inherit that narrowing —
    // the pair is then ordered for reasons the barrier witness does not account for.
    if (fact.toPhases === undefined) delete existing.toPhases;
    else if (existing.toPhases !== undefined) {
      for (const phase of fact.toPhases) existing.toPhases.add(phase);
    }
  }
  return [...byPair.values()];
}

export function weakest(values: readonly Certainty[]): Certainty {
  return values.includes("maybe") ? "maybe" : "always";
}

/**
 * 写下这个站点的那次补全：站点 id 的 `hole#<hash>/` 前缀（只有一层，hole-id.ts）；体外的站点
 * 没有。留白自己的 id 不带前缀——它属于哪个留白记在站点表的 `fill` 上，调用方自己查
 * （docs/analysis.md「Sites」）。
 */
export function fillOf(siteId: string): string | undefined {
  return holePrefixOf(siteId);
}
