import ts from "typescript";
import type { ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import {
  findWorkflowBody,
  type HoleSite,
  type IterationCandidate,
  type PhaseMarkerSite,
  type SiteTable,
} from "./sites.js";
import type { ApplicationVia } from "./state.js";
import { UNPHASED_ID, type JumpKind, type TraceRegionKind } from "./constants.js";
import type {
  ControlFact,
  OrderEvent,
  OrderOracle,
  OrderRegion,
  PhaseInfo,
} from "./causality-order-types.js";
import {
  asScriptFunction,
  collectRecursiveFunctions,
  type ScriptFunction,
} from "./causality-order-functions.js";
import { innermostOpenStrand, type Frame, type StrandRecord } from "./causality-order-strands.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把 traceOrder 原本以
// 闭包共享的走查状态拆到本文件：一个显式的 {@link TraceState} 对象（输入索引 + 可变累加器）、
// 它的构造，以及只读写这份状态的原语（开区域、发 issue / jump、阶段 id 铸造）。各类语法节点
// 的访问器（walk / loops / calls / settle）都以 `state` 为首参落在同名兄弟模块里；公开面仍从
// causality-order.ts 导出。

/** The walk's whole shared state: what `traceOrder` used to hold in closure. */
export interface TraceState {
  readonly scriptFile: ts.SourceFile;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly toScriptLoc: WorkflowProgram["toScriptLoc"];
  readonly oracle: OrderOracle;
  readonly body: ts.Block;
  // --- Site indexes, by call node ---------------------------------------------------
  readonly askByCall: ReadonlyMap<ts.Node, string>;
  readonly readByCall: ReadonlyMap<ts.Node, string>;
  readonly actorByCall: ReadonlyMap<ts.Node, string>;
  /** `hole<T>()` calls by CALL node, open and filled (causality-order-holes.ts). */
  readonly holeByCall: ReadonlyMap<ts.Node, HoleSite>;
  /** Per-element callback calls by CALL node (the fan-out region opens there). */
  readonly candByCall: ReadonlyMap<ts.Node, IterationCandidate>;
  /** Their inline literals (an iteration construct for the admission test). */
  readonly candByCallback: ReadonlyMap<ts.Node, IterationCandidate>;
  /**
   * A function applied per element at a candidate call (`xs.map(review)`) encloses its
   * steps in an iteration exactly as an inline callback literal does.
   */
  readonly eachCallbackFns: ReadonlySet<ts.Node>;
  readonly recursive: ReadonlySet<ts.Node>;
  /**
   * Only real steps can be ordered. An occurrence set may also carry join and fan-out
   * labels, which are relays, not things that take time.
   */
  readonly realSteps: ReadonlySet<string>;
  readonly callByStep: ReadonlyMap<string, ts.Node>;
  readonly iterationAncestorCache: Map<ts.Node, Set<ts.Node>>;
  // --- Trace accumulators -----------------------------------------------------------
  readonly events: OrderEvent[];
  readonly regions: OrderRegion[];
  readonly controls: ControlFact[];
  readonly counters: Map<TraceRegionKind, number>;
  readonly issued: Set<string>;
  // --- Strands: one frame per open asynchronous activation --------------------------
  // A barrier settles steps for the strand it stands in and for strands spawned later
  // inside it, never for the spawner — so the settled set is per FRAME (root frame
  // first) and `isVisiblySettled` asks the whole stack. `issued` stays global: from any
  // frame's view everything issued earlier is in flight until visibly settled, which is
  // what widening needs. See causality-order-strands.ts.
  readonly frames: Frame[];
  /** Every strand the walk spawned, in spawn order; `joined` is the ones already awaited. */
  readonly strands: StrandRecord[];
  readonly joined: Set<string>;
  /** Which strands a variable may hold the promise of — the syntactic half of the join. */
  readonly strandsBySymbol: Map<ts.Symbol, Set<string>>;
  // --- Jump-target bookkeeping (control-flow projection) ----------------------------
  // Innermost-first stacks of the regions a `return` / `throw` lands on, and the region each
  // loop / switch STATEMENT opened — set while its body is walked, so a helper inlined twice
  // resolves each occurrence's jumps to that occurrence's own region.
  readonly returnTargets: string[];
  readonly throwTargets: string[];
  readonly regionByStatement: Map<ts.Node, string>;
  /** decl -> the `loop` region its SCC entry opened; where a re-entrant call `recur`s to. */
  readonly sccLoopByDecl: Map<ts.Node, string>;
  /**
   * Which steps a variable may hold the answer of. The syntactic half of the control
   * relation: it catches implicit flows the taint oracle cannot see, because a condition
   * never joins the data contract (`const flag = (await ask()) ? 1 : 2` taints nothing).
   */
  readonly stepsBySymbol: Map<ts.Symbol, Set<string>>;
  readonly walkedFns: Set<ts.Node>;
  readonly fnStack: ts.Node[];
  // --- Phase state: the author's grouping, threaded through the walk ----------------
  // The extent of `phase("gate")` is REST-OF-BLOCK, so the state is one mutable
  // "current phase" plus a save/restore around every statement list (`walkStatements`).
  // Nested blocks and inlined helper bodies therefore inherit it for free, and the
  // marker's effect dies with the list it stood in — which IS rest-of-block.
  readonly markerByStatement: ReadonlyMap<ts.Node, PhaseMarkerSite>;
  readonly phases: PhaseInfo[];
  readonly phaseIdByName: Map<string, string>;
  /** Hole phases already minted (a hole in a helper is reached per call, minted once). */
  readonly holePhases: Set<string>;
  /**
   * The filled holes whose bodies the walk is inside, innermost last: every phase minted
   * while the stack is non-empty carries its top as `fill` ({@link PhaseInfo.fill}).
   */
  readonly fillStack: string[];
  currentPhase: string;
  /** The root `seq` region id; every other region descends from it. */
  readonly root: string;
  /** The node visitor, bound to this state so every module can recurse without a cycle. */
  readonly walk: (node: ts.Node, chain: readonly string[]) => void;
}

/** The script functions the oracle says `node` applies, by `via`, in recording order. */
export function applicationsAt(
  state: Pick<TraceState, "oracle" | "scriptFile">,
  node: ts.Node,
  via: ApplicationVia,
): ScriptFunction[] {
  const out: ScriptFunction[] = [];
  for (const [fn, how] of state.oracle.applications.get(node) ?? []) {
    if (how !== via) continue;
    const decl = asScriptFunction(fn, state.scriptFile);
    if (decl !== undefined) out.push(decl);
  }
  return out;
}

export function openRegion(
  state: Pick<TraceState, "counters" | "regions">,
  kind: TraceRegionKind,
  parent: string | undefined,
  extra: {
    entered: boolean;
    loc?: ScriptLoc;
    bound?: number;
    label?: string;
    exhaustive?: boolean;
    fallthrough?: boolean;
    detached?: boolean;
    recursive?: boolean;
    strand?: true;
  },
): string {
  const next = (state.counters.get(kind) ?? 0) + 1;
  state.counters.set(kind, next);
  const id = `${kind}#${next}`;
  state.regions.push({ id, kind, ...(parent === undefined ? {} : { parent }), ...extra });
  return id;
}

/** Build the state and index the site table; `walk` is the node visitor to bind. */
export function createTraceState(
  workflow: WorkflowProgram,
  table: SiteTable,
  oracle: OrderOracle,
  walk: (state: TraceState, node: ts.Node, chain: readonly string[]) => void,
): TraceState {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const body = findWorkflowBody(scriptFile);

  const askByCall = new Map<ts.Node, string>(table.asks.map((site) => [site.call, site.id]));
  const readByCall = new Map<ts.Node, string>(table.worldReads.map((site) => [site.call, site.id]));
  const actorByCall = new Map<ts.Node, string>(table.actors.map((site) => [site.call, site.id]));
  const holeByCall = new Map<ts.Node, HoleSite>(table.holes.map((site) => [site.call, site]));
  // 只有开放的留白是一步（docs/analysis.md「Sites」）：已补全的留白由它的函数体在原地代表。
  const openHoles = table.holes.filter((site) => site.body === undefined);
  const candByCall = new Map<ts.Node, IterationCandidate>();
  const candByCallback = new Map<ts.Node, IterationCandidate>();
  for (const cand of table.iterations) {
    if (cand.call !== undefined) candByCall.set(cand.call, cand);
    if (cand.callback !== undefined) candByCallback.set(cand.callback, cand);
  }
  const eachCallbackFns = new Set<ts.Node>();
  for (const call of candByCall.keys()) {
    for (const fn of applicationsAt({ oracle, scriptFile }, call, "argument"))
      eachCallbackFns.add(fn);
  }
  const recursive = collectRecursiveFunctions(scriptFile, checker, oracle.applications);
  const realSteps = new Set<string>([
    ...table.asks.map((site) => site.id),
    ...table.worldReads.map((site) => site.id),
    ...openHoles.map((site) => site.id),
  ]);
  const callByStep = new Map<string, ts.Node>([
    ...table.asks.map((site) => [site.id, site.call] as const),
    ...table.worldReads.map((site) => [site.id, site.call] as const),
    ...openHoles.map((site) => [site.id, site.call] as const),
  ]);

  const markerByStatement = new Map<ts.Node, PhaseMarkerSite>();
  for (const marker of table.phases) {
    if (ts.isExpressionStatement(marker.call.parent))
      markerByStatement.set(marker.call.parent, marker);
  }

  const regions: OrderRegion[] = [];
  const counters = new Map<TraceRegionKind, number>();
  const root = openRegion({ counters, regions }, "seq", undefined, { entered: true });

  const state: TraceState = {
    actorByCall,
    askByCall,
    body,
    callByStep,
    candByCall,
    candByCallback,
    checker,
    controls: [],
    counters,
    currentPhase: UNPHASED_ID,
    eachCallbackFns,
    events: [],
    fillStack: [],
    fnStack: [],
    frames: [{ region: root, settled: new Set<string>() }],
    holeByCall,
    holePhases: new Set<string>(),
    issued: new Set<string>(),
    iterationAncestorCache: new Map<ts.Node, Set<ts.Node>>(),
    joined: new Set<string>(),
    markerByStatement,
    oracle,
    phaseIdByName: new Map<string, string>(),
    phases: [],
    program,
    readByCall,
    realSteps,
    recursive,
    regionByStatement: new Map<ts.Node, string>(),
    regions,
    returnTargets: [],
    root,
    sccLoopByDecl: new Map<ts.Node, string>(),
    scriptFile,
    stepsBySymbol: new Map<ts.Symbol, Set<string>>(),
    strands: [],
    strandsBySymbol: new Map<ts.Symbol, Set<string>>(),
    throwTargets: [],
    toScriptLoc,
    walk: (node, chain) => walk(state, node, chain),
    walkedFns: new Set<ts.Node>(),
  };
  return state;
}

export function locOf(state: TraceState, node: ts.Node): ScriptLoc {
  return state.toScriptLoc(node.getStart(state.scriptFile));
}

export function innermost(state: TraceState, chain: readonly string[]): string {
  return chain[chain.length - 1] ?? state.root;
}

export function issue(state: TraceState, step: string, chain: readonly string[]): void {
  state.issued.add(step);
  // The strand this issue happened in owns the step for the LIFT rule: awaiting a promise
  // that carries this step's label is evidence that that activation has completed.
  innermostOpenStrand(state)?.issued.add(step);
  state.events.push({ at: "issue", phase: state.currentPhase, regions: chain, step });
}

export function jump(
  state: TraceState,
  kind: JumpKind,
  target: string,
  chain: readonly string[],
): void {
  state.events.push({ at: "jump", kind, phase: state.currentPhase, regions: chain, target });
}

/** Step ids issued by events at or after `mark`, in issue order, deduped. */
export function issuesSince(state: TraceState, mark: number): string[] {
  const out: string[] = [];
  for (let i = mark; i < state.events.length; i += 1) {
    const event = state.events[i] as OrderEvent;
    if (event.at === "issue" && !out.includes(event.step)) out.push(event.step);
  }
  return out;
}

/**
 * The id a marker names. Same name → same id (names are the key, unlike an actor's);
 * a new name mints `phase#N` at FIRST REACH, so numbering follows evaluation order and
 * a marker in dead code the walk never reaches mints nothing.
 *
 * A marker whose name the collector could not read (non-literal, empty) mints nothing
 * and leaves the current phase alone: those are diagnostics (9004) and the script never
 * reaches this pass, so this is the invariant written down rather than a fallback.
 */
export function phaseIdOf(state: TraceState, marker: PhaseMarkerSite): string | undefined {
  const name = marker.name?.trim();
  if (name === undefined || name === "") return undefined;
  const existing = state.phaseIdByName.get(name);
  if (existing !== undefined) return existing;
  // 编号只数标记铸出的阶段：留白的阶段以站点 id 为 id、不进 phaseIdByName，所以夹在中间的留白
  // 不会让 `phase#N` 跳号。
  const id = `phase#${state.phaseIdByName.size + 1}`;
  state.phaseIdByName.set(name, id);
  const fill = state.fillStack[state.fillStack.length - 1];
  state.phases.push({ id, loc: marker.loc, name, ...(fill === undefined ? {} : { fill }) });
  return id;
}
