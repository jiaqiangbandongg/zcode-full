import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";
import { provisionalFanoutId } from "./domain.js";

/**
 * Producer-side artifact types for data edges. Every data edge's `from` is a producer
 * site (ask / world-read / join / fan-out) with a statically known artifact type; this
 * module computes that type as a human-readable string, plus per-port types for joins
 * over a static array literal. Semantics is PROVENANCE: an edge means "a value computed
 * from A's output feeds B", so the label is A's artifact type — not a claim about the
 * concrete wire value.
 *
 * The type names come from the live checker's {@link ts.TypeChecker.typeToString} today;
 * schema synthesis will later upgrade these to synthesized-schema names.
 * Uninformative labels (`any`/`unknown`/`never`/`void`) are omitted so a meaningless
 * string is never drawn.
 */

/** Per-site artifact types and per-port join element types. */
export interface ArtifactTypes {
  /**
   * Whole-value artifact type per site, keyed by site id. Ask/world-read/join sites use
   * their final ids (`ask#1`); fan-out candidates are keyed by their PROVISIONAL id
   * (`fan-out@order`, see {@link provisionalFanoutId}) — the same key the taint pass
   * stamps into occurrences, so graph assembly looks them up before the `fan-out#N`
   * rename.
   */
  siteType: Map<string, string>;
  /**
   * Per-element awaited types of a join over a static array literal, keyed by join id.
   * Index i is the type of array element i (the join input at port i), or `undefined`
   * when that element's type is unknowable/uninformative. Absent for joins whose
   * argument is not a static array literal (no ports exist).
   */
  joinPortTypes: Map<string, (string | undefined)[]>;
}

/** typeToString flags: a named interface prints as its name (`Flaky`), no `…` truncation. */
const FORMAT_FLAGS = ts.TypeFormatFlags.NoTruncation;

/** Rendered type names that carry no information and must not be drawn as a label. */
const UNINFORMATIVE = new Set<string>(["any", "unknown", "never", "void"]);

/**
 * Cap on fan-out array-level unwrapping. Nested maps (`map` of `map`) nest arrays
 * arbitrarily; a fixed bound keeps the peel finite against pathological/cyclic generic
 * types, matching the taint domain's `VALUE_DEPTH_CAP` discipline.
 */
const FANOUT_UNWRAP_CAP = 8;

/**
 * Compute artifact types for every producer site in the table. Pure over the checker and
 * the AST refs the site table already resolved.
 */
export function computeArtifactTypes(workflow: WorkflowProgram, table: SiteTable): ArtifactTypes {
  const checker = workflow.program.getTypeChecker();
  const siteType = new Map<string, string>();
  const joinPortTypes = new Map<string, (string | undefined)[]>();

  const renderRaw = (type: ts.Type): string => checker.typeToString(type, undefined, FORMAT_FLAGS);
  const render = (type: ts.Type | undefined): string | undefined => {
    if (type === undefined) return undefined;
    const text = renderRaw(type);
    return UNINFORMATIVE.has(text) ? undefined : text;
  };
  const set = (id: string, type: ts.Type | undefined): void => {
    const text = render(type);
    if (text !== undefined) siteType.set(id, text);
  };
  // The awaited (resolved) type of a call's own type — `Node<T>`/`Promise<T>` -> `T`.
  const awaitedOf = (node: ts.Node): ts.Type | undefined =>
    checker.getAwaitedType(checker.getTypeAtLocation(node));

  // The element type of a genuine `Array<T>`/`ReadonlyArray<T>`, else undefined. We test
  // the reference target's symbol rather than `getNumberIndexType`, because a `string`
  // (and a string-literal union) is number-indexable too — indexing one would wrongly
  // "peel" `("yes" | "no")[]` into `string[][]`.
  const arrayElement = (type: ts.Type): ts.Type | undefined => {
    const name = (type as ts.TypeReference).target?.symbol?.name;
    if (name !== "Array" && name !== "ReadonlyArray") return undefined;
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return args.length > 0 ? args[0] : undefined;
  };

  // A fan-out's collected artifact type. The awaited whole call type of a `.map` is the
  // mapped array (`Node<Review>[]`, or `Node<string>[][]` for nested maps); that leaks the
  // facade promise wrapper into a user-facing label, so we peel array levels to a fixed
  // point — awaiting the element at each level (`Node<Review>` -> `Review`) — and rebuild
  // the `[]` suffixes, so `Node<Review>[]` -> `Review[]` and `Node<string>[][]` ->
  // `string[][]`. A top-level union/intersection innermost element is parenthesized
  // (`(A | B)[]`) to stay well-formed. Falls back to the whole-type rendering when the
  // type is not array-like or the peeled element is uninformative. Joins need no such
  // unwrap: `Promise.all`'s `Awaited<>` already resolves recursively.
  const fanoutType = (call: ts.Node): string | undefined => {
    const whole = awaitedOf(call);
    if (whole === undefined) return undefined;
    const wholeText = render(whole);
    let type = whole;
    let depth = 0;
    while (depth < FANOUT_UNWRAP_CAP) {
      const element = arrayElement(type);
      if (element === undefined) break;
      type = checker.getAwaitedType(element) ?? element;
      depth += 1;
    }
    if (depth === 0) return wholeText; // not array-like: keep the whole rendering
    const elementText = render(type);
    if (elementText === undefined) return wholeText; // uninformative element: fall back
    const base = /\s[|&]\s/.test(elementText) ? `(${elementText})` : elementText;
    return `${base}${"[]".repeat(depth)}`;
  };

  // ask: an explicit `ask<Flaky>` type argument is the artifact type directly; otherwise
  // the awaited return type (`Node<T>` -> `T`, default `T = string`).
  for (const site of table.asks) {
    const typeArg = site.call.typeArguments?.[0];
    const type = typeArg !== undefined ? checker.getTypeFromTypeNode(typeArg) : awaitedOf(site.call);
    set(site.id, type);
  }

  // world-read: the awaited call type (`string` for read, `string[]` for glob).
  for (const site of table.worldReads) set(site.id, awaitedOf(site.call));

  // open hole: the explicit type argument is the contract (9012 requires it); a filled hole is
  // not a producer site, its body's own sites are.
  for (const site of table.holes) {
    if (site.body === undefined && site.typeArg !== undefined) {
      set(site.id, checker.getTypeFromTypeNode(site.typeArg));
    }
  }

  // join: the awaited whole type (a tuple for a static array literal, an array otherwise),
  // plus per-element awaited types when the argument is a static array literal.
  for (const site of table.joins) {
    set(site.id, awaitedOf(site.call));
    if (site.arg !== undefined && ts.isArrayLiteralExpression(site.arg)) {
      joinPortTypes.set(
        site.id,
        site.arg.elements.map((element) => render(awaitedOf(element))),
      );
    }
  }

  // fan-out: array-method candidates take the collected artifact type of the whole call
  // expression (the callback's parent), with the facade promise wrapper unwrapped off the
  // element (see {@link fanoutType}). `for...of` candidates have no call expression, and
  // `void` results (e.g. `forEach`) fall out via the uninformative filter.
  for (const cand of table.iterations) {
    if (cand.form !== "array-method" || cand.call === undefined) continue;
    const text = fanoutType(cand.call);
    if (text !== undefined) siteType.set(provisionalFanoutId(cand.order), text);
  }

  return { joinPortTypes, siteType };
}
