import ts from "typescript";
import { WORKFLOW_FUNCTION_NAME, type ScriptLoc } from "../compiler/compile.js";

/**
 * The abstract domain of the taint pass and the pure algebra over it. See taint.ts
 * for the analysis that drives these values to a fixpoint.
 *
 * An {@link AbstractValue} carries three orthogonal facts about a runtime value:
 *  - `occs`: the taint labels (artifact/actor site ids) that may have flowed into it,
 *    plus symbolic parameter {@link Placeholder}s when we are inside a function body;
 *  - `fields`: statically-known members (object-literal props, array/tuple indices),
 *    so `x.f` and `[a, b]` stay field-sensitive;
 *  - `fns`: script-local functions reachable as this value, keeping the call graph
 *    total under higher-order code.
 *
 * Every merge is a weak (join-only) union — the analysis is gen-only, so values only
 * ever grow, which is what drives the monotone fixpoint to convergence.
 */

/** A taint occurrence: a site/actor label with an exactness bit and optional join port. */
export interface TaintOcc {
  site: string;
  exact: boolean;
  port?: number;
}

/** Symbolic taint of a function parameter, used to express context-sensitive summaries. */
export interface Placeholder {
  fnId: number;
  param: number;
  /**
   * A rest parameter (`...parts`) is a single formal that gathers every actual at
   * index >= `param`. Resolution (substitute in calls.ts, emitFacts in state.ts)
   * unions ALL those actuals into the formal rather than the single positional one.
   */
  rest?: boolean;
}

export interface AbstractValue {
  /** Keyed by `${site}|${port ?? ""}`. */
  occs: Map<string, TaintOcc>;
  /** Keyed by `${fnId}:${param}`. */
  phs: Map<string, Placeholder>;
  fields: Map<string, AbstractValue>;
  fns: Set<ts.Node>;
  /**
   * A partial-application prefix from `Function.prototype.bind`: `f.bind(null, a)` yields
   * a value carrying f in `fns` plus `bound = [a]`. At the eventual call the prefix is
   * PREPENDED to the actuals (`applyToFns`), so `g()` reaches f's param 0 as `a`. Rebinding
   * composes (earlier bind's args first). Because `fns` is a set, a merged bound/plain
   * value (`flag ? f : f.bind(null, a)`) can't say which fn is bound, so application unions
   * BOTH alignments (with and without the prefix) — sound either way. Undefined for the
   * overwhelmingly common non-bound value (kept off the hot path).
   */
  bound?: AbstractValue[];
  /**
   * MAY-ALIAS back-references: live places a WRITE through this value must ALSO weakly
   * reach, because at runtime this value may BE one of them. Set for a conditional binding
   * (`const a = flag ? box1 : box2` → a's value may-aliases box1 AND box2) and for a
   * `Promise.all` result element that aliases its (place) input. Consulted ONLY at the
   * write primitives ({@link replayMayAliasWrite} in writeField / handleHeapMutator): the
   * write is replayed into each target INEXACTLY (it happens on one arm only — never a
   * strong update), recursing into each target's OWN mayAlias (chained aliases). A Set so
   * unions dedup by slot IDENTITY (loop-carried merges stay finite → the fixpoint
   * terminates). Undefined for the overwhelmingly common non-aliased value.
   *
   * That termination argument has a PREMISE — the **canonical-heap invariant**: every
   * target is drawn from the pass-stable heap, i.e. values keyed by a static program point
   * and created once for the whole fixpoint (env slots per symbol, class instances per
   * class, join results per join call, conditional places per ternary node, and the
   * persistent fields of any of those). A per-pass temporary must NEVER become a target:
   * identity dedup cannot recognize it, so each pass would add one more member, `changed`
   * would stay true forever, and the analysis would hit `ITERATION_CAP` instead of
   * converging (state.ts `joinResultOf` / `condPlaceOf` record the two repros that did).
   */
  mayAlias?: Set<AbstractValue>;
}

export function emptyValue(): AbstractValue {
  return { fields: new Map(), fns: new Set(), occs: new Map(), phs: new Map() };
}

function occKey(site: string, port: number | undefined): string {
  return `${site}|${port ?? ""}`;
}

export function phKey(ph: Placeholder): string {
  return `${ph.fnId}:${ph.param}`;
}

