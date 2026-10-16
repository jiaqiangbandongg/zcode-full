import ts from "typescript";
import {
  artifactRowOfSymbol,
  markerFunctionOfSymbol,
  worldReadOpOfSymbol,
  siteProducingFunctionOfSymbol,
  type ArtifactOp,
  type WorldReadOp,
} from "../facade/registry.js";
import {
  WORKFLOW_FUNCTION_NAME,
  type ScriptLoc,
  type WorkflowProgram,
} from "../compiler/compile.js";
import type { NamePattern } from "./types.js";
import { callbackSemanticsOf, isGlobalLibValue, type CallbackSemantics } from "./callbacks.js";
import {
  actorName,
  actorNamePattern,
  askLabel,
  askLabelPattern,
  eachCandidate,
  forOfCandidate,
  isFacadeDeclared,
  literalText,
  resolveSymbol,
  SiteCounters,
  worldReadLabel,
} from "./sites-labels.js";
import { holeSiteOf } from "./hole-sites.js";
import { holeSiteId } from "./hole-id.js";

// 拆分：本文件顶到 oxlint max-lines 上限（400 行）。名字 / 标签辅助与符号解析
// （resolveSymbol / isFacadeDeclared）搬到 sites-labels.ts；后两者原本就从这里导出，故原样
// 再导出，既有的 `from "./sites.js"` 引用一个不改。站点类型留在本文件（五个模块按此路径导入）。
export { isFacadeDeclared, resolveSymbol } from "./sites-labels.js";

/**
 * The site table: the raw substrate the taint pass builds on. One walk over the
 * wrapped script body collects every facade call site (resolved via the checker,
 * never by name), keeps their `ts.Node` references, and records iteration
 * candidates and top-level returns. This module owns the table type; it is
 * deliberately NOT re-exported from the package index — only `analyzeWorkflowScript`
 * and the graph types are public.
 *
 * Ordinal ids are per-kind source-order counters (`ask#1`, `join#2`, …); `order`
 * is a single global discovery sequence used to merge the per-kind lists back into
 * source order for serialization. Source order = pre-order AST traversal, which is
 * `ts.forEachChild` order.
 */

export interface AskSite {
  id: string;
  order: number;
  label: string;
  /** `label` 落到兜底串时，内联 `agent()` receiver 的模板形状；见 `askLabelPattern`。 */
  labelPattern?: NamePattern;
  loc: ScriptLoc;
  /** The `x.ask(...)` call. */
  call: ts.CallExpression;
  /** The receiver of `.ask` (the actor expression). Read for actor/context labels. */
  receiver: ts.Expression;
  /** The instruction argument, if present. The taint pass reads it as a sink. */
  instructions: ts.Expression | undefined;
}

export interface ActorSite {
  id: string;
  order: number;
  name: string | undefined;
  /** `name` 缺席而首参是模板字符串时的静态形状；见 `actorNamePattern`。 */
  namePattern?: NamePattern;
  loc: ScriptLoc;
  /** The `agent(...)` call. */
  call: ts.CallExpression;
}

/**
 * A `report(...)` call site. A site that becomes **no node in either graph**: lowering
 * needs an id, the journal keys report nodes by site × ordinal for replay dedupe, and
 * the facade-siting rule needs something to point at — but a report emits progress, not
 * order, and nothing can wait for it, so there is nothing for an edge to mean. Its
 * argument is likewise **not a taint sink**.
 *
 * `report#N` is its own per-kind counter, so every existing `ask#N` / `actor#N` /
 * `world-read#N` id stays bit-for-bit unchanged — the invariant the site-id stability
 * rule actually protects. Report sites DO consume the global `order` discovery sequence,
 * which shifts serialization interleaving in text snapshots and nothing else: `order` is
 * a merge key for output, per-kind counters are journal keys.
 */
export interface ReportSite {
  id: string;
  order: number;
  loc: ScriptLoc;
  /** The `report(...)` call. */
  call: ts.CallExpression;
  /**
   * The reported item expression, if present. Read by the compile-side serializability
   * check (schema/synthesize.ts) — NOT by the taint pass.
   */
  item: ts.Expression | undefined;
  /**
   * The artifact tag (`report(item, "perf")`), set only when the second argument is a
   * string literal without holes. It routes the item to a preset artifact. Absent means
   * either "no tag" or "a tag the compiler could not read"; {@link artifactIdExpr} tells
   * those apart, and the artifacts pass rejects the second case.
   */
  artifactId?: string;
  /**
   * The tag argument, if present. Kept raw so the diagnostics pass can position a
   * rejection on the offending expression rather than on the call (same reason
   * {@link PhaseMarkerSite.nameExpr} is kept).
   */
  artifactIdExpr: ts.Expression | undefined;
}

