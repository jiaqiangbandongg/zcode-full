import ts from "typescript";
import {
  addOcc,
  addPlaceholder,
  clearExact,
  cloneValue,
  collapse,
  collapseInto,
  emptyValue,
  HEAP_MUTATORS,
  isDirectCallee,
  isJsonStringify,
  mergeBound,
  mergeInto,
  phKey,
  singleOcc,
  VALUE_DEPTH_CAP,
  type AbstractValue,
} from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";
import type { ApplicationVia } from "./state.js";
import type { HoleSite } from "./sites.js";
import { applySuperCall } from "./classes.js";
import { handleArrayMethod } from "./array-methods.js";
import { handlePromiseReject, isPromiseReject } from "./promise-ops.js";
import { callbackSemanticsOf, isForeignMember } from "./callbacks.js";
import { handleHeapMutator, handleObjectAssign, isObjectAssign } from "./heap-ops.js";
import { handleAsk, handleJoin, handleWorldRead } from "./relays.js";

/**
 * Call and relay transfer rules: the facade sinks (`ask`, `files.*`), the relay
 * nodes (`Promise.all` joins and promoted iteration fan-outs), heap mutators, and
 * script-local / higher-order function calls with context-sensitive summaries. These
 * live apart from the core evaluator (taint.ts) but operate on the same `Evaluator`
 * instance.
 */

export function evalCall(ev: Evaluator, node: ts.CallExpression, ctx: EvalContext): AbstractValue {
  const actorId = ev.s.actorByCall.get(node);
  if (actorId !== undefined) return singleOcc(actorId, true);

  // `super(args)` inside a derived constructor applies the base class's constructor with
  // the actuals (param write-back + placeholder actuals), so a base ctor that stores an
  // argument in `this` sees the derived `new`'s arguments. Without this the base ctor's
  // parameters would resolve to nothing (a dropped may-flow). Returns nothing.
  if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    applySuperCall(ev, node, ctx);
    return emptyValue();
  }

  const askId = ev.s.askByCall.get(node);
  if (askId !== undefined) return handleAsk(ev, node, askId, ctx);

  const hole = ev.s.holeByCall.get(node);
  if (hole !== undefined) return handleHole(ev, node, hole, ctx);

  const world = ev.s.worldByCall.get(node);
  if (world !== undefined) return handleWorldRead(ev, world.id, world.args, ctx);

  const join = ev.s.joinByCall.get(node);
  if (join !== undefined) return handleJoin(ev, node, join.id, join.arg, ctx);

  if (ts.isPropertyAccessExpression(node.expression)) {
    const cand = ev.s.candByCall.get(node);
    if (cand !== undefined) return handleArrayMethod(ev, node, cand, ctx);
    if (isJsonStringify(node.expression)) {
      return node.arguments[0] === undefined ? emptyValue() : collapse(ev.evalExpr(node.arguments[0], ctx));
    }
    if (isPromiseReject(node.expression)) return handlePromiseReject(ev, node, ctx);
    if (isObjectAssign(node.expression)) return handleObjectAssign(ev, node, ctx);
    if (HEAP_MUTATORS.has(node.expression.name.text)) {
      // The name-only match used to swallow DISPATCH of a script-local method that
      // merely shares a mutator name (`inbox.add(item)` on `{ add(item) { … } }`): the
      // tracked function body was never applied, so its param actuals stayed empty, facade
      // sinks inside it resolved to nothing, and markCalled/promotion were skipped — an
      // under-approximation. Route by what the member actually HOLDS: tracked callables
      // dispatch as an ordinary call (actuals + write-back + return summary). The receiver
      // smear still runs first — a merged value may be EITHER a user object or a native
      // collection (`flag ? { add(…){…} } : new Set()`), and the smear only ADDS taint
      // (sound over-approximation, never a kill). Native collections carry no tracked fns
      // in their member slot (smear-on-read drops `.fns`), so they keep the pure-smear path.
      const smear = handleHeapMutator(ev, node, node.expression, ctx);
      const memberVal = ev.evalExpr(node.expression, ctx);
      const hasTrackedFns = [...memberVal.fns].some((fn) => ev.s.fnId.has(fn));
      return hasTrackedFns ? handleGenericCall(ev, node, ctx) : smear;
    }
    // `.call` / `.apply` / `.bind` on a script-local function receiver reshape the actuals
    // before they reach the callee's positional parameters. Only intercepts when the
    // receiver actually carries a script-local function; otherwise defers to the generic
    // path (which still applies function-valued ARGUMENTS pessimistically — the keystone).
    const forwarded = handleInvocationForwarding(ev, node, node.expression, ctx);
    if (forwarded !== undefined) return forwarded;
    // A deferred continuation (`p.then(cb)`, `p.catch(cb)`, `p.finally(cb)`) runs its callback
    // after the RECEIVER settles: record the receiver's value as the settle oracle at the
    // receiver expression's position — the key the ordering walk reads before it inlines the
    // callback body. Recording only; the call's
    // own transfer (the keystone below) is untouched.
    // Keyed by the MEMBER NAME token (`then`): a chain's receivers all start at the same
    // offset (`p.then(a).finally(b)` — both receivers begin at `p`), and an await operand
    // never starts at a member name, so this key collides with nothing.
    if (callbackSemanticsOf(node, ev.checker, ev.s.program)?.deferred === true) {
      const receiver = node.expression.expression;
      ev.s.mergeSink(ev.s.awaitVal, node.expression.name.getStart(ev.s.scriptFile), collapse(ev.evalExpr(receiver, ctx)));
    }
  }

  return handleGenericCall(ev, node, ctx);
}