/**
 * Add an occurrence, maintaining the port-subsumption invariant of every taint set:
 * occurrences are keyed by (site, port) and distinct ports of a site coexist, BUT a
 * portless occurrence of a site subsumes every ported occurrence of the same site
 * (merging their exactness). A whole-node read is portless, so it collapses element
 * precision; a selected element keeps its port until a whole-node read joins it.
 */
export function addOcc(target: AbstractValue, occ: TaintOcc): boolean {
  if (occ.port === undefined) return addPortless(target, occ);
  // Ported: if a portless occurrence of the site already exists, it subsumes this one.
  const portless = target.occs.get(occKey(occ.site, undefined));
  if (portless !== undefined) {
    if (occ.exact && !portless.exact) {
      portless.exact = true;
      return true;
    }
    return false;
  }
  return addExact(target, occ);
}

function addPortless(target: AbstractValue, occ: TaintOcc): boolean {
  // Drop any ported occurrences of the same site, folding their exactness in.
  let exact = occ.exact;
  let changed = false;
  const drop: string[] = [];
  for (const [key, existing] of target.occs) {
    if (existing.site === occ.site && existing.port !== undefined) {
      exact = exact || existing.exact;
      drop.push(key);
    }
  }
  for (const key of drop) {
    target.occs.delete(key);
    changed = true;
  }
  return addExact(target, { exact, site: occ.site }) || changed;
}

function addExact(target: AbstractValue, occ: TaintOcc): boolean {
  const key = occKey(occ.site, occ.port);
  const existing = target.occs.get(key);
  if (existing === undefined) {
    target.occs.set(key, { exact: occ.exact, port: occ.port, site: occ.site });
    return true;
  }
  if (occ.exact && !existing.exact) {
    existing.exact = true;
    return true;
  }
  return false;
}

export function addPlaceholder(target: AbstractValue, ph: Placeholder): boolean {
  const key = phKey(ph);
  const existing = target.phs.get(key);
  if (existing !== undefined) {
    // A rest bit must not be lost when the same placeholder is merged from a
    // non-rest witness (e.g. the keystone rule) — otherwise resolution would
    // stop gathering the tail actuals.
    if (ph.rest === true && existing.rest !== true) {
      existing.rest = true;
      return true;
    }
    return false;
  }
  target.phs.set(key, { fnId: ph.fnId, param: ph.param, ...(ph.rest === true ? { rest: true } : {}) });
  return true;
}

/**
 * Fixed cap on field nesting. Beyond it, structure collapses into the occurrence set,
 * keeping the lattice finite in the presence of cyclic (`a.self = a`) and
 * recursively-grown heap — the premise the monotone fixpoint needs to converge. With
 * place-aliasing an abstract value can be genuinely cyclic (a field pointing back at
 * its container is a single shared node), so every recursive walk below is also
 * cycle-safe (identity guards / visited sets); the two together make divergence and
 * the `ITERATION_CAP` throw unreachable.
 */
export const VALUE_DEPTH_CAP = 8;

/** Deep weak-merge `source` into `target`; returns true iff `target` grew. */
export function mergeInto(target: AbstractValue, source: AbstractValue, depth = 0): boolean {
  if (target === source) return false; // identity guard: mergeInto(x, x) is a no-op (cycle-safe)
  let changed = false;
  for (const occ of source.occs.values()) changed = addOcc(target, occ) || changed;
  for (const ph of source.phs.values()) changed = addPlaceholder(target, ph) || changed;
  for (const fn of source.fns) {
    if (!target.fns.has(fn)) {
      target.fns.add(fn);
      changed = true;
    }
  }
  if (source.bound !== undefined) changed = mergeBound(target, source.bound, depth) || changed;
  if (source.mayAlias !== undefined) {
    // Union may-alias back-references, deduped by slot IDENTITY (Set): a conditional
    // binding merged across fixpoint passes must reach a fixed point, not append duplicates.
    const targets = (target.mayAlias ??= new Set());
    for (const m of source.mayAlias) {
      if (!targets.has(m)) {
        targets.add(m);
        changed = true;
      }
    }
  }
  if (depth >= VALUE_DEPTH_CAP) {
    // Depth cap reached: do not descend (a cycle would recurse forever, and unbounded
    // nesting would break the finite-lattice premise). Fold the remaining structure
    // into this node's occurrence set instead. collapseInto is cycle-safe and reports
    // growth, so the fixpoint's `changed` signal stays sound.
    for (const field of source.fields.values()) changed = collapseInto(target, field) || changed;
    return changed;
  }
  for (const [key, field] of source.fields) {
    let slot = target.fields.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      target.fields.set(key, slot);
    }
    changed = mergeInto(slot, field, depth + 1) || changed;
  }
  return changed;
}

