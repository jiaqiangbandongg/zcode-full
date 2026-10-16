import ts from "typescript";
import { callbackSemanticsOf, DEFAULT_CALLBACK_SEMANTICS } from "./callbacks.js";
import type { HoleSite } from "./sites.js";
import {
  functionName,
  resolveCallDeclaration,
  type ScriptFunction,
} from "./causality-order-functions.js";
import {
  applicationsAt,
  innermost,
  issue,
  issuesSince,
  jump,
  locOf,
  openRegion,
  type TraceState,
} from "./causality-order-state.js";
import { barrier, settlesAt } from "./causality-order-settle.js";
import {
  closeStrand,
  isAsyncFunction,
  openStrand,
  type StrandRecord,
} from "./causality-order-strands.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把调用这一组（调用表达式
// 的访问器、通用调用规则 applyAt、函数体内联 inlineBody）拆到本文件；公开面仍从
// causality-order.ts 导出。递归回 walk 一律经 `state.walk`，本文件不 import walk 模块。

export function walkCall(
  state: TraceState,
  node: ts.CallExpression,
  chain: readonly string[],
): void {
  const { walk } = state;
  // Receiver and arguments first, then the call itself — JavaScript's own order. (A
  // function-like argument is deferred by `walk` itself: its body runs when applied.)
  const receiverMark = state.events.length;
  walk(node.expression, chain);
  const receiverIssues = issuesSince(state, receiverMark);
  for (const argument of node.arguments) walk(argument, chain);

  // A per-element callback call: the body runs once per element, inside a `fanout`.
  const handled = new Set<ts.Node>();
  const cand = state.candByCall.get(node);
  if (cand !== undefined) {
    // An `async` literal callback makes the FAN-OUT the strand: every element's activation
    // runs alongside the main line, and only a later await of the mapped array joins them.
    // A named callback (`xs.map(review)`) inlines as a `call` inside the fan-out, and that
    // `call` is the strand when `review` is async — {@link inlineBody} decides it there.
    const strand = cand.callback !== undefined && isAsyncFunction(cand.callback);
    const id = openRegion(state, "fanout", innermost(state, chain), {
      entered: false,
      label: cand.method,
      loc: cand.loc,
      ...(strand ? { strand: true as const } : {}),
    });
    const inside = [...chain, id];
    if (cand.callback !== undefined) {
      const record = strand ? openStrand(state, id) : undefined;
      // A `return` in the literal ends THIS element's iteration: it targets the fanout.
      state.returnTargets.push(id);
      walk(cand.body, inside);
      state.returnTargets.pop();
      if (record !== undefined) closeStrand(state, record);
    } else {
      // A named / held callback: the oracle's argument applications, each an inlined call.
      for (const fn of applicationsAt(state, node, "argument")) {
        handled.add(fn);
        inlineBody(state, fn, inside, node);
      }
    }
  }

  const ask = state.askByCall.get(node);
  if (ask !== undefined) {
    issue(state, ask, chain);
    return;
  }
  const hole = state.holeByCall.get(node);
  if (hole !== undefined) {
    walkHole(state, node, hole, chain);
    return;
  }
  const read = state.readByCall.get(node);
  if (read !== undefined) {
    issue(state, read, chain);
    return;
  }
  const actor = state.actorByCall.get(node);
  if (actor !== undefined) {
    state.events.push({ actor, at: "actor", phase: state.currentPhase, regions: chain });
    return;
  }
  applyAt(state, node, chain, handled, receiverIssues);
}

/**
 * THE GENERIC CALL RULE: apply what the oracle recorded at this node.
 *
 *  - Callee applications inline the body as a `call` region (the helper's boundary, a
 *    `return` target). Several candidates (an indirect dispatch that may reach any of
 *    them) become the arms of one exhaustive `choice`: exactly one runs, we cannot say
 *    which. With no oracle record the checker's resolved declaration is the fallback — a
 *    value the interpreter could not track still has a syntactic answer.
 *  - Argument applications are callbacks a library may invoke, per the registry: `once`
 *    (the default) inlines the body as a `call`; when the library does not provably invoke
 *    it (`.then`, an unknown callee) the call sits in a one-arm skippable `choice` — the
 *    exact shape of an `if` without `else`, so certainty and the control-flow picture read
 *    "may not run" through the vocabulary they already have. `each` callbacks are handled
 *    by {@link walkCall} (their fanout) and arrive here in `handled`.
 *  - A DEFERRED callback (`.then` / `.catch` / `.finally`, a timer) runs after its receiver
 *    settles, so it is a STRAND whose PROLOGUE is an ordinary barrier over the receiver:
 *    the steps issued while evaluating the receiver (`receiverIssues`, the syntactic half)
 *    plus the oracle's claim keyed by the member-name token (see calls.ts), split by the
 *    settle-certainty rule like any other await. It needs no special certainty any more:
 *    the barrier runs inside the strand's own frame, so it orders the continuation's body
 *    without asserting anything about steps the MAIN LINE issues afterwards, and without
 *    robbing the main line's later `await` of its own certain settle. That scoping is what
 *    `settleLocally`'s may-claim used to approximate.
 */