/**
 * 留白（docs/analysis.md「Sites」的 Hole sites 段）。开放的留白：提示是 sink（如 ask 的
 * instructions），返回值是一个来自 run 之外的、以留白站点为标签的不透明值（类型 T）。已补全的
 * 留白：函数体在原地被 cell 调用，所以这里把它当一次**直接**应用——记成 `argument` 应用（时序
 * 走查据此在调用点内联函数体），返回值就是函数体的返回摘要（无实参，exactness 不清：调用是
 * 确定的，不是间接分派）。已补全的留白**不是**图里的节点，所以它的提示不进 sink 表。
 */
function handleHole(
  ev: Evaluator,
  node: ts.CallExpression,
  site: HoleSite,
  ctx: EvalContext,
): AbstractValue {
  ev.s.markFacade(ctx.regionStack);
  if (site.body === undefined) {
    if (site.prompt !== undefined) {
      ev.s.mergeSink(ev.s.holePrompt, site.id, collapse(ev.evalExpr(site.prompt, ctx)));
    }
    return singleOcc(site.id, true);
  }
  if (site.prompt !== undefined) ev.evalExpr(site.prompt, ctx);
  const out = emptyValue();
  for (const fn of ev.evalExpr(site.body, ctx).fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    recordCall(ev, id, ctx.regionStack, [], undefined, { site: node, via: "argument" });
    mergeInto(out, substitute(ev.s.summaryOf(id), id, [], false));
  }
  return out;
}

function handleGenericCall(ev: Evaluator, node: ts.CallExpression, ctx: EvalContext): AbstractValue {
  const { explicit, places, tail } = buildActuals(ev, node.arguments, ctx);
  return applyCall(ev, node.expression, explicit, ctx, places, tail, node);
}

/**
 * Evaluate an actual-argument list into positional values, their place aliases (for
 * parameter write-back), and an optional inexact TAIL. Positional certainty ends at the
 * first `...spread`: the spread element (and every actual after it) folds into one
 * collapsed, exactness-cleared tail that binds to every parameter at index >= the spread's
 * position — the runtime unpacking length is unknown, so the smear is the sound baseline.
 * `f(...pair)` evaluated the spread as ONE actual at index 0, so params >= 1
 * resolved to nothing (a dropped may-flow: `pair[1]` never reached `f`'s second param).
 */
