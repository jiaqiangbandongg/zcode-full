import ts from "typescript";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import { facadeContainerOf, isSiteProducing, SITE_MEMBER_NAMES } from "../facade/registry.js";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import { findWorkflowBody } from "./domain.js";
import { isFacadeDeclared, resolveSymbol, type SiteTable } from "./sites.js";

/**
 * The facade-siting diagnostic. Kept in its own module,
 * a sibling of the site-table substrate: this is an
 * analysis diagnostic, not part of the shared table, and it walks the body in a
 * different shape (every reference / conversion, not just call sites).
 */

/**
 * Package-local diagnostic code for the facade-siting rule. Not a TS diagnostic code
 * (those come from the checker); this marks an analysis diagnostic produced by
 * {@link collectFacadeMisuse}. Kept out of the TS code space to stay unambiguous.
 */
export const FACADE_SITING_CODE = 9001;

/** Depth cap for the structural facade-site walk; scripts nest shallowly, cyclic types converge. */
const FACADE_SITE_DEPTH = 4;

/**
 * Assignment operators whose right-hand side flows a value into the left-hand slot's
 * declared type: plain `=` and the logical compounds `||=`/`&&=`/`??=`. Arithmetic
 * compounds (`+=`, …) coerce and cannot carry a facade handle into a facade-typed slot,
 * so they are not conversion boundaries.
 */
const VALUE_ASSIGNMENT_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * The facade-siting diagnostic: facade callables are second-class — `agent`, `Agent.ask`,
 * `files.glob`/`files.read`, `artifact.file`/`artifact.chart`, and `log` may appear only as the
 * callee of a direct call. Any other reference (aliasing `const spawn = agent`, method
 * extraction `const f = planner.ask`, `.bind`/`.call`/`.apply` receivers, passing a
 * facade function as an argument) destroys site identity: journal keys, replay, and
 * the GUI all key off static site ids, and a facade call reachable only through an
 * escaped function value has no site. Widening cannot represent it and silently
 * dropping it would be unsound, so it is rejected at compile time.
 *
 * Three passes over the workflow body:
 *
 *   1. Reference scan — every identifier / property-access whose checker-resolved
 *      symbol is a facade callable, in any position other than the callee of a direct
 *      call; PLUS every destructuring binding/assignment that extracts a facade
 *      callable off its containing object (see {@link flagExtractedMember}).
 *   2. Defense in depth — any direct CallExpression whose callee resolves to a
 *      site-producing facade callable but that never registered as a site (catches
 *      escape forms the reference scan misses).
 *   3. Retyping boundary — any conversion of a value that carries a site-producing
 *      facade member (`Agent.ask`, `files.glob`/`read`) to a type that does NOT (a
 *      structurally-compatible local interface, `any`, `unknown`). TypeScript resolves
 *      members by *declared type*, so `const d = planner as Askable; d.ask(...)` or
 *      `function run(a: Askable) { a.ask(...) }; run(planner)` makes `.ask` resolve to
 *      the local declaration — pass 1 sees a non-facade symbol, pass 2's resolved
 *      signature points at the local interface: no site, no diagnostic, and the real
 *      facade call runs unsited. Enforced at the conversion boundary
 *      (`as`/`satisfies`, argument→parameter, return, annotated binding) rather than by
 *      tracking value provenance through the cast (see {@link facadeSiteMember}).
 *
 * Destructuring extraction: `const { ask } = planner`, `const { read }
 * = files`, renamed `{ ask: f }`, nested `{ p: { ask } }`, parameter `function f({ ask }:
 * Agent)`, and assignment `({ ask } = planner)` are all method extraction — the destructured
 * twin of the already-rejected `const f = planner.ask`. A shorthand binding identifier
 * resolves to the freshly-declared LOCAL (not the facade method), so the identifier scan is
 * blind; and routing the value through a script-locally-typed helper hides the eventual call
 * from Pass 2's signature check too. Both holes close by flagging at the EXTRACTION site
 * (see {@link scanRefs}): resolve the source property on the destructured value's type and
 * reject a facade callable.
 */
