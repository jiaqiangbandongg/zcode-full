import type { AnalysisCore } from "./core.js";
import { isStructuralRegionKind, type RegionKind } from "./constants.js";
import type { OrderRegion } from "./causality-order.js";
import { reduceOrdering, type OrderKind } from "./causality-reduce.js";
import {
  collectPhaseClaims,
  projectPhaseGraph,
  type PhaseSourceFact,
} from "./phase-graph.js";
import type { SiteGraph, SiteLoc, SiteNode } from "./types.js";
import { MAIN_LANE, SINK_ID, UNKNOWN_LANE, WORKSPACE_LANE } from "./causality-graph-types.js";
import type { CausalityGraph, Certainty, Fact, Lane } from "./causality-graph-types.js";
import type { OrderEdge, Region, Step, StepKind } from "./causality-graph-types.js";
import { dedupeFacts, expandMaySetLanes, fillOf, weakest } from "./causality-graph-lanes.js";

/** Re-exported so the causality vocabulary is importable from one module. */
export type { NamePattern } from "./types.js";
// 拆分：本文件顶到 oxlint max-lines 上限（400 行）。公开类型与三个 lane 常量定义
// 在 causality-graph-types.ts，may-set 车道展开与事实去重在 causality-graph-lanes.ts；这里原样
// 再导出，既有的 `from "./causality-graph.js"` 引用一个不改。
export { MAIN_LANE, SINK_ID, UNKNOWN_LANE, WORKSPACE_LANE } from "./causality-graph-types.js";
export type { CausalityGraph, Certainty, Lane, OrderEdge } from "./causality-graph-types.js";
export type { Phase, Region, Step, StepKind } from "./causality-graph-types.js";

/**
 * The causality graph: a partial order over workflow STEPS, with actors as lanes and
 * `happens-before` as its edges. This is the presentation-level view the GUI draws.
 * The graph uses these rules:
 *
 *   - a **step** is one facade operation that takes time (an `ask`, a `files.*` read);
 *   - an **actor** is an attribute of a step (a lane), never a node — any quotient by
 *     actor destroys the order this graph exists to show;
 *   - an **edge** means "runs after", and records WHY internally (`data` / `control` /
 *     `fifo` / `seq` / `carry`) while rendering as one indistinguishable arrow;
 *   - **regions** (`loop` / `fanout` / `branch`) are internal: they drive reduction and
 *     the multiplicity cues, and none of them draws a container.
 *
 * The taint analysis and the temporal walk both ran inside the fused interpreter
 * (interpret.ts); this module is a PURE projection of the {@link AnalysisCore} they
 * produced, plus the projected site graph: the core's sites give the steps, the site
 * graph's `data` edges answer "does B's argument carry A's output?", and the core's
 * `trace` supplies everything temporal. No `typescript` import, no AST.
 *
 * Phase 1 scope: one step per ask/world-read site —
 * per-call-site specialization (`ask#3/2`) lands with the execution engine in phase 3, so
 * `Step.callPath` is not emitted yet. Await resolution is syntactic, with full-barrier widening as the fallback. The one exception to one-step-per-site is
 * {@link expandMaySetLanes}, the final pass: a dynamically-selected receiver becomes one
 * copy per candidate lane, and `Step.source` names the site they came from.
 */

export type { OrderKind, RegionKind };