function buildActuals(
  ev: Evaluator,
  argsNodes: readonly ts.Expression[],
  ctx: EvalContext,
): { explicit: AbstractValue[]; places: (AbstractValue | undefined)[]; tail: AbstractValue | undefined } {
  const spreadIndex = argsNodes.findIndex((a) => ts.isSpreadElement(a));
  if (spreadIndex < 0) {
    const explicit = argsNodes.map((a) => ev.evalExpr(a, ctx));
    return {
      explicit,
      places: argsNodes.map((a, i) => ev.argWriteBackPlace(a, explicit[i] as AbstractValue)),
      tail: undefined,
    };
  }
  const explicit = argsNodes.slice(0, spreadIndex).map((a) => ev.evalExpr(a, ctx));
  const places = argsNodes.slice(0, spreadIndex).map((a, i) => ev.argWriteBackPlace(a, explicit[i] as AbstractValue));
  const tail = emptyValue();
  for (const arg of argsNodes.slice(spreadIndex)) collapseInto(tail, ev.evalExpr(arg, ctx));
  return { explicit, places, tail: clearExact(tail) };
}

/**
 * `.call` / `.apply` / `.bind` on a script-local function receiver. Returns undefined when
 * the receiver carries no script-local function (so the caller defers to the generic /
 * unknown path — which still applies function-valued ARGUMENTS pessimistically, preserving
 * the keystone rule for `someUnknown.call(null, cb)`). The facade-siting layer separately
 * rejects these methods on facade callables, so only ORDINARY script functions land here.
 */
function handleInvocationForwarding(
  ev: Evaluator,
  node: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  ctx: EvalContext,
): AbstractValue | undefined {
  const method = access.name.text;
  if (method !== "call" && method !== "apply" && method !== "bind") return undefined;
  const receiverVal = ev.evalExpr(access.expression, ctx);
  const fns = [...receiverVal.fns].filter((fn) => ev.s.fnId.has(fn));
  if (fns.length === 0) return undefined;
  const exact = fns.length === 1 && isDirectCallee(access.expression);
  if (method === "call") {
    // f.call(thisArg, a, b, …) ≡ f(a, b, …): drop the thisArg, shift actuals down one.
    // Otherwise the thisArg would occupy actual index 0, and f's param 0 would resolve to `null`.
    const { explicit, places, tail } = buildActuals(ev, node.arguments.slice(1), ctx);
    return applyToFns(ev, fns, exact, explicit, ctx, places, tail, receiverVal.bound, node);
  }
  if (method === "apply") {
    // f.apply(thisArg, argsArray) ≡ f(...argsArray): the args tuple's positional shape is
    // opaque, so smear its collapsed (inexact) taint across every parameter — an ordinary
    // actual at index 1 would never be read by any positional placeholder.
    const argsArray = node.arguments[1];
    const tail = argsArray === undefined ? emptyValue() : clearExact(collapse(ev.evalExpr(argsArray, ctx)));
    return applyToFns(ev, fns, false, [], ctx, undefined, tail, receiverVal.bound, node);
  }
  // f.bind(thisArg, ...prefix): the result is a new function value carrying f's `fns` plus
  // a bound prefix prepended to actuals at the eventual call. Composes with the receiver's
  // existing prefix (rebinding: `f.bind(null, a).bind(null, b)` → [a, b], earlier first).
  // bind previously produced f's substituted summary (no `.fns`), so `g()` was an
  // unknown call AND the prefix never reached f's params.
  const prefixArgs = node.arguments.slice(1).map((arg) => ev.evalExpr(arg, ctx));
  const out = emptyValue();
  for (const fn of receiverVal.fns) out.fns.add(fn);
  out.bound = [...(receiverVal.bound ?? []), ...prefixArgs];
  return out;
}

/**
 * Apply a callee to already-evaluated argument values. Shared by ordinary call
 * expressions and tagged templates (``tag`…${e}…` `` is the call `tag(strings, e, …)`).
 * Script-local callees route through their context-sensitive summary; unknown/library
 * callees widen (see {@link handleUnknownCall}). `argPlaces[i]`, when present, is the
 * live value of a place actual, used for parameter write-back. `tail`, when present, is an
 * inexact spread smear bound to every parameter at index >= `argVals.length`. `site` is the
 * call / tagged-template node the application is recorded against (the call oracle).
 */