export function collectFacadeMisuse(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const body = findWorkflowBody(scriptFile);
  const diagnostics: CompileDiagnostic[] = [];

  const flag = (at: ts.Node, name: string): void => {
    const loc = toScriptLoc(at.getStart(scriptFile));
    diagnostics.push({
      code: FACADE_SITING_CODE,
      column: loc.column,
      line: loc.line,
      message:
        `facade function '${name}' may only be called directly; ` +
        `taking a reference to it defeats site identity (journal and replay key off call sites)`,
    });
  };

  // Resolve the source property a destructuring form pulls off its containing object
  // (`{ ask } = planner` -> `ask` on Agent) and flag it when facade-callable. Flags at
  // `nameNode`; a renamed form's property name is also seen by the identifier scan below,
  // so both may flag the same spot — the trailing dedupe collapses that.
  const flagExtractedMember = (nameNode: ts.Node, containerType: ts.Type): void => {
    if (!ts.isIdentifier(nameNode) && !ts.isStringLiteralLike(nameNode)) return;
    const property = checker.getPropertyOfType(containerType, nameNode.text);
    if (isFacadeCallable(property)) flag(nameNode, nameNode.text);
  };

  // Pass 1: reference scan.
  const scanRefs = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = resolveSymbol(node.name, checker);
      if (isFacadeCallable(symbol) && !isDirectCallee(node)) flag(node.name, symbol!.name);
    } else if (ts.isIdentifier(node) && !isPropertyAccessName(node)) {
      const symbol = resolveSymbol(node, checker);
      if (isFacadeCallable(symbol) && !isDirectCallee(node)) flag(node, symbol!.name);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      // Destructuring EXTRACTION off an object binding pattern (`const { ask } = planner`,
      // renamed, nested, or parameter): the container is the binding pattern's type, and a
      // renamed element carries the source property name, a shorthand its own bound name.
      flagExtractedMember(node.propertyName ?? node.name, checker.getTypeAtLocation(node.parent));
    } else if (ts.isShorthandPropertyAssignment(node) && ts.isBinaryExpression(node.parent.parent)) {
      // Destructuring ASSIGNMENT `({ ask } = planner)`: the object literal is the assignment
      // target (its LHS), and the source property lives on the right-hand side's type.
      const assign = node.parent.parent;
      if (assign.left === node.parent && assign.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        flagExtractedMember(node.name, checker.getTypeAtLocation(assign.right));
      }
    }
    ts.forEachChild(node, scanRefs);
  };

  // Pass 2: defense in depth — a direct facade call the collector did not site.
  // `report` sites belong in here for the same reason `agent` sites do: `report` is
  // site-producing (registry), so a sited direct call must not be flagged, while a
  // report call the collector somehow missed must be.
  const sited = new Set<ts.CallExpression>([
    ...table.asks.map((site) => site.call),
    ...table.actors.map((site) => site.call),
    ...table.worldReads.map((site) => site.call),
    ...table.reports.map((site) => site.call),
    // 产物站点与 report 同席：它们产生站点（registry），
    // 所以已 site 的直接调用不得被误报，而收集漏掉的那一次必须被报出来。
    ...table.artifacts.map((site) => site.call),
    ...table.joins.map((site) => site.call),
    // 留白同席：`hole` 产生站点（registry），已 site 的直接调用不得误报。
    ...table.holes.map((site) => site.call),
  ]);
  const scanCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !sited.has(node)) {
      // Resolve through the CALL's signature, not the callee's symbol: a computed
      // member access (`files["read"]`) has no callee symbol, but the resolved
      // signature still points at the facade method declaration. The (container, member)
      // pair — not the bare member name — decides whether the callee is site-producing:
      // `git.log` is, the top-level `log()` is not, and they share a name. Keying on the
      // name alone would flag every unsited `log("progress")` call as misuse.
      const callee = facadeCallee(node, checker);
      if (callee !== undefined && isSiteProducing(callee.container, callee.member)) {
        flag(node.expression, callee.member);
      }
    }
    ts.forEachChild(node, scanCalls);
  };

  // Pass 3: retyping boundary. A value that really is an `Agent`/`files` (its type
  // carries a site-producing facade member) converted to a type that carries none
  // launders the site. Anchored at the escaping value expression; the reported name is
  // the member the disguised type exposes locally (what the author calls through), so
  // the message reads as "'.ask' can no longer be a facade call here".
  const flagRetype = (at: ts.Node, name: string): void => {
    const loc = toScriptLoc(at.getStart(scriptFile));
    diagnostics.push({
      code: FACADE_SITING_CODE,
      column: loc.column,
      line: loc.line,
      message:
        `facade function '${name}' may only be called directly; retyping a facade value to a ` +
        `structurally-compatible non-facade type escapes site identity ` +
        `(the disguised '.${name}(...)' resolves to the local type and runs unsited)`,
    });
  };

  const checkConversion = (valueExpr: ts.Expression, destType: ts.Type | undefined): void => {
    if (destType === undefined) return;
    const laundered = facadeSiteMember(checker.getTypeAtLocation(valueExpr), checker);
    if (laundered === undefined) return;
    if (facadeSiteMember(destType, checker) !== undefined) return;
    const viaDest = [...SITE_MEMBER_NAMES].find((name) => destType.getProperty(name) !== undefined);
    flagRetype(valueExpr, viaDest ?? laundered);
  };

  const scanRetyping = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      checkConversion(node.expression, checker.getTypeFromTypeNode(node.type));
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const arg of node.arguments ?? []) checkConversion(arg, checker.getContextualType(arg));
    } else if (ts.isReturnStatement(node) && node.expression !== undefined) {
      checkConversion(node.expression, checker.getContextualType(node.expression));
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      checkConversion(node.body, checker.getContextualType(node.body));
    } else if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      node.initializer !== undefined
    ) {
      checkConversion(node.initializer, checker.getTypeFromTypeNode(node.type));
    } else if (
      ts.isBinaryExpression(node) &&
      VALUE_ASSIGNMENT_OPS.has(node.operatorToken.kind) &&
      (ts.isIdentifier(node.left) ||
        ts.isPropertyAccessExpression(node.left) ||
        ts.isElementAccessExpression(node.left))
    ) {
      // Assignment into an already-typed slot (`d = planner` on `let d: Askable`,
      // `slot.a = planner`, `arr[0] = planner`). Destructuring-pattern targets are
      // ArrayLiteral/ObjectLiteral LHS — pass 1 handles extraction there, so they are
      // excluded above. An evolving-any binding is narrowed to the real type at its use
      // (the call stays sited), so it is not a laundering boundary; an explicit `: any`
      // annotation is (the call runs unsited), so only the implicit case is skipped.
      const destType = checker.getTypeAtLocation(node.left);
      if (!isEvolvingAny(node.left, destType, checker)) checkConversion(node.right, destType);
    }
    ts.forEachChild(node, scanRetyping);
  };

  for (const statement of body.statements) scanRefs(statement);
  for (const statement of body.statements) scanCalls(statement);
  for (const statement of body.statements) scanRetyping(statement);

  // Dedupe: the passes can, in principle, name the same escape at the same spot.
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True iff the symbol is a facade-declared function or method (a callable). */
function isFacadeCallable(symbol: ts.Symbol | undefined): boolean {
  return (
    isFacadeDeclared(symbol) &&
    symbol !== undefined &&
    (symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method)) !== 0
  );
}