/**
 * Union a bind prefix into `target` element-wise (position i of one bind maps to position
 * i of another). Beyond the depth cap the prefix folds into `target`'s occurrences (an
 * inexact smear that keeps every bound label alive — never a drop), keeping deeply-nested
 * bind-of-bind structure finite.
 *
 * The prefix's LENGTH is capped the same way, at {@link VALUE_DEPTH_CAP} positions — a
 * partial application longer than that is degenerate, and the cap is what keeps the lattice
 * finite along the OTHER axis. A self-rebind (`let h = f; h = h.bind(null, "x")`)
 * grows the prefix by one element per fixpoint pass — the value gets LONGER, never deeper,
 * so the depth cap never fires; without the length cap this loop would extend
 * `target.bound` by index and report `changed` forever, until the analysis hits
 * `ITERATION_CAP`. Over-cap elements collapse into
 * `target`'s occurrences, the identical degrade the depth cap uses. Honesty note: that keeps
 * every label alive ON THE VALUE, but a tracked dispatch does not fold callee-value
 * occurrences into parameters or results, so a prefix with more than CAP *distinct* bound
 * values loses routing for the tail — reachable only by a hand-written >8-argument partial
 * application (the loop-grown repro merely duplicates labels already present in-cap, so it
 * loses nothing). Accepted trade against the ITERATION_CAP crash. Prefixes are only ever
 * BUILT over-length by a per-pass temporary (calls.ts handleInvocationForwarding composes
 * `[...receiver.bound, ...prefixArgs]`); every path into persistent storage runs through
 * here, so persistent `bound` arrays never exceed the cap — which is also what bounds
 * `substitute`, whose output prefix is a 1:1 map of an already-capped summary prefix.
 */
export function mergeBound(target: AbstractValue, sourceBound: AbstractValue[], depth: number): boolean {
  let changed = false;
  if (depth >= VALUE_DEPTH_CAP) {
    for (const el of sourceBound) changed = collapseInto(target, el) || changed;
    return changed;
  }
  if (target.bound === undefined) target.bound = [];
  const tb = target.bound;
  for (let i = 0; i < sourceBound.length; i += 1) {
    const el = sourceBound[i] as AbstractValue;
    if (i >= VALUE_DEPTH_CAP) {
      changed = collapseInto(target, el) || changed; // degrade: smear into occs (never drop)
      continue;
    }
    let slot = tb[i];
    if (slot === undefined) {
      slot = emptyValue();
      tb[i] = slot;
      changed = true;
    }
    changed = mergeInto(slot, el, depth + 1) || changed;
  }
  return changed;
}

export function cloneValue(v: AbstractValue): AbstractValue {
  const out = emptyValue();
  mergeInto(out, v);
  return out;
}

/** Union of several values into a fresh owned value. */
export function unionValues(...values: AbstractValue[]): AbstractValue {
  const out = emptyValue();
  for (const v of values) mergeInto(out, v);
  return out;
}

export function singleOcc(site: string, exact: boolean, port?: number): AbstractValue {
  const out = emptyValue();
  addOcc(out, { exact, port, site });
  return out;
}

/**
 * Fold a value to its taint occurrences (occs + placeholders), dropping FIELD STRUCTURE
 * but keeping the tracked function values found anywhere in it. Ports are preserved per
 * occurrence; the port-subsumption invariant (a portless occurrence shadows ported ones
 * of the same site) is maintained by {@link addOcc}, so a whole-node read that mixes the
 * node's own portless label with per-element ported labels folds to the single portless
 * label.
 *
 * Widening folds LABELS, never the call graph: a collapsed /
 * computed-access read carries every function value nested in the
 * structure, so a callee selected by `fns[i]` or reached through an iterated element
 * still dispatches to its summary (widened, inexact) rather than becoming an unknown
 * call. Fns sets are finite (bounded by the script's function nodes), so carrying them
 * through collapse stays monotone and cannot diverge the fixpoint.
 */