export function applyCall(
  ev: Evaluator,
  calleeExpr: ts.Expression,
  argVals: AbstractValue[],
  ctx: EvalContext,
  argPlaces?: (AbstractValue | undefined)[],
  tail?: AbstractValue,
  site?: ts.Node,
): AbstractValue {
  const calleeVal = ev.evalExpr(calleeExpr, ctx);
  // A library / facade member is never a script function (see {@link isForeignMember}): the
  // callables a whole-value read smeared into the member slot are the receiver's contents,
  // not the callee. `then(a, b).finally(c)` would otherwise dispatch to a and b as `.finally`.
  const foreign = ts.isPropertyAccessExpression(calleeExpr) && isForeignMember(calleeExpr.name, ev.checker, ev.s.scriptFile);
  const fns = foreign ? [] : [...calleeVal.fns].filter((fn) => ev.s.fnId.has(fn));
  if (fns.length === 0) return handleUnknownCall(ev, calleeExpr, calleeVal, argVals, ctx, tail, site);
  const exact = fns.length === 1 && isDirectCallee(calleeExpr);
  return applyToFns(ev, fns, exact, argVals, ctx, argPlaces, tail, calleeVal.bound, site);
}

/**
 * Apply a resolved set of script-local functions to actuals. `explicit[i]` binds param i;
 * when `tail` is present, every parameter at index >= `explicit.length` (up to each
 * callee's arity) also binds `tail` — an `apply` / spread smear whose positional extent is
 * unknown. `exact` is the dispatch's exactness: a direct single-fn call preserves it, a
 * widened dispatch (indirect / multi-fn) clears the recorded actuals and the return summary
 * so parameter-direct asks emit inexact edges.
 *
 * When `bound` (a `bind` prefix) is present, both alignments are unioned: once WITH the
 * prefix prepended (the genuinely-bound dispatch) and once WITHOUT it. `fns` is a set, so a
 * value merged from a bound and a plain function (`flag ? f : f.bind(null, a)`) can't say
 * which entry is bound; applying both alignments is sound whichever it is, and a bound
 * dispatch is inexact (the alignment is not proven).
 */
function applyToFns(
  ev: Evaluator,
  fns: ts.Node[],
  exact: boolean,
  explicit: AbstractValue[],
  ctx: EvalContext,
  argPlaces?: (AbstractValue | undefined)[],
  tail?: AbstractValue,
  bound?: AbstractValue[],
  site?: ts.Node,
): AbstractValue {
  const result = emptyValue();
  const hasBound = bound !== undefined && bound.length > 0;
  applyAligned(ev, fns, hasBound ? false : exact, explicit, ctx, argPlaces, tail, result, site);
  if (hasBound) {
    const prefixed = [...(bound as AbstractValue[]), ...explicit];
    const prefixedPlaces = [...(bound as AbstractValue[]).map(() => undefined), ...(argPlaces ?? [])];
    applyAligned(ev, fns, false, prefixed, ctx, prefixedPlaces, tail, result, site);
  }
  return result;
}

/** One alignment of {@link applyToFns}: bind `explicit`/`tail` to each callee and union the
 * recorded actuals + substituted return summaries into `result`. clearExact clones, so the
 * fns-binding and place write-back in recordCall stay live. */
function applyAligned(
  ev: Evaluator,
  fns: ts.Node[],
  exact: boolean,
  explicit: AbstractValue[],
  ctx: EvalContext,
  argPlaces: (AbstractValue | undefined)[] | undefined,
  tail: AbstractValue | undefined,
  result: AbstractValue,
  site?: ts.Node,
): void {
  const clear = !exact;
  for (const fn of fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    const paramCount = (ev.s.fnParamSymbols.get(id) ?? []).length;
    const len = tail !== undefined ? Math.max(explicit.length, paramCount) : explicit.length;
    const args: AbstractValue[] = [];
    const places: (AbstractValue | undefined)[] = [];
    for (let i = 0; i < len; i += 1) {
      const explicitVal = i < explicit.length ? explicit[i] : undefined;
      args.push(explicitVal ?? (tail as AbstractValue));
      places.push(explicitVal !== undefined ? argPlaces?.[i] : undefined);
    }
    const recorded = clear ? args.map((a) => clearExact(a)) : args;
    recordCall(ev, id, ctx.regionStack, recorded, places, site === undefined ? undefined : { site, via: "callee" });
    mergeInto(result, substitute(ev.s.summaryOf(id), id, args, clear));
  }
}

