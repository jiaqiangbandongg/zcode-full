import type { RegionKind } from "./constants.js";
import type { OrderKind } from "./causality-reduce.js";
import type { SiteLoc, NamePattern } from "./types.js";

// causality-graph.ts 顶到 oxlint max-lines 上限（400 行），把因果图的公开类型
// （Step / Region / OrderEdge / Lane / Phase / CausalityGraph 与三个 lane 常量）和内部的
// Fact 拆到本文件；公开面仍从 causality-graph.ts 导出（那里原样再导出）。本文件不 import
// `typescript`，浏览器端的 `./projections` 桶可安全到达。

/** `hole`: an OPEN `hole<T>()` — the script waits there for the main agent's fill. */
export type StepKind = "ask" | "world-read" | "hole";
export type Certainty = "always" | "maybe";

/** The single lane every `files.*` read runs in. */
export const WORKSPACE_LANE = "workspace";
/** The main agent's lane: where every open hole waits (docs/analysis.md「Sites」). */
export const MAIN_LANE = "main";
/** Lane of an ask whose receiver the analysis could not resolve to any actor site. */
export const UNKNOWN_LANE = "unknown";
/** The terminal marker: the artifact the script returns. */
export const SINK_ID = "sink";

export interface Step {
  /** A site id (`ask#3`, `world-read#1`); it is also the runtime instance's key. */
  id: string;
  kind: StepKind;
  label: string;
  /** `label` 只拿到兜底串时，内联 `agent()` receiver 的模板形状。 */
  labelPattern?: NamePattern;
  loc: SiteLoc;
  /** Actor site id, or `workspace` / `unknown`. For an unexpanded may-set, `lanes[0]`. */
  lane: string;
  /** Present only when the ask receiver is dynamically selected: the candidate lanes. */
  lanes?: string[];
  /**
   * The step this one was expanded from, emitted only on a may-set copy (see
   * `expandMaySetLanes` in causality-graph-lanes.ts). It is the site id a runtime instance
   * actually reports, which is what makes it the live overlay's join key (`source ?? id`
   * against `node.siteId`, narrowed by `node.actorSiteId === lane`).
   *
   * This composes with future per-callsite specialization rather than competing with it. Once
   * specialization lands, the expanded-from id IS the specialized site id —
   * `ask#3/2~actor#1` carries source `ask#3/2` — so the join stays stable under both
   * features. On a copy the field means "the site the runtime reports", NOT "the site
   * before specialization".
   */
  source?: string;
  /** Innermost enclosing region id. */
  region: string;
  certainty: Certainty;
  /**
   * The author-declared phase this step belongs to (`phase#2`, or the reserved
   * `unphased`). Present only when the script declares at least one `phase()` marker, in
   * which case EVERY step carries one — a step claimed by k>1 phases is expanded into k
   * copies to keep the partition total (see phase-graph.ts).
   */
  phase?: string;
  /**
   * How this step's instances relate when an enclosing region repeats:
   *   `stack`  — they coexist, which is the one multiplicity cue (stacked cards);
   *   `serial` — they follow one another, already visible as the cycle-closing arrow.
   * Absent when the step runs at most once. Finding: the cue splits on
   * CONCURRENCY, not cardinality — a step is `serial` exactly when a barrier inside
   * the repeating region settles it, or when a fixed actor's mailbox serializes it.
   */
  repeat?: "stack" | "serial";
  /**
   * The filled hole whose body wrote this step: the `hole#<hash>/` prefix of its site id, or,
   * for an open hole (whose id is a bare name key), the site table's `fill`. Absent outside
   * every fill.
   */
  fill?: string;
}

export interface Region {
  id: string;
  kind: RegionKind;
  parent?: string;
  loc?: SiteLoc;
  /** Derivable literal round count of a `for`; model-only, never displayed. */
  bound?: number;
  label?: string;
}

export interface OrderEdge {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** `data` edges only: the taint witness path's exactness bit. Model-only. */
  exact?: boolean;
}

