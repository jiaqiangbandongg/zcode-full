import type { ScriptLoc } from "../compiler/compile.js";

/**
 * The site-graph types: the may-flow digraph over facade call sites emitted by the
 * analyzer. This module is the
 * shared vocabulary; the taint pass (later step) fills in the edges.
 */

/**
 * A node kind. `source`/`sink` are the two virtual endpoints; the rest are facade
 * call sites. `fan-out` nodes are only emitted by the taint pass once an iteration
 * candidate is shown to reach a facade site — this substrate never produces them.
 */
export type SiteKind = "ask" | "world-read" | "join" | "fan-out" | "hole" | "source" | "sink";

/** A 1-based, prelude-stripped location in the author's script. */
export type SiteLoc = ScriptLoc;

/**
 * 名字只在运行时才成形（`` agent(`研究员${i + 1}`) ``）时，静态能拿到的那部分形状：
 * 第一个洞之前的字面量（`head`）与最后一个洞之后的字面量（`tail`）。
 *
 * 为什么只能拿到形状：把模板折成 8 个具体名字要求把 `map` 展开，而 `×N` 与
 * `maybe stack` 存在的意义正是拒绝展开。所以这里给出的是形状，不是名字。
 *
 * 不变量：`head`/`tail` 至少有一个在场（拿不到就返回 undefined，不返回空 pattern），
 * 两者都已 trim，且各自至少含一个字母或数字——`` `${x}-` `` 渲染成 `…-` 比「未命名智能体」
 * 更差，所以那种 affix 直接丢弃。省略号在**渲染时**才加，这里只搬数据。
 */
export interface NamePattern {
  head?: string;
  tail?: string;
}

/**
 * A graph node. The virtual `source`/`sink` carry no location and a fixed label;
 * a `hole` node is an OPEN `hole<T>()` site (docs/analysis.md「Sites」): its label is the
 * hole's name, its prompt is a sink and its result a value of type T from outside the run;
 * every other node is positioned at its facade call site. `actors` is populated for
 * `ask` nodes only: the may-set of actor site ids the ask's receiver resolves to
 * (the same set that drives the context relation), so the renderer can place the
 * node in its actor lane(s). Ordered by actor source order, deduped. `within` is the
 * id of the nearest enclosing promoted fan-out node when the site's call lies
 * lexically inside a promoted iteration candidate's body — the site then executes
 * once per element;
 * omitted otherwise. `artifactType` is the producer's statically known artifact type
 * (a human-readable type name, provenance semantics) for `ask`/`world-read`/`join`/
 * `fan-out` nodes; absent on the virtual endpoints and when the type is
 * unknowable/uninformative (`any`/`unknown`/`never`/`void`).
 */
export interface SiteNode {
  id: string;
  kind: SiteKind;
  loc?: SiteLoc;
  label: string;
  /**
   * `label` 只拿到兜底串（内联的 `` agent(`研究员${i}`).ask(…) ``——receiver 是调用式，
   * 既非字面量也非标识符，于是落到 `"ask"`）时，模板的静态形状。仅 `ask` 节点可能有。
   */
  labelPattern?: NamePattern;
  actors?: string[];
  within?: string;
  artifactType?: string;
}

/**
 * An actor (`agent()` site). Rendered as a lane, not a graph node. `within` is the
 * id of the nearest enclosing promoted fan-out when the `agent()` call lies inside
 * that fan-out's body: a lane FAMILY (one fresh actor per element) rather than a
 * single shared lane. Omitted for actors created outside any fan-out.
 */
export interface ActorSite {
  id: string;
  loc: SiteLoc;
  name?: string;
  /**
   * `name` 缺席（`agent()` 的首参不是字面量）而首参是模板字符串时的静态形状。与 `name`
   * 实际互斥：字面量给名字，模板给形状。**刻意不写进 `name`**——`name` 的契约是「作者原样
   * 写下的那个词」，把重建物混进去，下游就再也分不清看到的是字面量还是推断。
   */
  namePattern?: NamePattern;
  within?: string;
}

/**
 * A may-flow edge: "the output of `from` may feed `to`". `data` edges carry
 * artifacts; `context` edges relate asks sharing an actor. `exact` is false once
 * any widening rule fired along the witness path. `port` records a join input /
 * element position when the join argument is a static array literal. `type` is the
 * producer's artifact type name (provenance: the value feeding `to` was computed from
 * `from`'s output), port-refined for edges OUT OF a join; absent on context edges,
 * source-completion edges, and when the type is unknowable/uninformative.
 */
export interface SiteEdge {
  from: string;
  to: string;
  kind: "data" | "context";
  exact: boolean;
  port?: number;
  type?: string;
}

export interface SiteGraph {
  nodes: SiteNode[];
  actors: ActorSite[];
  edges: SiteEdge[];
}