/**
 * Unknown / library call: the result is the union of the receiver's and arguments'
 * collapsed sets, exact preserved ("strings launder nothing"). AND — the keystone
 * rule — every script-local function among the arguments is pessimistically applied:
 * the library may invoke it with anything derived from the receiver or a sibling
 * argument, so each of its parameters receives that receiver ∪ siblings union with
 * exactness cleared, and its return summary joins the result (cleared). This closes
 * the higher-order laundering holes: `.then`/`.catch` callbacks (both directions),
 * `.replace(p, fn)`, `Array.from(xs, fn)`, a named callback to `.map`, an inline
 * callback to a non-whitelisted method (`.findIndex`). The old branch
 * collapsed the arguments (which drops `.fns`) and never visited the callback body,
 * so any taint the callback captured or returned was silently dropped.
 *
 * Separately captures PLACEHOLDER-parameter invocations for the promise machinery
 * ({@link handleNewUnknown} / {@link evalAwait}): a placeholder callee (`resolve(draft)` —
 * resolve is a param) records its args, and a placeholder-valued argument (`draft.then(onOk)`)
 * records the pot the unknown fn may invoke it with. Neither affects THIS call's result;
 * they seed `phCallActuals`, read only when the enclosing callback is applied as a promise
 * executor or a thenable's `then`.
 */
function handleUnknownCall(
  ev: Evaluator,
  calleeExpr: ts.Expression,
  calleeVal: AbstractValue,
  argVals: AbstractValue[],
  ctx: EvalContext,
  tail?: AbstractValue,
  site?: ts.Node,
): AbstractValue {
  const applied = emptyValue();
  if (ts.isPropertyAccessExpression(calleeExpr)) collapseInto(applied, ev.evalExpr(calleeExpr.expression, ctx));
  for (const arg of argVals) collapseInto(applied, arg);
  if (tail !== undefined) collapseInto(applied, tail);

  const out = cloneValue(applied);

  // Pessimistic application of function-valued arguments (exactness cleared). The pot a
  // callback's parameters receive is the sibling DATA, not the callables themselves: a
  // function argument is the callback being invoked, not a value the library hands to a
  // sibling callback (mirrors {@link handleNewUnknown}). With the callables left in,
  // `draft.then(cb)` makes cb's parameter "maybe cb", so any unknown call on that parameter
  // inside the body (`Promise.resolve(text)`) re-applies cb to itself — a phantom recursion
  // the call oracle then inlines as a `loop` (reentrant-then-composition).
  const actual = clearExact(applied);
  actual.fns.clear();
  for (const arg of argVals) applyPessimistically(ev, arg, actual, ctx, out, site);
  if (tail !== undefined) applyPessimistically(ev, tail, actual, ctx, out, site);

  // Capture (b): a placeholder-valued argument may be invoked by the unknown fn with the
  // pot (`draft.then(onOk)` → onOk's invocations may see the receiver draft).
  for (const arg of argVals) recordPhCallActuals(ev, arg, actual);
  if (tail !== undefined) recordPhCallActuals(ev, tail, actual);
  // Capture (a): a direct call of a placeholder callee (`resolve(draft)`) passes its args
  // to that param's invocation.
  if (calleeVal.phs.size > 0) {
    const argPot = emptyValue();
    for (const arg of argVals) collapseInto(argPot, arg);
    if (tail !== undefined) collapseInto(argPot, tail);
    recordPhCallActuals(ev, calleeVal, argPot);
  }
  return out;
}

/**
 * Keystone application of every script-local function reachable in `source`: each of its
 * parameters receives `pot` (already exactness-cleared), and its substituted return summary
 * joins `out`. Shared by {@link handleUnknownCall} and {@link handleNewUnknown} (`new`).
 */