/**
 * An `artifact.*(...)` call site: one publish (`file` / `markdown`) or one preset
 * declaration (`chart` / `table` / `metrics` / `board`).
 *
 * ⚠ 术语：这里的 artifact 是**用户面产物**（脚本发布给用户看的产出），不是同名的引擎内部
 * 概念（顶层返回值 / 站点的类型化输出值，见 `analysis/artifact-types.ts`）。
 *
 * Like {@link ReportSite} it is **sited but drawn in neither graph**: a publish is a
 * deliverable, not a step other steps can wait for, so there is nothing an edge could
 * mean; and its arguments are **not taint sinks** for the same reason `report`'s are not.
 * What it does need an id for is the journal (`artifact#N` × ordinal keys the replay
 * dedupe) and the facade-siting rule.
 *
 * `artifact#N` is its own per-kind counter, so every existing `ask#N` / `actor#N` /
 * `report#N` / `world-read#N` id stays bit-for-bit unchanged. It DOES consume the global
 * `order` discovery sequence, exactly as report sites do.
 */
export interface ArtifactSite {
  id: string;
  order: number;
  /** The registry op (`file`, `chart`, …), resolved by DECLARING CONTAINER, never by name. */
  op: ArtifactOp;
  loc: ScriptLoc;
  /** The `artifact.file(...)` / `artifact.chart(...)` call. */
  call: ts.CallExpression;
  /** The artifact id — set only when the first argument is a string literal without holes. */
  artifactId?: string;
  /**
   * The id argument, if present. Kept raw so the diagnostics pass can position a rejection
   * on the offending expression.
   */
  artifactIdExpr: ts.Expression | undefined;
}

/**
 * A `phase("…")` marker call. The one collected facade call that is **not a site**: no id,
 * no journal row — lowering rewrites it to `__host.enterPhase(name)`, which only makes the
 * engine emit a `phase-entered` event.
 * It is collected so the ordering walk can read the author's grouping, the diagnostics pass
 * can point at a malformed marker, and lowering can find the call by node identity.
 *
 * It therefore consumes **neither the global `order` sequence nor any per-kind counter**:
 * adding markers to a script must not move a single `ask#N` / `report#N` id, nor the
 * serialization interleaving. That is stronger than what `report` needed (which shifts
 * `order` only) and it costs nothing here, because a marker has no id to order.
 */
export interface PhaseMarkerSite {
  /** The phase name — set only when the argument is a string literal without holes. */
  name?: string;
  loc: ScriptLoc;
  /** The `phase(...)` call. */
  call: ts.CallExpression;
  /**
   * The name argument, if present. Kept raw so the diagnostics pass can position a
   * rejection on the offending expression rather than on the call.
   */
  nameExpr: ts.Expression | undefined;
}

export interface WorldReadSite {
  id: string;
  order: number;
  /**
   * Boundary A's op, resolved from the world-read registry by the DECLARING CONTAINER
   * (`files`×`glob` → `"glob"`), never from the bare member name. Not the member name:
   * `git.log` maps to `"git-log"`.
   */
  op: WorldReadOp;
  label: string;
  loc: ScriptLoc;
  /** The `files.glob(...)` / `files.read(...)` call. */
  call: ts.CallExpression;
  /**
   * The call's arguments in source order (`files.glob(p)` → `[p]`). Positional, and
   * plural because ops differ in arity (`files.grep(pattern, glob?)`, `git.status()`);
   * the taint pass treats every one as a sink.
   */
  args: readonly ts.Expression[];
}

export interface JoinSite {
  id: string;
  order: number;
  method: "all" | "allSettled";
  label: string;
  loc: ScriptLoc;
  /** The `Promise.all(...)` / `Promise.allSettled(...)` call. */
  call: ts.CallExpression;
  /** The single argument expression (the iterable); ports come from array literals. */
  arg: ts.Expression | undefined;
}