/**
 * The first site-producing facade member reachable in `type` (the world-read registry's
 * members plus `ask`, as declared in the facade `.d.ts`), or undefined. Walks the type
 * directly, then union / intersection constituents, type arguments (`Agent[]`,
 * `Promise<Agent>`), and properties (a container holding a facade value), depth- and
 * cycle-bounded.
 *
 * This is the "is this value really an `Agent` / the `files` object" test the retyping
 * boundary keys off. It deliberately keys on the *site member*, not on any facade-
 * declared symbol: an artifact result carries no site member — a `Node<T>` exposes only
 * `then`, an awaited result is a primitive — so retyping ask/read RESULTS stays legal,
 * while retyping the receiver that would resolve `.ask`/`.read` to a facade site is caught.
 *
 * **Bare member names are sound HERE, unlike in passes 1 and 2, and the next task relies on
 * the difference.** Identity is not decided by the name: the name is looked up as a PROPERTY
 * OF A TYPE and then run through `isFacadeDeclared`. Property resolution against a type is
 * already declaration-based, so `SITE_MEMBER_NAMES` supplies candidate keys and the
 * facade-declared check is the identity test. The top-level `log` is a function declaration,
 * not a property of any facade type, so `git.log`'s arrival cannot make a `log` property
 * resolve to it. The invariant this rests on: **no two facade containers declare the same
 * member name** — a collision would keep the boolean answer correct but make the RETURNED
 * name (which the diagnostic message quotes) ambiguous. `files.grep` and the `git.*` members
 * keep that invariant; breaking it would mean threading the container through here too.
 */