export function applyPessimistically(
  ev: Evaluator,
  source: AbstractValue,
  pot: AbstractValue,
  ctx: EvalContext,
  out: AbstractValue,
  site?: ts.Node,
): void {
  for (const fn of source.fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    const actuals = (ev.s.fnParamSymbols.get(id) ?? []).map(() => pot);
    recordCall(ev, id, ctx.regionStack, actuals, undefined, site === undefined ? undefined : { site, via: "argument" });
    mergeInto(out, substitute(ev.s.summaryOf(id), id, actuals, true));
  }
}

/**
 * Apply script-local functions handed to a per-element library call (`xs.map(review)`) with
 * positional actuals already shaped by the registry (element / whole / accumulator slots).
 * Records each as an `argument` application at `site` inside the candidate's region stack and
 * returns the union of the substituted return summaries (inexact: the dispatch is indirect).
 */
export function applyCallbackFns(
  ev: Evaluator,
  fns: readonly ts.Node[],
  actuals: AbstractValue[],
  regionStack: string[],
  site: ts.Node,
): AbstractValue {
  const out = emptyValue();
  for (const fn of fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    recordCall(ev, id, regionStack, actuals, undefined, { site, via: "argument" });
    mergeInto(out, substitute(ev.s.summaryOf(id), id, actuals, true));
  }
  return out;
}

/** Record `value` against every placeholder-parameter carried by `source` (see phCallActuals). */
function recordPhCallActuals(ev: Evaluator, source: AbstractValue, value: AbstractValue): void {
  for (const ph of source.phs.values()) ev.s.recordPhCall(phKey(ph), value);
}

export function recordCall(
  ev: Evaluator,
  id: number,
  regionStack: string[],
  argVals: AbstractValue[],
  argPlaces?: (AbstractValue | undefined)[],
  application?: { site: ts.Node; via: ApplicationVia },
): void {
  ev.s.markCalled(regionStack, id);
  if (application !== undefined) {
    const fn = ev.s.functions[id];
    if (fn !== undefined) ev.s.recordApplication(application.site, fn, application.via);
  }
  const params = ev.s.fnParamSymbols.get(id) ?? [];
  argVals.forEach((argVal, param) => {
    ev.s.addParamActual(id, param, argVal);
    // Keep the call graph total through parameters: functions passed as arguments
    // must be reachable as callees inside the body.
    const psym = params[param];
    if (psym !== undefined && argVal.fns.size > 0) {
      const fnsOnly = emptyValue();
      for (const fn of argVal.fns) fnsOnly.fns.add(fn);
      ev.s.bindSymbol(psym, fnsOnly);
    }
    // Parameter write-back: objects cross call boundaries by reference, so a field the
    // callee wrote through the parameter (`box.f = tainted`) must be visible through the
    // caller's argument. Weak-merge the parameter's accumulated heap effects back into
    // the actual's live value when the actual is a place. Monotone; converges with the
    // fixpoint. The parameter's own top-level placeholder is skipped — merging it back
    // would just resolve (guarded) to the actual itself, adding nothing.
    const actualLive = argPlaces?.[param];
    if (psym !== undefined && actualLive !== undefined) {
      const paramSlot = ev.s.env.get(psym);
      if (paramSlot !== undefined && paramSlot !== actualLive && mergeHeapEffects(actualLive, paramSlot, id, param, argVals)) {
        ev.s.changed = true;
      }
    }
  });
}

/**
 * Merge a callee parameter's heap effects (its occurrences + fields, recursively) into
 * a caller actual, skipping the parameter's OWN top-level placeholder. Field writes land
 * in `fields`; in-place mutators (`push`, `Map.set`) fold into `occs` — both propagate.
 * The own placeholder is the parameter's identity, not a written effect, so it is not
 * carried back (it would resolve to the actual itself at emission).
 *
 * OTHER top-level placeholders are written effects and must flow: an in-place mutator
 * routes sibling params into the receiver's top level (`fill(list, v) { list.push(v) }`
 * leaves ph(fill,1) in `list`'s slot), and skipping them meant the caller's array never
 * learned it may contain the pushed value — ask#1 → ask#2 edges through such containers
 * vanished. Same-callee placeholders substitute to THIS call's actuals (context-sensitive,
 * exactly like {@link substitute} does for return summaries; the actuals arrive already
 * exactness-adjusted for the dispatch). A placeholder of an ENCLOSING function carries
 * through raw, resolved in the outer context — mirroring substitute's carry-through arm.
 */