/**
 * A fan-out candidate — NOT a graph node yet. The taint pass promotes one to a
 * `fan-out` node iff its body reaches a facade site. Two shapes: a per-element callback
 * call per the callback registry (`xs.map(fn)`, `Array.from(xs, fn)`, … — the callback may
 * be an inline literal OR any expression holding a script function), or a `for...of`.
 */
export interface IterationCandidate {
  order: number;
  form: "array-method" | "for-of";
  loc: ScriptLoc;
  /** Registry label (`map`, `reduce`, `from`, …); undefined for `for...of`. */
  method?: string;
  /** The call (array-method form only) — the key both listeners look the candidate up by. */
  call?: ts.CallExpression;
  /** The registry entry that made this call a candidate (array-method form only). */
  semantics?: CallbackSemantics;
  /** The inline callback literal (array-method form, when the argument is one). */
  callback?: ts.FunctionExpression | ts.ArrowFunction;
  /**
   * The callback argument when it is NOT a literal (`xs.map(review)`, `xs.map(this.f)`):
   * the taint pass applies whatever script functions its value holds, per element.
   */
  callbackExpr?: ts.Expression;
  /** The body values flow through: the callback body or the `for...of` statement body.
   * For a non-literal callback this is the argument expression itself (no lexical body). */
  body: ts.Node;
  /** The element binding (array method: first callback parameter; `for...of`: the loop variable). */
  element: ts.BindingName | undefined;
  /** The iterated expression: the array-method receiver, or the `for...of` right-hand side. */
  iterated: ts.Expression;
}

/**
 * A `hole<T>(name, prompt?, body?)` call site: a typed gap the main agent fills with code
 * while the run waits at it (docs/dynamic-workflow/authoring.md「Holes」, docs/analysis.md
 * 「Sites」). Its id is the key of its NAME (`hole#<hash>`, hole-id.ts), the same at any
 * nesting depth, so every existing id stays unchanged when a fill inserts code; it consumes
 * the global `order` like every other site. A hole whose name is not a literal (9012) falls
 * back to a positional `hole#N`, which never reaches a run.
 *
 * 留白的函数体（`body`）在收集时以**全新的一套 per-kind 计数器**走查，体内铸出的 id 一律带
 * `<holeId>/` 前缀（见 {@link SiteCounters}）；体内的 `return` 不是顶层 return——它从留白
 * 返回。补全前后，体外的每个 id 逐字不变，这是活 run 能被补全的全部理由。
 */
export interface HoleSite {
  id: string;
  /** 包着这个留白的那个（已补全的）留白的 id；顶层留白没有。嵌套关系只记在这里，不在 id 里。 */
  fill?: string;
  order: number;
  /** 留白名（也是它的阶段名）——只在首参是无洞字面量时设置。 */
  name?: string;
  /** 名字实参原样保留：9012 的诊断按它定位。 */
  nameExpr: ts.Expression | undefined;
  /** 显式类型实参的源码文本（`hole<Plan>` 的 `Plan`）；缺席即 9012。 */
  typeText?: string;
  typeArg?: ts.TypeNode;
  /** 给主代理的提示（第二实参，非函数体时）；taint 趟把它当 sink。 */
  prompt?: ts.Expression;
  /** 已补全的留白的函数体（最后一个实参的内联函数字面量）；开放的留白没有。 */
  body?: ts.ArrowFunction | ts.FunctionExpression;
  loc: ScriptLoc;
  /** The `hole(...)` call. */
  call: ts.CallExpression;
  /** 调用是顶层 `return` 的（await 过的）操作数：脚本的结尾开着，run 的结果就是补全的返回值。 */
  tail: boolean;
}

/** A `return` in the top-level script body (not inside a nested function). */
export interface TopLevelReturn {
  loc: ScriptLoc;
  /** The returned expression, if any (`return;` has none). Read as the sink. */
  expression: ts.Expression | undefined;
}