export function collapse(v: AbstractValue): AbstractValue {
  const out = emptyValue();
  collapseInto(out, v);
  return out;
}

/**
 * Fold `v`'s taint (occs + placeholders + fns, recursively through fields) into `out`;
 * returns true iff `out` grew. Cycle-safe via `seen`: a shared/cyclic field object is
 * folded once (its occs already contributed on first visit), so `a.self = a` folds in
 * finite time. Returning growth keeps the depth-cap fold in {@link mergeInto} sound.
 */
export function collapseInto(out: AbstractValue, v: AbstractValue, seen = new Set<AbstractValue>()): boolean {
  if (seen.has(v)) return false;
  seen.add(v);
  let changed = false;
  for (const occ of v.occs.values()) changed = addOcc(out, occ) || changed;
  for (const ph of v.phs.values()) changed = addPlaceholder(out, ph) || changed;
  // Carry nested function values so widening never drops a callee (see collapse's doc).
  for (const fn of v.fns) {
    if (!out.fns.has(fn)) {
      out.fns.add(fn);
      changed = true;
    }
  }
  for (const field of v.fields.values()) changed = collapseInto(out, field, seen) || changed;
  // Bound-prefix args carry taint (occs/placeholders/fns) that must survive folding —
  // otherwise a bound function collapsed at a summary/emission boundary silently drops its
  // captured labels.
  for (const el of v.bound ?? []) changed = collapseInto(out, el, seen) || changed;
  return changed;
}

/**
 * Read a statically-known field using smear-on-read: the field's own value
 * unioned with the CONTAINER's own container-level occurrences (occs + placeholders,
 * not its other fields). A write smeared into the container through an untracked path
 * (root-identifier fold, computed index, `push`) lands in the container's occs, and a
 * precise field read must never hide it. Absent field → whole-value read (collapse,
 * exactness preserved — not a widening).
 *
 * The smear is strictly ADDITIVE: a portless container occurrence is NOT merged when the
 * field already carries a ported occurrence of that same site, because addOcc's
 * port-subsumption would otherwise collapse the port. That preserves join-port precision
 * — reading element `k` of a join result keeps `join#K|port=k` rather than folding it to
 * the join's whole-node portless label — while still surfacing genuine untracked writes
 * (which never have a matching ported field occ).
 */
export function readField(container: AbstractValue, key: string): AbstractValue {
  const field = container.fields.get(key);
  if (field === undefined) return collapse(container);
  const out = cloneValue(field);
  for (const occ of container.occs.values()) {
    if (occ.port === undefined && hasPortedOcc(out, occ.site)) continue;
    addOcc(out, occ);
  }
  for (const ph of container.phs.values()) addPlaceholder(out, ph);
  return out;
}

function hasPortedOcc(v: AbstractValue, site: string): boolean {
  for (const occ of v.occs.values()) {
    if (occ.site === site && occ.port !== undefined) return true;
  }
  return false;
}

/** Copy of `v` with every occurrence's exactness bit cleared (recursively). */
export function clearExact(v: AbstractValue): AbstractValue {
  const out = cloneValue(v);
  clearExactInPlace(out);
  return out;
}

function clearExactInPlace(v: AbstractValue, seen = new Set<AbstractValue>()): void {
  if (seen.has(v)) return; // cycle-safe: a shared/cyclic field is cleared once
  seen.add(v);
  for (const occ of v.occs.values()) occ.exact = false;
  for (const field of v.fields.values()) clearExactInPlace(field, seen);
  for (const el of v.bound ?? []) clearExactInPlace(el, seen);
}

/** True for actor labels; everything else (ask/world-read/join/fan-out) is an artifact. */
export { isActorSite } from "./core.js";

/** Provisional fan-out id used inside occurrences before ordinals are assigned. */
export function provisionalFanoutId(order: number): string {
  return `fan-out@${order}`;
}

// --- small AST helpers shared by the analysis ------------------------------