function mergeHeapEffects(
  target: AbstractValue,
  source: AbstractValue,
  fnId: number,
  selfParam: number,
  argVals: AbstractValue[],
): boolean {
  let changed = false;
  for (const occ of source.occs.values()) changed = addOcc(target, occ) || changed;
  for (const ph of source.phs.values()) {
    if (ph.fnId !== fnId) {
      changed = addPlaceholder(target, ph) || changed;
      continue;
    }
    if (ph.param === selfParam) continue; // the parameter's own identity, not an effect
    if (ph.rest === true) {
      // A rest formal gathers every actual at index >= ph.param.
      for (let i = ph.param; i < argVals.length; i += 1) {
        const restActual = argVals[i];
        if (restActual !== undefined) changed = mergeInto(target, collapse(restActual)) || changed;
      }
      continue;
    }
    const actual = argVals[ph.param];
    // collapse matches what the in-place mutator itself folds into the receiver.
    if (actual !== undefined) changed = mergeInto(target, collapse(actual)) || changed;
  }
  for (const fn of source.fns) {
    if (!target.fns.has(fn)) {
      target.fns.add(fn);
      changed = true;
    }
  }
  for (const [key, field] of source.fields) {
    let slot = target.fields.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      target.fields.set(key, slot);
    }
    changed = mergeInto(slot, field) || changed;
  }
  // A parameter carrying a bind prefix, written back through a place actual, keeps it.
  // Routed through the domain's mergeBound rather than duplicating its element-wise loop, so
  // the prefix LENGTH cap applies here too: the write-back target is a persistent place, and
  // an uncapped prefix growing one element per pass never settles (the reason mergeBound caps).
  if (source.bound !== undefined) changed = mergeBound(target, source.bound, 0) || changed;
  return changed;
}

/** The callee's return summary with this call's actual arguments substituted in. */
function substitute(
  summary: AbstractValue,
  fnId: number,
  argVals: AbstractValue[],
  clear: boolean,
  depth = 0,
): AbstractValue {
  const out = emptyValue();
  for (const occ of summary.occs.values()) {
    addOcc(out, { exact: clear ? false : occ.exact, port: occ.port, site: occ.site });
  }
  for (const ph of summary.phs.values()) {
    if (ph.fnId !== fnId) {
      addPlaceholder(out, ph); // a placeholder of an enclosing function — carry it through
      continue;
    }
    if (ph.rest === true) {
      // A rest formal gathers every actual at index >= ph.param.
      for (let i = ph.param; i < argVals.length; i += 1) {
        const restActual = argVals[i];
        if (restActual !== undefined) mergeInto(out, clear ? clearExact(restActual) : restActual);
      }
      continue;
    }
    const actual = argVals[ph.param];
    if (actual !== undefined) mergeInto(out, clear ? clearExact(actual) : actual);
  }
  for (const fn of summary.fns) out.fns.add(fn);
  // Depth-bounded like the domain merges: beyond the cap, fold nested summary structure
  // into occurrences rather than recursing (keeps this walk finite for deep summaries).
  if (depth >= VALUE_DEPTH_CAP) {
    for (const field of summary.fields.values()) collapseInto(out, field);
    for (const el of summary.bound ?? []) collapseInto(out, el);
    return out;
  }
  // A returned bound function (`function mk(x){ return f.bind(null, x); }`) carries its
  // prefix through the summary; substitute the callee's placeholders inside each prefix arg
  // so `mk(secret)` yields a value whose prefix is `secret`.
  if (summary.bound !== undefined) {
    out.bound = summary.bound.map((el) => substitute(el, fnId, argVals, clear, depth + 1));
  }
  for (const [key, field] of summary.fields) out.fields.set(key, substitute(field, fnId, argVals, clear, depth + 1));
  return out;
}