function facadeSiteMember(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
  depth = 0,
): string | undefined {
  if (depth > FACADE_SITE_DEPTH || seen.has(type)) return undefined;
  seen.add(type);
  for (const name of SITE_MEMBER_NAMES) {
    if (isFacadeDeclared(type.getProperty(name))) return name;
  }
  if (type.isUnionOrIntersection()) {
    for (const constituent of type.types) {
      const found = facadeSiteMember(constituent, checker, seen, depth + 1);
      if (found !== undefined) return found;
    }
  }
  for (const arg of typeArguments(type, checker)) {
    const found = facadeSiteMember(arg, checker, seen, depth + 1);
    if (found !== undefined) return found;
  }
  for (const property of type.getProperties()) {
    if (property.valueDeclaration === undefined) continue;
    const propType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration);
    const found = facadeSiteMember(propType, checker, seen, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Instantiated type arguments of an object reference (`Agent[]`, `Node<Agent>`); [] otherwise. */
function typeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return [];
  return checker.getTypeArguments(type as ts.TypeReference);
}

/**
 * True iff `left` is an evolving-any binding (`let x;` with no annotation, typed `any`).
 * Such a binding narrows to the assigned type at its use, so a facade call through it
 * stays sited — it is not a laundering boundary. An explicit `: any`/`: unknown`
 * annotation is a different case (the call runs unsited) and is NOT skipped.
 */
function isEvolvingAny(left: ts.Expression, leftType: ts.Type, checker: ts.TypeChecker): boolean {
  if ((leftType.flags & ts.TypeFlags.Any) === 0 || !ts.isIdentifier(left)) return false;
  const declaration = checker.getSymbolAtLocation(left)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.type === undefined
  );
}

/**
 * The facade callable a call resolves to, as a (declaring container, member) pair — or
 * undefined if the call does not resolve into the facade `.d.ts`. Resolving through the
 * signature — not the callee expression's symbol — is what lets the defense-in-depth pass
 * see a computed member callee (`files["read"](x)`), whose callee has no symbol but whose
 * resolved signature is still the facade method. The container comes from the same
 * declaration (`files.read` → `"files"`; a top-level `agent()` → undefined), so the caller
 * can ask the registry rather than matching a bare name.
 */
function facadeCallee(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): { container: string | undefined; member: string } | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.getSourceFile().fileName !== FACADE_FILE_NAME) {
    return undefined;
  }
  const name = (declaration as ts.FunctionDeclaration | ts.MethodSignature).name;
  if (name === undefined || !ts.isIdentifier(name)) return undefined;
  return { container: facadeContainerOf(declaration), member: name.text };
}

/** True iff `node` is the member name of a property access (`x.NAME`), not a value. */
function isPropertyAccessName(node: ts.Identifier): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
}

/**
 * True iff `node` is the callee expression of a direct call (`f(...)`, `x.m(...)`).
 * Distinct from `domain.isDirectCallee` (which asks whether an expression is a callable
 * literal for exactness): here "direct" is the syntactic siting position — the one spot a
 * facade callable is allowed to appear.
 */
function isDirectCallee(node: ts.Expression): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression === node;
}