export interface Lane {
  id: string;
  /** The author's verbatim word, when `agent()` was given a literal. Never a reconstruction. */
  name?: string;
  /**
   * `name` 缺席而 `agent()` 首参是带洞的模板串时，那个名字的静态形状。省略号在渲染时才加。
   */
  namePattern?: NamePattern;
  loc?: SiteLoc;
  /**
   * Enclosing iteration regions of the `agent()` call, outermost first. A non-empty
   * list makes the lane a family — one fresh actor per element — and nested iterations
   * MULTIPLY, so multiplicity is the product and a single id cannot express it.
   */
  families?: string[];
}

/**
 * An author-declared phase: a name for a group of steps, and the position of the marker
 * that opened it. The synthetic fallback `unphased` carries neither — the UI shows a
 * localized word for it, exactly as it does for the `workspace` / `unknown` lanes.
 */
export interface Phase {
  id: string;
  name?: string;
  loc?: SiteLoc;
  /** The filled hole whose body wrote this phase (a filled hole's own phase names itself). */
  fill?: string;
}

export interface CausalityGraph {
  steps: Step[];
  regions: Region[];
  lanes: Lane[];
  edges: OrderEdge[];
  /** Step ids whose artifacts reach the script's return; absent when it returns nothing. */
  sink?: { fedBy: string[] };
  /**
   * The phase vocabulary, present TOGETHER WITH `phaseEdges` and `Step.phase` or not at
   * all: a script with no `phase()` markers gets none of the three and its graph is
   * byte-identical to what it was before the feature. `unphased` first when it has
   * members, then the author's phases in first-reach order.
   */
  phases?: Phase[];
  /** The quotient of `edges` by the phase partition. Never carries `exact`. */
  phaseEdges?: OrderEdge[];
}

/** 投影内部的有序事实（去重、回边定型、归约的输入）；不在包的公开面上。 */
export interface Fact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  exact?: boolean;
  /** carry 边的底层 kind（改型前的前向 kind）；carry 最小化按它判见证强度。 */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * 见证这条事实的 issue 事件所在的阶段集（**只有 await 屏障产生的 seq 事实**带它）。
   * 阶段拷贝按它收窄边的头端：屏障事实是在某一次具体 issue 上被见证的，而当前「一站点一步」
   * 的设计把同一站点在不同调用点的多次 issue 合成了一个 step，丢掉这个来源就会
   * 把「gate 的 bench 发出前 cargo test 已 settle」当成 preflight 的 bench 也成立——
   * 一条方向错误的时间断言（多序是被许可的，错序不是）。
   *
   * 缺席 = 无来源信息 = 头端全展开（data/control/fifo 与区域重复事实按契约全展开）。
   *
   * 尾端没有对称的来源信息（settle 事件不带阶段），但**尾侧不再是缺口**：阶段拷贝的时间
   * 可行性判定（phase-graph.ts 的 `admits`）按位置对**两端**一视同仁地拦截，所以「拷贝排
   * 在产出它自己实参的那个 step 之前」这类伪边由那条规则消掉，不靠这里的来源信息。
   */
  toPhases?: Set<string>;
  /**
   * 这条 `seq` 事实只能靠**下一轮**成立：`from` 在一个以 `continue` 结束的分支臂里发出，
   * `to` 在同一个循环体里更靠后的位置。线性的时间走查按 may 语义会继续走完循环体，于是
   * 把「fixer@k 先于 juries@k+1」记成了同一轮的前向顺序；控制流投影对同一处给的是
   * `loop via=continue`。带此标记的事实在回边定型时按 carry 处理（配对里全部事实都带才算，
   * 见 `dedupeFacts`，causality-graph-lanes.ts）。以 `break` 结束的臂更强：其中的 step 根本
   * 不可能先于同一循环里后面的 step，那样的事实直接不发。
   */
  viaJump?: true;
}