export function applyAt(
  state: TraceState,
  node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  chain: readonly string[],
  handled: ReadonlySet<ts.Node> = new Set(),
  receiverIssues: readonly string[] = [],
): void {
  const { checker, program, scriptFile } = state;
  const callees = applicationsAt(state, node, "callee").filter((fn) => !handled.has(fn));
  if (callees.length === 0 && ts.isCallExpression(node)) {
    const decl = resolveCallDeclaration(node, checker, scriptFile);
    if (decl !== undefined) callees.push(decl);
  }
  if (callees.length === 1) {
    inlineBody(state, callees[0] as ScriptFunction, chain, node);
  } else if (callees.length > 1) {
    const choice = openRegion(state, "choice", innermost(state, chain), {
      entered: true,
      exhaustive: true,
      loc: locOf(state, node),
    });
    for (const fn of callees) {
      const arm = openRegion(state, "branch", choice, { entered: false, loc: locOf(state, fn) });
      inlineBody(state, fn, [...chain, choice, arm], node);
    }
  }

  const callbacks = applicationsAt(state, node, "argument").filter((fn) => !handled.has(fn));
  if (callbacks.length === 0) return;
  const semantics = ts.isTaggedTemplateExpression(node)
    ? undefined
    : callbackSemanticsOf(node, checker, program);
  const entered = semantics?.entered ?? DEFAULT_CALLBACK_SEMANTICS.entered;
  const access =
    semantics?.deferred === true &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
      ? node.expression
      : undefined;
  const prologue =
    access === undefined
      ? undefined
      : (inside: readonly string[]): void => {
          const claim = settlesAt(state, node, access.name.getStart(scriptFile));
          barrier(state, [...receiverIssues, ...claim.certain], claim.maybe, inside);
        };
  const options = {
    label: semantics?.label,
    prologue,
    ...(semantics?.deferred === true ? { strand: true as const } : {}),
  };
  for (const fn of callbacks) {
    if (entered) {
      inlineBody(state, fn, chain, node, options);
      continue;
    }
    const choice = openRegion(state, "choice", innermost(state, chain), {
      entered: true,
      loc: locOf(state, node),
    });
    const arm = openRegion(state, "branch", choice, { entered: false, loc: locOf(state, fn) });
    inlineBody(state, fn, [...chain, choice, arm], node, options);
  }
}

/**
 * 留白在时序走查里的样子（docs/analysis.md「Sites」的 Hole sites 段）。
 *
 * **开放的留白是一步，也是一个阶段。** 一步：`issue` 一次，落在它**所站的**阶段里（当前阶段），
 * 于是 await 屏障、settle、控制依赖对它与对 ask 一视同仁。一个阶段：id 就是站点 id、名字是
 * 字面量，**没有成员**——它只是一个站，轨道要在 run 之前就画出来。为了让它出现在控制流投影
 * 的阶段表上并接上前后的边，走查在 issue 之后发一条 `mark`：先 issue 再 mark，于是商图里
 * 是「所站阶段 → 留白 → 下一阶段」而不是一次回到所站阶段的往返。
 *
 * **已补全的留白不是一步，只是一个阶段。** 它的阶段认领函数体里第一个标记之前的站点；体内
 * 的标记是站在它之后的阶段，各自带 `fill` 指回这个留白；留白自己的阶段带的 `fill` 是**包着
 * 它的**留白（顶层没有）——嵌套关系只记在这里，id 里没有（hole-id.ts）。
 *
 * 它的阶段还有一个 mark 节点，与开放的留白一样。修复原因：2026-09-28 之前已补全的留白没有
 * mark，函数体以 `phase()` 开头时留白自己的阶段没有成员，控制流投影就把它丢了——接龙的每一步
 * 名字因此从阶段表、侧栏与 run 的 `phaseNames` 里消失，只剩时间轴的头还叫得出它。
 *
 * 函数体像 `future` 的一样是一个进入过的、once 的、不延迟的回调——taint 解释器把它记成调用点
 * 上的 `argument` 应用，这里照神谕内联；它是 async 的，所以是一条 strand，外面的 `await` 在
 * 屏障处 join 它。
 */