/**
 * Method names that mutate their receiver in place: array (`push`/`unshift`/`splice`)
 * and collection (`Map.set`, `Set.add`) writes. The transfer weak-merges each
 * argument's taint into the receiver's live value; an unresolvable receiver falls back
 * to the root-identifier smear (never a silent drop — see handleHeapMutator). `set`/`add`
 * are common names, but a false match cannot lose flow: mutator handling only ADDS taint
 * (a sound over-approximation, never a kill), and a member that actually HOLDS a tracked
 * script-local function dispatches as an ordinary call (see evalCall's mutator branch).
 */
// `send` 是 facade `Channel<T>` 的入队（docs/dynamic-workflow/authoring.md「Streams」）：一次向容器
// 写入，与 push / Map.set 同规——`ch.send(x)` 把 x 的 taint 并进 channel 的 place，`for await` 再从
// place 读出，于是每个生产者到每个消费者各画一条数据边。按名字匹配（与其余 mutator 一致），
// 脚本自己声明的 `send` 方法照旧走 calls.ts 里「成员持有脚本函数则按调用分派」的守卫。
export const HEAP_MUTATORS = new Set<string>(["push", "unshift", "splice", "set", "add", "send"]);

/**
 * Every compound-assignment token (`+=`, `-=`, … and the logical `||=`/`&&=`/`??=`).
 * These read-modify-write the target: gen-only has no kills, so the transfer just
 * weak-merges the RHS into the target (the old value stays) and yields their union.
 */
export const COMPOUND_ASSIGNMENT_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

export function findWorkflowBody(scriptFile: ts.SourceFile): ts.Block {
  for (const statement of scriptFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === WORKFLOW_FUNCTION_NAME &&
      statement.body !== undefined
    ) {
      return statement.body;
    }
  }
  throw new Error(`workflow wrapper function ${WORKFLOW_FUNCTION_NAME} not found`);
}

export function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * A function-like node that owns its own `arguments` object — every kind except an arrow
 * (arrows see the lexically-enclosing function's `arguments`). Used to resolve `arguments`
 * to the right function's actuals.
 */
export function isNonArrowFunctionLike(node: ts.Node): boolean {
  return isFunctionLike(node) && !ts.isArrowFunction(node);
}

/** A directly-referenced callee (an identifier or a function literal) preserves exactness. */
export function isDirectCallee(callee: ts.Expression): boolean {
  const expr = ts.isParenthesizedExpression(callee) ? callee.expression : callee;
  return (
    ts.isIdentifier(expr) ||
    ts.isPropertyAccessExpression(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr)
  );
}

export function isJsonStringify(access: ts.PropertyAccessExpression): boolean {
  return (
    ts.isIdentifier(access.expression) && access.expression.text === "JSON" && access.name.text === "stringify"
  );
}

/** The static field key for `x[k]` when `k` is a string/number literal, else undefined. */
export function staticIndexKey(arg: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(arg)) return arg.text;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  return undefined;
}

/**
 * Peel value-preserving wrappers that can sit on a place expression. Besides the pure
 * type-level / grouping wrappers (parens, `as`/`satisfies`, non-null, type assertion),
 * the comma operator `(a, box)` evaluates to its LAST operand, so it IS that place
 * (`control-flow-comma-alias-write`); the discarded operands carry no place and are
 * evaluated for effect separately by callers on the aliasing path. `await` is NOT peeled
 * here — it is a place only when the awaited value is a genuine promise (not a custom
 * thenable, whose `then` transforms the result), a distinction resolvePlace makes on the
 * evaluated value.
 */
export function peelPlace(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) cur = cur.right;
    else if (ts.isCommaListExpression(cur) && cur.elements.length > 0) {
      cur = cur.elements[cur.elements.length - 1] as ts.Expression;
    } else return cur;
  }
}

/** The live field object at `key`, created empty on demand (shared reference). */
export function liveField(container: AbstractValue, key: string): AbstractValue {
  let field = container.fields.get(key);
  if (field === undefined) {
    field = emptyValue();
    container.fields.set(key, field);
  }
  return field;
}

/**
 * Replay a field write into `container`'s may-alias targets: `container.f = value` must
 * also reach `target.f` for every place `container` may-alias (a conditional binding's arms,
 * a join result element's input). INEXACT: a may-alias write happens on one arm only, so it
 * clears exactness and never strong-updates a target (the direct write into the container's
 * own slot stays exact — this only affects the replay). Recurses into each target's OWN
 * mayAlias (chained aliases: `d = f2 ? a : e` where `a = f ? b : c`), cycle-safe via an
 * identity seen-set and depth-capped (beyond the cap the collapsed write smears into the
 * target's occs — a widening, never a drop). Returns true iff any target grew.
 */