/** Project the causality graph off the core plus the (projected) site graph. */
export function projectCausalityGraph(core: AnalysisCore, site: SiteGraph): CausalityGraph {
  const trace = core.trace;
  const regionById = new Map<string, OrderRegion>(trace.regions.map((region) => [region.id, region]));

  const stepNodes = site.nodes.filter(
    (node): node is SiteNode & { loc: SiteLoc } =>
      (node.kind === "ask" || node.kind === "world-read" || node.kind === "hole") &&
      node.loc !== undefined,
  );
  const stepIds = new Set(stepNodes.map((node) => node.id));

  // --- 1. Read the trace: issue positions, region membership, settle points ---------
  const minIssue = new Map<string, number>();
  const maxIssue = new Map<string, number>();
  const innermostRegion = new Map<string, string>();
  const regionsOf = new Map<string, Set<string>>();
  /** Steps with at least one unconditional issue path — the `always` witness. */
  const unconditional = new Set<string>();
  const actorRegions = new Map<string, readonly string[]>();
  /**
   * Step -> frame -> whether the barrier that settled it there was only a may-claim. A
   * frame is one asynchronous activation: the innermost `strand` region a settle sits in,
   * else the root. A settle inside a strand orders that strand's own later issues and the
   * issues of strands spawned inside it; it says nothing to the spawner, whose chain does
   * not contain the strand. That per-frame reading IS the concurrency this view draws:
   * two `async` callbacks awaiting their own asks stay incomparable.
   */
  const settled = new Map<string, Map<string, boolean>>();
  /** Region -> steps settled by a barrier lexically inside it. */
  const settledInside = new Map<string, Set<string>>();
  const facts: Fact[] = [];
  let clock = 0;

  // THE TRANSPARENCY RULE: the trace's
  // STRUCTURAL regions (choice / call / try / attempt / catch / finally) exist for the
  // control-flow projection. This view looks through them — they count as certain in a
  // chain, a step's home is its innermost NON-structural region, and they never reach the
  // output region table — so that stripping them from the trace yields exactly the trace
  // this projection consumed before they existed. That includes preserving one old
  // deviation on purpose: a step inside a `catch` block still reads `always` here; the
  // trace now carries `catch` with `entered=false`, and adopting it is a separate,
  // golden-reviewed change.
  const chainIsCertain = (chain: readonly string[]): boolean =>
    chain.every((id) => {
      const region = regionById.get(id);
      if (region === undefined) return false;
      if (isStructuralRegionKind(region.kind)) return true;
      if (region.kind === "seq" || region.kind === "parallel") return true;
      // A loop that provably iterates at least once keeps its body `always`: a `do…while` body, or a `for` with a positive literal bound.
      return region.kind === "loop" && region.entered;
    });
  /** The innermost non-structural region of a chain — a step's `region` home. */
  const homeOf = (chain: readonly string[]): string => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const id = chain[i] as string;
      const kind = regionById.get(id)?.kind;
      if (kind !== undefined && !isStructuralRegionKind(kind)) return id;
    }
    return trace.root;
  };
  /** The activation a settle belongs to: the innermost `strand` on its chain, else the root. */
  const frameOf = (regions: readonly string[]): string => {
    for (let i = regions.length - 1; i >= 0; i -= 1) {
      const id = regions[i] as string;
      if (regionById.get(id)?.strand === true) return id;
    }
    return trace.root;
  };
  /** The frames an issue can see: every strand it sits inside, plus the root. */
  const visibleFrames = (regions: readonly string[]): Set<string> => {
    const out = new Set<string>([trace.root]);
    for (const id of regions) if (regionById.get(id)?.strand === true) out.add(id);
    return out;
  };
  /** The nearest non-structural ancestor: what a kept region's `parent` re-attaches to. */
  const visibleParent = (region: OrderRegion): string | undefined => {
    let parent = region.parent === undefined ? undefined : regionById.get(region.parent);
    while (parent !== undefined && isStructuralRegionKind(parent.kind)) {
      parent = parent.parent === undefined ? undefined : regionById.get(parent.parent);
    }
    return parent?.id;
  };

  // 以 `continue` / `break` 结束的分支臂里发出的 step，相对它跳出的那个循环被「延后」：
  // step → (循环 id → 跳转种类)。同一轮里更靠后的 issue 对它们的 seq 事实要改判（见
  // `Fact.viaJump`）。臂 = 跳转事件区域链上、目标循环之内最靠里的 `branch` 区域；直接写在
  // 循环体里的无条件 `continue` 没有臂，也就没有可延后的东西（本轮剩余语句本来就不会跑）。
  const deferredByStep = new Map<string, Map<string, "continue" | "break">>();
  for (const event of trace.events) {
    // `mark` leaves belong to the control-flow projection only. Skipped up front:
    // the loop below treats "not settle, not actor" as an issue, and the compiler would not
    // catch a leaf kind that has a `phase` but no `step` slipping through by duck typing.
    if (event.at === "mark") continue;
    if (event.at === "jump") {
      if (event.kind !== "continue" && event.kind !== "break") continue;
      let arm: string | undefined;
      for (let i = event.regions.length - 1; i >= 0; i -= 1) {
        const id = event.regions[i] as string;
        if (id === event.target) break;
        if (regionById.get(id)?.kind === "branch") arm = id;
      }
      if (arm === undefined || !event.regions.includes(event.target)) continue;
      for (const [step, regions] of regionsOf) {
        if (!regions.has(arm)) continue;
        const loops = deferredByStep.get(step) ?? new Map<string, "continue" | "break">();
        loops.set(event.target, event.kind);
        deferredByStep.set(step, loops);
      }
      continue;
    }
    if (event.at === "settle") {
      // Within ONE frame the first settle wins, EXCEPT that a certain settle upgrades an
      // earlier may-settle: a widened barrier may-settles a step and the main line's own
      // `await` settles it for real later — issues between the two get may-edges, issues
      // after the award certain ones.
      const frame = frameOf(event.regions);
      for (const step of event.steps) {
        const byFrame = settled.get(step) ?? new Map<string, boolean>();
        const prior = byFrame.get(frame);
        if (prior === undefined || (prior && !event.maybe)) byFrame.set(frame, event.maybe);
        settled.set(step, byFrame);
      }
      for (const id of event.regions) {
        const set = settledInside.get(id) ?? new Set<string>();
        for (const step of event.steps) set.add(step);
        settledInside.set(id, set);
      }
      continue;
    }
    if (event.at === "actor") {
      if (!actorRegions.has(event.actor)) actorRegions.set(event.actor, event.regions);
      continue;
    }
    const at = clock;
    clock += 1;
    if (!minIssue.has(event.step)) {
      minIssue.set(event.step, at);
      innermostRegion.set(event.step, homeOf(event.regions));
    }
    maxIssue.set(event.step, at);
    const seen = regionsOf.get(event.step) ?? new Set<string>();
    for (const id of event.regions) seen.add(id);
    regionsOf.set(event.step, seen);
    if (chainIsCertain(event.regions)) unconditional.add(event.step);
    // Await barriers: every step already settled precedes this issue. `data` upgrades
    // happen at dedup; `seq` is the residue — ordered only by where `await` sits.
    //
    // `toPhases` records WHERE this barrier was witnessed: the phase current at THIS issue
    // event. It is the only fact kind that has a single witnessing issue, and phase copies
    // read it to keep an edge off the copies whose issue never saw the barrier. It is the
    // head-side filter; the tail side (and the head side again, on kinds that carry no
    // provenance) is covered by the copies' temporal admission in phase-graph.ts.
    const visible = visibleFrames(event.regions);
    for (const [from, byFrame] of settled) {
      if (from === event.step) continue;
      // Settled for THIS issue iff some frame it can see settled it; of those, the
      // strongest claim wins (one certain visible settle beats any number of may-claims).
      let mayHaveSettled: boolean | undefined;
      for (const [frame, maybe] of byFrame) {
        if (!visible.has(frame)) continue;
        mayHaveSettled = mayHaveSettled === undefined ? maybe : mayHaveSettled && maybe;
      }
      if (mayHaveSettled === undefined) continue;
      // 延后判定：`from` 若在一个跳出了 L 的臂里发出，而这次 issue 仍在 L 之内，那么
      // `break` 臂 → 事实不成立（本轮和下一轮都到不了），`continue` 臂 → 只能靠下一轮。
      let viaJump = false;
      let unrealizable = false;
      for (const [loop, kind] of deferredByStep.get(from) ?? []) {
        if (!event.regions.includes(loop)) continue;
        if (kind === "break") unrealizable = true;
        else viaJump = true;
      }
      if (unrealizable) continue;
      facts.push({
        certainty: mayHaveSettled ? "maybe" : "always",
        from,
        kind: "seq",
        to: event.step,
        toPhases: new Set([event.phase]),
        ...(viaJump ? { viaJump: true as const } : {}),
      });
    }
  }

  // --- 2. Lanes ---------------------------------------------------------------------
  const laneSet = new Map<string, string[]>();
  for (const node of stepNodes) {
    if (node.kind === "world-read") {
      laneSet.set(node.id, [WORKSPACE_LANE]);
      continue;
    }
    if (node.kind === "hole") {
      laneSet.set(node.id, [MAIN_LANE]); // 留白等的是主代理：它的车道（docs/analysis.md「Sites」）
      continue;
    }
    const actors = node.actors ?? [];
    laneSet.set(node.id, actors.length > 0 ? [...actors] : [UNKNOWN_LANE]);
  }

  const familiesOf = (actorId: string): string[] =>
    (actorRegions.get(actorId) ?? []).filter((id) => {
      const kind = regionById.get(id)?.kind;
      return kind === "fanout" || kind === "loop";
    });

  // --- 3. Control dependence --------------------------------------------------------
  // Two lists per fact: controllers the walk is sure of, and controllers only the
  // ambiguous half of the taint oracle claims. They are disjoint (a step both sides
  // claim is recorded as certain), so a `maybe` fact can never weaken an `always` one
  // for the same pair at dedup.
  const controlled = new Set<string>();
  for (const control of trace.controls) {
    for (const step of stepNodes) {
      if (!(regionsOf.get(step.id)?.has(control.region) ?? false)) continue;
      controlled.add(step.id);
      for (const controller of control.controllers) {
        if (controller === step.id || !stepIds.has(controller)) continue;
        facts.push({ certainty: "always", from: controller, kind: "control", to: step.id });
      }
      for (const controller of control.maybeControllers) {
        if (controller === step.id || !stepIds.has(controller)) continue;
        facts.push({ certainty: "maybe", from: controller, kind: "control", to: step.id });
      }
    }
  }

  const certaintyOf = (step: string): Certainty =>
    unconditional.has(step) && !controlled.has(step) ? "always" : "maybe";

  // --- 4. Data dependence, straight off the site graph ------------------------------
  // Relay nodes (join / fan-out) are skipped: relay labels are additive, so a direct
  // producer -> consumer edge always exists alongside the routed one.
  for (const edge of site.edges) {
    if (edge.kind !== "data" || !stepIds.has(edge.from)) continue;
    if (edge.to !== SINK_ID && !stepIds.has(edge.to)) continue;
    facts.push({ certainty: "always", exact: edge.exact, from: edge.from, kind: "data", to: edge.to });
  }

  // --- 5. Actor FIFO ---------------------------------------------------------------
  // Two steps on one actor cannot overlap; the runtime serializes them in issue order.
  // `workspace` and `unknown` are excluded — neither is an actor with a mailbox.
  const issueOrder = [...stepNodes].sort(
    (a, b) => (minIssue.get(a.id) ?? 0) - (minIssue.get(b.id) ?? 0),
  );
  const realLanes = (step: string): string[] =>
    (laneSet.get(step) ?? []).filter(
      (lane) => lane !== WORKSPACE_LANE && lane !== UNKNOWN_LANE && lane !== MAIN_LANE,
    );
  for (let i = 0; i < issueOrder.length; i += 1) {
    for (let j = i + 1; j < issueOrder.length; j += 1) {
      const a = issueOrder[i] as SiteNode;
      const b = issueOrder[j] as SiteNode;
      const lanesA = realLanes(a.id);
      const lanesB = realLanes(b.id);
      if (!lanesA.some((lane) => lanesB.includes(lane))) continue;
      // A may-set receiver only MAY be the same actor, so the ordering only may hold.
      const certainty: Certainty = lanesA.length === 1 && lanesB.length === 1 ? "always" : "maybe";
      facts.push({ certainty, from: a.id, kind: "fifo", to: b.id });
    }
  }

  // --- 6. Repetition: what closes the cycle in an iteration region ------------------
  // Two independent rules, and between them the two multiplicity cues fall out: a step that is serialized across iterations gets a self- or
  // cycle-closing arrow; one whose instances coexist gets none, and the renderer draws
  // it as a stack.
  const repeat = new Map<string, "stack" | "serial">();
  const markRepeat = (step: string, value: "stack" | "serial"): void => {
    if (value === "serial" || !repeat.has(step)) repeat.set(step, value);
  };
  for (const region of trace.regions) {
    if (region.kind !== "loop" && region.kind !== "fanout") continue;
    const inside = issueOrder.filter((node) => regionsOf.get(node.id)?.has(region.id) ?? false);
    if (inside.length === 0) continue;
    const first = inside[0] as SiteNode;
    const settledHere = inside.filter((node) => settledInside.get(region.id)?.has(node.id) ?? false);

    // (a) The last step this region awaits must settle before the next round starts.
    // Every step the region awaits is therefore serialized against its own next
    // instance too, because iteration k+1 cannot begin until that barrier has fired.
    const last = settledHere[settledHere.length - 1];
    if (last !== undefined) {
      facts.push({ certainty: certaintyOf(last.id), from: last.id, kind: "seq", to: first.id });
    }
    for (const node of settledHere) markRepeat(node.id, "serial");

    // (b) A step the region never awaits still cannot overlap its own next instance
    // when it runs on a FIXED actor — the mailbox serializes them. A lane family gets
    // a fresh actor per element, so its instances genuinely coexist and it stacks.
    //
    // This branch is only correct when the region really does NOT await the step, which is
    // why the settle oracle matters here and not just for edge certainties. Without it, an
    // indirectly-awaited body (`await acc` over a reduce accumulator, `await p` over a
    // parameter) resolved to nothing, recorded no settle inside the region, and landed here — so a
    // lane-family step got `stack`, the cue that asserts "these instances coexist", for a
    // chain the script strictly serializes. A wrong certainty bit stays in the model; a
    // wrong cue is drawn on screen (reduce-accumulator).
    const awaited = new Set(settledHere.map((node) => node.id));
    for (const node of inside) {
      if (awaited.has(node.id)) continue;
      const lanes = realLanes(node.id);
      const fixedActor = lanes.length === 1 && familiesOf(lanes[0] as string).length === 0;
      if (!fixedActor) {
        markRepeat(node.id, "stack");
        continue;
      }
      facts.push({ certainty: certaintyOf(node.id), from: node.id, kind: "fifo", to: node.id });
      markRepeat(node.id, "serial");
    }
  }

  // --- 7. Dedup, back-edge typing, reduction ---------------------------------------
  const deduped = dedupeFacts(facts);
  const positionOf = (id: string): number =>
    id === SINK_ID ? Number.MAX_SAFE_INTEGER : (minIssue.get(id) ?? 0);
  const lastIssueOf = (id: string): number =>
    id === SINK_ID ? Number.MAX_SAFE_INTEGER : (maxIssue.get(id) ?? 0);
  const iterationRegionsOf = (id: string): string[] =>
    [...(regionsOf.get(id) ?? [])].filter((region) => {
      const kind = regionById.get(region)?.kind;
      return kind === "loop" || kind === "fanout";
    });
  /**
   * Do two sites share an enclosing iteration region? That is the one thing repetition can
   * realize, and it is why "b's position precedes a's" does not mean "b cannot follow a":
   * iteration k's producer feeds iteration k+1's consumer.
   *
   * ONE implementation, two readers — {@link realizableCarry} below and the phase copies'
   * temporal admission (phase-graph.ts). They must not drift: both answer the same
   * question about the same relation, and a copy admitted by one rule and a carry judged
   * by another would put a contradiction in one picture.
   */
  const sharesIteration = (a: string, b: string): boolean => {
    const enclosing = new Set(iterationRegionsOf(b));
    return iterationRegionsOf(a).some((region) => enclosing.has(region));
  };
  /**
   * Can `to` really run again after `from`? A back edge in issue order is only
   * realizable by repetition, so this is what separates a loop's carry edge from an
   * artifact of the may-analysis.
   *
   * Bug this fixes: the site graph's data edges are variable-level, so a reassigned
   * `let` yields the full writers × readers cross product. In a refine-until-approved
   * loop, `plan = await planner.ask(...)` inside the loop therefore produces a data
   * fact into the PRE-LOOP review that reads `plan` — and since that fact points
   * backwards it was retyped `carry`, which reduction at the time never dropped. So an
   * unrealizable edge was laundered into what was then the one edge class exempt from
   * every later check. (Carry minimization now prunes REDUNDANT carries,
   * but an unrealizable back edge with no witness path would survive it, so this gate
   * stays load-bearing.)
   *
   * Repetition has exactly two sources: an enclosing iteration region shared by both
   * ends, or (for a self edge) a step issued from more than one call site.
   */
  const realizableCarry = (from: string, to: string): boolean => {
    if (from === to) {
      return iterationRegionsOf(to).length > 0 || lastIssueOf(to) > positionOf(to);
    }
    return sharesIteration(from, to);
  };
  // A back edge in issue order can only be realized by repetition, so it IS the loop's
  // carry edge — and typing it here (rather than by DFS at render time) is what keeps
  // the remaining relation acyclic for reduction and ranking.
  const typed: Fact[] = [];
  for (const fact of deduped) {
    const back =
      fact.viaJump === true || fact.from === fact.to || lastIssueOf(fact.to) <= positionOf(fact.from);
    if (!back) {
      typed.push(fact);
      continue;
    }
    if (!realizableCarry(fact.from, fact.to)) continue;
    const { exact: _exact, kind, ...rest } = fact;
    typed.push({
      // `toPhases` rides along in `rest`: retyping changes WHEN the fact holds (next
      // round), not WHERE it was witnessed.
      ...rest,
      kind: "carry" as const,
      // 保留底层 kind：carry 最小化需要知道回边改型前是硬依赖还是纯顺序。
      ...(kind === "carry" ? {} : { carryOf: kind }),
    });
  }

  const reduced = reduceOrdering(typed);

  const edges: OrderEdge[] = [];
  const fedBy: string[] = [];
  // 商图的输入：同一批归约后的事实，certainty 已按端点继承过，sink 边剔除（阶段→sink 不
  // 出图，UI 由 fedBy step 的 phase 推导）。carryOf 必须带上——阶段边跑的是同一个
  // reduceOrdering，carry 最小化按底层 kind 判见证。
  const phaseFacts: PhaseSourceFact[] = [];
  for (const fact of reduced) {
    const certainty = weakest([fact.certainty, certaintyOf(fact.from), certaintyOf(fact.to)]);
    if (fact.to === SINK_ID) {
      fedBy.push(fact.from);
      continue;
    }
    phaseFacts.push({
      certainty,
      from: fact.from,
      kind: fact.kind,
      to: fact.to,
      ...(fact.carryOf === undefined ? {} : { carryOf: fact.carryOf }),
      ...(fact.toPhases === undefined ? {} : { toPhases: fact.toPhases }),
    });
    edges.push({
      certainty,
      from: fact.from,
      kind: fact.kind,
      to: fact.to,
      ...(fact.kind === "data" && fact.exact !== undefined ? { exact: fact.exact } : {}),
    });
  }
  edges.sort(
    (a, b) =>
      positionOf(a.from) - positionOf(b.from) ||
      positionOf(a.to) - positionOf(b.to) ||
      a.kind.localeCompare(b.kind),
  );
  fedBy.sort((a, b) => positionOf(a) - positionOf(b));

  // --- 8. Lane list, region tree, renumbering --------------------------------------
  const usedLanes = new Set<string>();
  for (const node of stepNodes) for (const lane of laneSet.get(node.id) ?? []) usedLanes.add(lane);

  const laneOrder: Lane[] = [];
  if (usedLanes.has(MAIN_LANE)) laneOrder.push({ id: MAIN_LANE });
  if (usedLanes.has(WORKSPACE_LANE)) laneOrder.push({ id: WORKSPACE_LANE });
  for (const actor of site.actors) {
    if (!usedLanes.has(actor.id)) continue;
    const families = familiesOf(actor.id);
    laneOrder.push({
      id: actor.id,
      loc: actor.loc,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      ...(actor.namePattern === undefined ? {} : { namePattern: actor.namePattern }),
      ...(families.length > 0 ? { families } : {}),
    });
  }
  if (usedLanes.has(UNKNOWN_LANE)) laneOrder.push({ id: UNKNOWN_LANE });

  // Keep only regions a step or lane actually points at, plus their ancestors — an
  // empty `branch` the walk opened for a guard with no steps in it says nothing.
  const keep = new Set<string>();
  const keepWithAncestors = (id: string | undefined): void => {
    let current = id;
    while (current !== undefined && !keep.has(current)) {
      keep.add(current);
      current = regionById.get(current)?.parent;
    }
  };
  for (const node of stepNodes) keepWithAncestors(innermostRegion.get(node.id) ?? trace.root);
  for (const lane of laneOrder) for (const family of lane.families ?? []) keepWithAncestors(family);

  const rename = new Map<string, string>();
  const counters = new Map<RegionKind, number>();
  const regions: Region[] = [];
  for (const region of trace.regions) {
    if (!keep.has(region.id)) continue;
    if (isStructuralRegionKind(region.kind)) continue; // transparency rule: never exported
    const next = (counters.get(region.kind) ?? 0) + 1;
    counters.set(region.kind, next);
    const id = `${region.kind}#${next}`;
    rename.set(region.id, id);
    const visible = visibleParent(region);
    const parent = visible === undefined ? undefined : rename.get(visible);
    regions.push({
      id,
      kind: region.kind,
      ...(parent === undefined ? {} : { parent }),
      ...(region.loc === undefined ? {} : { loc: region.loc }),
      ...(region.bound === undefined ? {} : { bound: region.bound }),
      ...(region.label === undefined ? {} : { label: region.label }),
    });
  }
  const renamed = (id: string): string => rename.get(id) ?? id;
  for (const lane of laneOrder) {
    if (lane.families !== undefined) lane.families = lane.families.map(renamed);
  }

  // 开放的留白自己的 id 不带前缀（名字键，hole-id.ts）：它属于哪次补全要问站点表。
  const holeFill = new Map(core.sites.holes.map((hole) => [hole.id, hole.fill]));
  const steps: Step[] = stepNodes.map((node) => {
    const lanes = laneSet.get(node.id) ?? [UNKNOWN_LANE];
    const repeats = repeat.get(node.id);
    const fill = fillOf(node.id) ?? holeFill.get(node.id);
    return {
      certainty: certaintyOf(node.id),
      ...(fill === undefined ? {} : { fill }),
      id: node.id,
      kind: node.kind as StepKind,
      label: node.label,
      ...(node.labelPattern === undefined ? {} : { labelPattern: node.labelPattern }),
      lane: lanes[0] as string,
      loc: node.loc,
      region: renamed(innermostRegion.get(node.id) ?? trace.root),
      ...(lanes.length > 1 ? { lanes } : {}),
      ...(repeats === undefined ? {} : { repeat: repeats }),
    };
  });

  const expanded = expandMaySetLanes({
    edges,
    lanes: laneOrder,
    regions,
    steps,
    ...(fedBy.length > 0 ? { sink: { fedBy } } : {}),
  });
  // 阶段投影最后跑：它对成品图做机械改写（跨阶段拷贝 + 商图），并且在零标记脚本上是恒等
  // 函数——既有快照的回归钉就是这一条。
  return projectPhaseGraph(
    expanded,
    trace.phases,
    collectPhaseClaims(trace.events, stepIds, chainIsCertain, controlled),
    phaseFacts,
    sharesIteration,
  );
}
