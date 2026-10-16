import type ts from "typescript";
import type { ScriptLoc } from "../compiler/compile.js";
import type { TaintOcc } from "./domain.js";
import type { ApplicationVia } from "./state.js";
import type { JumpKind, TraceRegionKind } from "./constants.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把追踪产物的类型
// （区域、事件、控制事实、OrderTrace）与走查读取的神谕接口拆到本文件；公开面仍从
// causality-order.ts 导出（那里原样再导出这些类型，既有的 `from "./causality-order.js"`
// 引用一个不改）。本文件只含类型，不 import `typescript` 的运行时值。

/**
 * The taint facts this walk reads, narrowed to the two members it actually uses so the
 * ordering pass does not depend on the whole emission surface. Produced by
 * `TaintState.emitOracle` off the CONVERGED interpreter state (interpret.ts).
 * Both maps are keyed by `node.getStart(scriptFile)`.
 */
export interface OrderOracle {
  /** Step occurrences the operand of each `await` carries. */
  awaitSettles: Map<number, TaintOcc[]>;
  /** Step occurrences each guard expression reads. */
  guardReads: Map<number, TaintOcc[]>;
  /**
   * The call oracle: per call / `new` / tagged-template node, the script functions the
   * interpreter applied there and how (`TaintState.applications`). The walk inlines exactly
   * these bodies at exactly these sites.
   */
  applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
}

export interface OrderRegion {
  id: string;
  kind: TraceRegionKind;
  parent?: string;
  loc?: ScriptLoc;
  /** Derivable literal round count of a `for` loop; model-only (never displayed). */
  bound?: number;
  /** fanout: the iterated expression; loop: the recursive helper's name; call: the helper's name. */
  label?: string;
  /**
   * True iff running the parent provably runs this region's body at least once: a
   * `do…while` body, a `for` whose literal bound is positive, or an inlined call.
   * Drives the certainty carve-out.
   */
  entered: boolean;
  /** choice: one arm MUST run (if/else, ternary, switch with default). Absent = skippable. */
  exhaustive?: boolean;
  /**
   * loop: a recursion SCC folded into a loop, not a loop statement. Only re-entrant calls
   * (`recur` jumps) close it; its body completing normally is the helper returning.
   */
  recursive?: boolean;
  /** choice: an arm completing normally continues into the next arm (switch). */
  fallthrough?: boolean;
  /**
   * branch: a never-called function body the end-of-walk sweep placed here. It runs at
   * an unknown point, if at all; its position in the stream is an artifact of the sweep.
   */
  detached?: boolean;
  /**
   * `call` / `fanout` only: this region is a STRAND — one asynchronous activation that
   * runs alongside the body that spawned it (an inlined `async` body, or a deferred
   * callback). Its `await`s suspend the strand, never the spawner, so the walk gives it a
   * settled set of its own and the spawner learns of its completion only by awaiting its
   * promise ({@link SettleEvent.joins}).
   */
  strand?: true;
}

/** A phase the walk reached: `phase#N` numbered by FIRST REACH of a new name. */
export interface PhaseInfo {
  id: string;
  /** The author's verbatim word. Always present — a nameless marker never mints a phase. */
  name: string;
  /** The first marker that minted this phase; later same-name markers do not move it. */
  loc: ScriptLoc;
  /**
   * The filled hole whose body wrote this phase (docs/analysis.md「Sites」): a marker or a hole
   * (open or filled) inside a body carries the innermost enclosing filled hole's id. Absent
   * outside every fill — a top-level hole's own phase has none.
   */
  fill?: string;
}

/** A step's request was sent (the facade call expression was evaluated). */
export interface IssueEvent {
  at: "issue";
  step: string;
  regions: readonly string[];
  /**
   * The phase current where the call was evaluated — {@link UNPHASED_ID} outside every
   * marker's extent. Issue is the step's identity moment, so this is the whole of phase
   * membership.
   */
  phase: string;
}

/** An `await` barrier: these steps' promises are known to have settled here. */
export interface SettleEvent {
  at: "settle";
  /**
   * EMPTY when the barrier only joined strands: awaiting a strand whose summary is
   * already settled (or empty) settles nothing new, but the join itself is a control-flow
   * fact — it is where the strand's parked exits reconnect — so the event is still
   * recorded. Readers iterate `steps` and see nothing; readers of {@link joins} see the
   * join. `maybe` is meaningless on such an event and is written `false`.
   */
  steps: readonly string[];
  /**
   * True when this settle is a MAY-claim rather than a certainty. Two sources: the
   * barrier widened (nothing resolvable settled here, so everything in flight is assumed
   * to have), or the oracle's witness set was ambiguous — several witnesses, of which
   * exactly one settles at runtime, or a single inexact one smeared through a container.
   */
  maybe: boolean;
  /** Region chain the barrier sits in — a loop's carry edge needs to know. */
  regions: readonly string[];
  /**
   * The STRAND regions this barrier waits for, in join order: the strands whose promises
   * the awaited expression names (spawned while it was evaluated, or bound to an
   * identifier in an awaited position) plus the ones lifted because a settled step was
   * issued inside them. A strand joins once — a second await of the same promise lists
   * nothing. Absent when the barrier joins no strand.
   */
  joins?: string[];
}

/** An `agent()` call was evaluated — the lane's creation point, for family depth. */
export interface ActorEvent {
  at: "actor";
  actor: string;
  regions: readonly string[];
  /**
   * The phase current where the call was evaluated, as on {@link IssueEvent}: a lane's birth
   * phase for the engine's lexical stamp (`collectSitePhases`). Not rendered in the core's
   * text form — the `spawn` line predates it and the site-phase table has its own tests.
   */
  phase: string;
}

/** A `phase("…")` marker statement was evaluated: the current phase switched to `phase`. */
export interface MarkEvent {
  at: "mark";
  /** The phase current from here to the end of the enclosing statement list. */
  phase: string;
  regions: readonly string[];
}

/**
 * An unstructured transfer of control, with its target already resolved to a region id so
 * projections never touch the AST: `continue`/`break` name the `loop` (or, for a `break`
 * inside a switch, the `choice`); `return` names the enclosing `call` / `fanout` /
 * detached body, else the root; `throw` names the enclosing `attempt`, else the root
 * (uncaught); `recur` is a recursive call cut at re-entry, naming the SCC's `loop`.
 */
export interface JumpEvent {
  at: "jump";
  kind: JumpKind;
  target: string;
  regions: readonly string[];
  /** The phase current where the jump was evaluated (a phase CFG edge leaves from here). */
  phase: string;
}

export type OrderEvent = IssueEvent | SettleEvent | ActorEvent | MarkEvent | JumpEvent;

/** `controllers`' answers decide whether the steps inside `region` are issued. */
export interface ControlFact {
  /** Controllers the analysis is sure of: a syntactic witness, or a singleton-exact one. */
  controllers: readonly string[];
  /** Controllers only the ambiguous half of the oracle claims; disjoint from the above. */
  maybeControllers: readonly string[];
  region: string;
}

export interface OrderTrace {
  events: OrderEvent[];
  regions: OrderRegion[];
  controls: ControlFact[];
  /** The root `seq` region id; every other region descends from it. */
  root: string;
  /**
   * Phases the walk reached, in first-reach order. Empty for a script with no markers,
   * which is what makes the whole phase vocabulary absent downstream. {@link UNPHASED_ID}
   * is NOT listed here — it is synthetic, and the projection adds it only if it has
   * members.
   */
  phases: PhaseInfo[];
}