export function replayMayAliasWrite(container: AbstractValue, key: string, value: AbstractValue): boolean {
  if (container.mayAlias === undefined) return false;
  return replayFieldInto(container.mayAlias, key, clearExact(value), new Set(), 0);
}

function replayFieldInto(
  targets: Set<AbstractValue>,
  key: string,
  write: AbstractValue,
  seen: Set<AbstractValue>,
  depth: number,
): boolean {
  let changed = false;
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    if (depth >= VALUE_DEPTH_CAP) {
      changed = collapseInto(target, write) || changed; // degrade: smear into occs (never drop)
      continue;
    }
    changed = mergeInto(liveField(target, key), write) || changed;
    if (target.mayAlias !== undefined) changed = replayFieldInto(target.mayAlias, key, write, seen, depth + 1) || changed;
  }
  return changed;
}

/**
 * Replay an in-place mutation (`push`/`Map.set`/…) into a container's may-alias targets:
 * the collapsed value smears (INEXACT) into each target's occs, recursing into chained
 * aliases. Same soundness contract as {@link replayMayAliasWrite}. Returns true iff any
 * target grew.
 */
export function replayMayAliasMerge(container: AbstractValue, value: AbstractValue): boolean {
  if (container.mayAlias === undefined) return false;
  return replayMergeInto(container.mayAlias, clearExact(collapse(value)), new Set());
}

function replayMergeInto(targets: Set<AbstractValue>, write: AbstractValue, seen: Set<AbstractValue>): boolean {
  let changed = false;
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    changed = mergeInto(target, write) || changed;
    if (target.mayAlias !== undefined) changed = replayMergeInto(target.mayAlias, write, seen) || changed;
  }
  return changed;
}

/**
 * Shallow-copy field sharing: `target` adopts each of `source`'s statically-known field
 * value objects BY REFERENCE, so a later write through `target.f`'s sub-object stays
 * visible through `source.f` and vice versa. Models `Object.assign(target, source)` and
 * spread (`{ ...source }`, `[...source]`), which shallow-copy at runtime — an
 * object-valued property is copied as a shared reference. A colliding target field is weak-merged INTO the
 * source's field first (runtime overwrites; gen-only keeps the union) before both names
 * adopt that one shared object. Returns true iff `target` grew. Only top-level fields are
 * shared (a genuine shallow copy), so no recursion / cycle risk.
 */
export function adoptFields(target: AbstractValue, source: AbstractValue): boolean {
  let changed = false;
  for (const [key, srcField] of source.fields) {
    const existing = target.fields.get(key);
    if (existing === srcField) continue;
    if (existing !== undefined) mergeInto(srcField, existing);
    target.fields.set(key, srcField);
    changed = true;
  }
  return changed;
}

/** The statically-known member name a binding element reads, if any. */
export function bindingPropertyKey(element: ts.BindingElement): string | undefined {
  if (element.propertyName !== undefined) {
    if (
      ts.isIdentifier(element.propertyName) ||
      ts.isStringLiteralLike(element.propertyName) ||
      ts.isNumericLiteral(element.propertyName)
    ) {
      return element.propertyName.text;
    }
    return undefined;
  }
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

/** The edge-bearing facts consumed by graph assembly. Fan-out ids are provisional. */
export interface TaintFacts {
  /** Artifact occurrences reaching each ask instruction (data in-edges to the ask). */
  askData: Map<string, TaintOcc[]>;
  /** Actor occurrences of each ask receiver (drive the context relation). */
  askActor: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each world-read argument. */
  worldReadData: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each OPEN hole's prompt (a sink, like an ask's instructions). */
  holeData: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each join, carrying the join input port. */
  joinIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each promoted fan-out (provisional id). */
  fanoutIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching the script's return expression(s). */
  returnData: TaintOcc[];
  /** Promoted iteration candidates, in source order; `id` is provisional (`fan-out@N`). */
  promoted: PromotedFanout[];
}

export interface PromotedFanout {
  order: number;
  id: string;
  loc: ScriptLoc;
  label: string;
}