export interface SiteTable {
  asks: AskSite[];
  actors: ActorSite[];
  worldReads: WorldReadSite[];
  /** `report(...)` sites — sited but drawn in neither graph (see {@link ReportSite}). */
  reports: ReportSite[];
  /** `artifact.*(...)` sites — sited but drawn in neither graph (see {@link ArtifactSite}). */
  artifacts: ArtifactSite[];
  /** `phase("…")` markers — collected but NOT sited (see {@link PhaseMarkerSite}). */
  phases: PhaseMarkerSite[];
  joins: JoinSite[];
  /** `hole<T>(...)` sites — open and filled, body sites included with prefixed ids (see {@link HoleSite}). */
  holes: HoleSite[];
  iterations: IterationCandidate[];
  topLevelReturns: TopLevelReturn[];
}

/** Collect the site table by walking the wrapped script's `__workflowScript__` body. */
export function collectSites(workflow: WorkflowProgram): SiteTable {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const body = findWorkflowBody(scriptFile);

  const table: SiteTable = {
    actors: [],
    artifacts: [],
    asks: [],
    holes: [],
    iterations: [],
    joins: [],
    phases: [],
    reports: [],
    topLevelReturns: [],
    worldReads: [],
  };
  let order = 0;

  const locOf = (node: ts.Node): ScriptLoc => toScriptLoc(node.getStart(scriptFile));

  // `ids` 是当前作用域的 per-kind 计数器组：顶层一套，每个留白函数体一套新的（带前缀）。
  // 返回值只在收到一个**带函数体的留白**时非空：walk 据此给函数体换计数器。
  const classify = (node: ts.Node, funcDepth: number, ids: SiteCounters): HoleSite | undefined => {
    if (ts.isReturnStatement(node)) {
      if (funcDepth === 0) {
        table.topLevelReturns.push({ expression: node.expression, loc: locOf(node) });
      }
      return;
    }
    if (ts.isForOfStatement(node)) {
      table.iterations.push(forOfCandidate(node, order++, locOf(node)));
      return;
    }
    if (!ts.isCallExpression(node)) return;

    if (ts.isPropertyAccessExpression(node.expression)) {
      const access = node.expression;
      const propSymbol = checker.getSymbolAtLocation(access.name);
      if (isFacadeDeclared(propSymbol)) {
        const name = access.name.text;
        if (name === "ask") {
          const labelPattern = askLabelPattern(access.expression, checker);
          table.asks.push({
            call: node,
            id: ids.next("ask"),
            instructions: node.arguments[0],
            label: askLabel(access.expression, checker),
            ...(labelPattern === undefined ? {} : { labelPattern }),
            loc: toScriptLoc(access.name.getStart(scriptFile)),
            order: order++,
            receiver: access.expression,
          });
          return;
        }
        // 产物成员先于 world-read 判定，两张表互斥（同一个 (容器,成员) 不可能同时在两张
        // 表里）。身份同样按**声明容器**取，不按名字：`artifact.table` 与脚本自己的某个
        // `table` 方法只有声明能分辨。
        const artifact = artifactRowOfSymbol(propSymbol);
        if (artifact !== undefined) {
          const idExpr = node.arguments[0];
          const id = literalText(idExpr);
          table.artifacts.push({
            artifactIdExpr: idExpr,
            ...(id === undefined ? {} : { artifactId: id }),
            call: node,
            id: ids.next("artifact"),
            loc: toScriptLoc(access.name.getStart(scriptFile)),
            op: artifact.op,
            order: order++,
          });
          return;
        }
        // World-read identity comes from the registry, keyed on the member's DECLARING
        // CONTAINER — never on its bare name. `git.log` collides with the top-level
        // `log()` by name, so a bare-name test would either mint a world-read site for
        // every progress message or drop `git.log`'s site entirely; a facade call with no
        // site has no journal key, which is the exact unsoundness the facade-siting rule
        // exists to prevent.
        const op = worldReadOpOfSymbol(propSymbol);
        if (op !== undefined) {
          table.worldReads.push({
            args: node.arguments,
            call: node,
            id: ids.next("world-read"),
            label: worldReadLabel(op, node.arguments[0]),
            loc: toScriptLoc(access.name.getStart(scriptFile)),
            op,
            order: order++,
          });
        }
        return;
      }
      const method = access.name.text;
      if (
        (method === "all" || method === "allSettled") &&
        isGlobalLibValue(access.expression, "Promise", checker, program)
      ) {
        table.joins.push({
          arg: node.arguments[0],
          call: node,
          id: ids.next("join"),
          label: "join",
          loc: toScriptLoc(access.name.getStart(scriptFile)),
          method,
          order: order++,
        });
        return;
      }
      // Per-element callback calls per the registry (`xs.map(fn)`, `Array.from(xs, fn)`, …)
      // register as fan-out candidates whatever shape the callback argument has.
      const semantics = callbackSemanticsOf(node, checker, program);
      if (semantics?.multiplicity === "each") {
        const candidate = eachCandidate(node, semantics, order, locOf(node));
        if (candidate !== undefined) {
          order++;
          table.iterations.push(candidate);
        }
      }
      return;
    }

    // Bare-callee call: the facade ones are `agent(...)` and `report(...)`. Which
    // top-level functions produce sites lives in the registry, not here — `log()` is a
    // bare facade call too, and the difference between it and `report()` is that a report
    // has a journal row keyed by its site.
    const calleeSymbol = resolveSymbol(node.expression, checker);
    const fn = siteProducingFunctionOfSymbol(calleeSymbol);
    if (fn === "agent") {
      const name = actorName(node);
      // pattern 只在真拿不到名字时才求：字面量名与绑定名都是**名字**，重建物不得顶掉它们。
      const namePattern = name === undefined ? actorNamePattern(node) : undefined;
      table.actors.push({
        call: node,
        id: ids.next("actor"),
        loc: locOf(node),
        name,
        ...(namePattern === undefined ? {} : { namePattern }),
        order: order++,
      });
      return;
    }
    if (fn === "report") {
      // 第二实参是**产物标签**：只有无洞字面量才算标签，
      // 其余（标识符、带洞模板）留给 artifacts 诊断趟按 artifactIdExpr 定位——绝不在这里
      // 猜一个 id 出来，那会让一条指向不存在看板的 report 静默通过编译。
      const tagExpr = node.arguments[1];
      const tag = literalText(tagExpr);
      table.reports.push({
        artifactIdExpr: tagExpr,
        ...(tag === undefined ? {} : { artifactId: tag }),
        call: node,
        id: ids.next("report"),
        item: node.arguments[0],
        loc: locOf(node),
        order: order++,
      });
      return;
    }
    if (fn === "hole") {
      // 留白（docs/analysis.md「Sites」的 Hole sites 段）：id 是名字键（hole-id.ts），占全局 order；
      // 带函数体时交回给 walk，让函数体在一套**全新的、带前缀的**计数器下走查。名字不是字面量
      // 时（9012，脚本提交不了）退回位置计数器，只为让诊断有个可定位的站点。
      const holeName = literalText(node.arguments[0]);
      const holeId = holeName === undefined ? ids.next("hole") : holeSiteId(holeName);
      const site = holeSiteOf(node, holeId, order++, locOf(node), funcDepth, ids.holeId);
      table.holes.push(site);
      return site.body === undefined ? undefined : site;
    }
    // `phase("…")` is a marker, not a site: no id and no counter of any kind is consumed
    // here (see PhaseMarkerSite). Resolved by declaration like the calls above — a
    // script-local function named `phase` is somebody else's function.
    if (markerFunctionOfSymbol(calleeSymbol) === "phase") {
      const nameExpr = node.arguments[0];
      const name = literalText(nameExpr);
      table.phases.push({
        call: node,
        loc: locOf(node),
        ...(name === undefined ? {} : { name }),
        nameExpr,
      });
    }
  };

  const walk = (node: ts.Node, funcDepth: number, ids: SiteCounters): void => {
    const hole = classify(node, funcDepth, ids);
    const childDepth = funcDepth + (isFunctionLike(node) ? 1 : 0);
    ts.forEachChild(node, (child) =>
      walk(child, childDepth, hole !== undefined && child === hole.body ? ids.child(hole.id) : ids),
    );
  };
  // 顶层一套计数器贯穿整个脚本体（每个语句都用同一套！）；留白函数体各自换一套带前缀的。
  const topLevel = new SiteCounters();
  for (const statement of body.statements) walk(statement, 0, topLevel);

  return table;
}

/**
 * The authored script body: the wrapper function's block. Exported for the causality
 * pass, which walks the same body in evaluation order. Read-only — it collects nothing
 * into the site table, so site ids stay bit-for-bit identical.
 */
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

/** True iff the node introduces its own function scope (a body that runs only when called). */
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