function walkHole(
  state: TraceState,
  node: ts.CallExpression,
  site: HoleSite,
  chain: readonly string[],
): void {
  const name = site.name ?? site.id;
  const enclosing = state.fillStack[state.fillStack.length - 1];
  if (site.body === undefined) {
    issue(state, site.id, chain);
    mintHolePhase(state, site, name, enclosing);
    state.events.push({ at: "mark", phase: site.id, regions: chain });
    return;
  }
  mintHolePhase(state, site, name, enclosing);
  state.events.push({ at: "mark", phase: site.id, regions: chain });
  const outer = state.currentPhase;
  state.currentPhase = site.id;
  state.fillStack.push(site.id);
  for (const fn of applicationsAt(state, node, "argument")) {
    inlineBody(state, fn, chain, node, { label: name });
  }
  state.fillStack.pop();
  state.currentPhase = outer;
}

/** 留白的阶段按首次到达铸一次（helper 里的留白每次调用都到达，阶段只有一个）。 */
function mintHolePhase(
  state: TraceState,
  site: HoleSite,
  name: string,
  fill: string | undefined,
): void {
  if (state.holePhases.has(site.id)) return;
  state.holePhases.add(site.id);
  state.phases.push({ id: site.id, loc: site.loc, name, ...(fill === undefined ? {} : { fill }) });
}

/** What a call site can say about the body it inlines, beyond where it sits. */
interface InlineOptions {
  /** Overrides the function's own name (an anonymous `.then` callback takes the method's). */
  label?: string;
  /** Force a strand although the body is not `async`: the registry's `deferred` flag. */
  strand?: true;
  /** Run inside the opened region (and, for a strand, inside its frame) before the body. */
  prologue?: (inside: readonly string[]) => void;
}

/**
 * Inline one function body at a site: the `call` region (positioned at the SITE — it is
 * this occurrence, not the declaration), inside a `loop` region when the function is
 * recursive, with re-entry cut to a `recur` jump.
 *
 * The body is a STRAND when the applied function is `async` or the caller forces it (a
 * deferred callback): it then gets a frame of its own, so the `await`s inside it suspend
 * this activation and settle nothing for the spawner — which is the JavaScript semantics
 * the single global settled set used to flatten.
 */
function inlineBody(
  state: TraceState,
  decl: ScriptFunction,
  chain: readonly string[],
  site: ts.Node,
  options: InlineOptions = {},
): void {
  const { fnStack, sccLoopByDecl } = state;
  const { label, prologue } = options;
  if (fnStack.includes(decl)) {
    // Recursion: the enclosing `loop` region carries it; the re-entrant call itself is a
    // back edge to that loop for the control-flow projection.
    const loop = sccLoopByDecl.get(decl);
    if (loop !== undefined) jump(state, "recur", loop, chain);
    return;
  }
  const name = functionName(decl) ?? label;
  const strand = options.strand === true || isAsyncFunction(decl);
  let inside = chain;
  let sccLoop: string | undefined;
  if (state.recursive.has(decl)) {
    // A call-graph SCC containing a step is a `loop` region, never unrolled.
    sccLoop = openRegion(state, "loop", innermost(state, chain), {
      entered: true,
      loc: locOf(state, decl),
      recursive: true,
      ...(name === undefined ? {} : { label: name }),
    });
    inside = [...inside, sccLoop];
  }
  // The inlined body is a `call` region: the helper's boundary, which a `return` inside
  // it targets.
  const call = openRegion(state, "call", innermost(state, inside), {
    entered: true,
    loc: locOf(state, site),
    ...(name === undefined ? {} : { label: name }),
    ...(strand ? { strand: true as const } : {}),
  });
  inside = [...inside, call];
  const record: StrandRecord | undefined = strand ? openStrand(state, call) : undefined;
  if (prologue !== undefined) prologue(inside);
  fnStack.push(decl);
  state.walkedFns.add(decl);
  const outerSccLoop = sccLoopByDecl.get(decl);
  if (sccLoop !== undefined) sccLoopByDecl.set(decl, sccLoop);
  state.returnTargets.push(call);
  state.walk(decl.body as ts.Node, inside);
  state.returnTargets.pop();
  if (outerSccLoop === undefined) sccLoopByDecl.delete(decl);
  else sccLoopByDecl.set(decl, outerSccLoop);
  fnStack.pop();
  if (record !== undefined) closeStrand(state, record);
}
