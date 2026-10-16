import { UNPHASED_ID } from "./constants.js";
import type { OrderEvent, PhaseInfo } from "./causality-order.js";
import { KIND_RANK, reduceOrdering, type OrderKind } from "./causality-reduce.js";
import type { CausalityGraph, Certainty, OrderEdge, Phase, Step } from "./causality-graph.js";

/**
 * 阶段视图：作者用 `phase("名字")` 标记施加的分组，以及它在因果图上的**商图**
 *
 * 因果图本体一字不动——这里只做两件事，都是对已完成的图的机械改写：
 *
 *  - **跨阶段拷贝**：被 k>1 个阶段认领的 step 变成 k 份拷贝（`~` 后缀 id + `source` 联
 *    key，与 may-set 车道拷贝同机制、同分隔符），使「每个 step 恰有一个 phase」的全划分
 *    成立；
 *  - **商图**：归约后的 step 边按认领关系投影到阶段对上，去重后跑同一个
 *    {@link reduceOrdering}。
 *
 * 零标记脚本这里整体是恒等函数：三个字段全部缺席，既有快照逐字节不动。这不是优化，是
 * 契约——UI 的视图切换条件就是「阶段词汇表在场与否」。
 *
 * 单独一个模块而不是塞进 causality-graph.ts：那份文件已经在 max-lines 上，而阶段是它
 * 上面的一层视图，正如因果图是站点图上面的一层视图。
 */

/** 拷贝 id 分隔符：与 may-set 车道拷贝同一个（两种展开叠加时形如 `ask#2~actor#1~phase#2`）。 */
const COPY_SEPARATOR = "~";

/** 认领关系：谁属于哪个阶段，以及该认领有多确定。全部按**站点 id** 键。 */
interface PhaseClaims {
  /** 站点 -> 认领它的阶段，按 issue 顺序去重。 */
  bySite: Map<string, string[]>;
  /** `${site}|${phase}` -> 该阶段内部的认领 certainty。 */
  certainty: Map<string, Certainty>;
  /** 阶段 -> 首个成员 issue 的时钟位置；商图事实的排序键。 */
  position: Map<string, number>;
  /** `${site}|${phase}` -> 该站点在该阶段的首次 / 末次 issue 位置（时间可行性判定）。 */
  firstIssue: Map<string, number>;
  lastIssue: Map<string, number>;
}

/** 商图的输入：归约后的 step 边（sink 边已剔除），certainty 已按端点继承过。 */
export interface PhaseSourceFact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** carry 边改型前的底层 kind；carry 最小化按它判见证强度。 */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * 见证这条事实的 issue 事件所在的阶段集（只有 await 屏障产生的 seq 事实带它；见
   * causality-graph.ts 的 `Fact.toPhases`）。头端收窄按 {@link headPhasesOf}。
   */
  toPhases?: ReadonlySet<string>;
}

/**
 * 一条边的头端应落在哪些阶段上：**有来源信息就取交集，没有就全展开**。
 *
 * 拷贝改写与商图投影必须用同一条规则，否则 `phaseEdges` 和下钻里的 step 边会讲两个不同的
 * 故事——这是把两个消费者绑在一个函数上的全部理由。
 *
 * 交集在实践中等于 `toPhases` 自己（屏障事实的见证阶段必然是头站点的认领阶段），交集写出来
 * 是为了让「阶段被丢弃/收窄」这类上游变化不会把边挂到不存在的阶段上。
 */
function headPhasesOf(claiming: readonly string[], toPhases: ReadonlySet<string> | undefined): string[] {
  if (toPhases === undefined) return [...claiming];
  const narrowed = claiming.filter((phase) => toPhases.has(phase));
  return narrowed.length > 0 ? narrowed : [...claiming];
}

/**
 * 从 issue 事件读出认领关系。issue 是 step 的身份时刻，所以这一趟就是全部的归属逻辑。
 *
 * 每个 (站点, 阶段) 的 certainty 单独推导：该阶段内**存在**一次区域链确定的 issue，且该
 * step 不是 control 边的目标。逐字对应 causality-graph.ts 的 `certaintyOf`，只是把「所有
 * issue」换成「该阶段的 issue」——共享 helper 在 preflight（顶层）与 gate（循环+分支内）
 * 各一份拷贝时，两份的 certainty 因此可以不同，这正是拷贝要单独推导的理由。
 */
export function collectPhaseClaims(
  events: readonly OrderEvent[],
  steps: ReadonlySet<string>,
  certainChain: (chain: readonly string[]) => boolean,
  controlled: ReadonlySet<string>,
): PhaseClaims {
  const bySite = new Map<string, string[]>();
  const position = new Map<string, number>();
  const firstIssue = new Map<string, number>();
  const lastIssue = new Map<string, number>();
  const certainSeen = new Set<string>();
  // 与 causality-graph.ts 同一个时钟：每个 issue 事件走一格，不论它是否落在图里的 step 上。
  let clock = 0;
  for (const event of events) {
    if (event.at !== "issue") continue;
    const at = clock;
    clock += 1;
    if (!steps.has(event.step)) continue;
    const claiming = bySite.get(event.step);
    if (claiming === undefined) bySite.set(event.step, [event.phase]);
    else if (!claiming.includes(event.phase)) claiming.push(event.phase);
    if (!position.has(event.phase)) position.set(event.phase, at);
    const key = `${event.step}|${event.phase}`;
    if (!firstIssue.has(key)) firstIssue.set(key, at);
    lastIssue.set(key, at);
    if (certainChain(event.regions)) certainSeen.add(key);
  }

  const certainty = new Map<string, Certainty>();
  for (const [site, claiming] of bySite) {
    for (const phase of claiming) {
      const key = `${site}|${phase}`;
      certainty.set(key, certainSeen.has(key) && !controlled.has(site) ? "always" : "maybe");
    }
  }
  return { bySite, certainty, firstIssue, lastIssue, position };
}

/**
 * 把阶段词汇表加到完成的因果图上：拷贝、`Step.phase`、阶段表、阶段边。
 *
 * 在 `expandMaySetLanes` **之后**运行（对车道拷贝逐份认领），且与它同为「对成品图的机械
 * 改写」：步骤集、车道、region、step 边的既有内容都不重算。
 */
export function projectPhaseGraph(
  graph: CausalityGraph,
  phases: readonly PhaseInfo[],
  claims: PhaseClaims,
  facts: readonly PhaseSourceFact[],
  sharesIteration: (a: string, b: string) => boolean,
): CausalityGraph {
  if (phases.length === 0) return graph; // 零标记 → 零词汇表，图逐字节不动

  const claimsOf = (siteId: string): string[] => claims.bySite.get(siteId) ?? [UNPHASED_ID];
  const certaintyOfClaim = (siteId: string, phase: string): Certainty =>
    claims.certainty.get(`${siteId}|${phase}`) ?? "maybe";

  /**
   * 时间可行性：一条 a→b 的边能不能落在拷贝对 (a@P, b@Q) 上。
   *
   * 每份阶段拷贝**占据一个时间位置**，这是它与 may-set 车道拷贝的根本差别——车道拷贝同 rank
   * 并排，全展开不会断言任何顺序；阶段拷贝全展开会断言假的顺序（「gate 的 bench settle 在
   * preflight 的 bench issue 之前」）。而这里的信息 walk 是有的：每个 (站点, 阶段) 的 issue
   * 位置。多序是被许可的方向，错序不是。
   *
   * 两条通道，或关系：
   *  - **位置**：b 在 Q 里至少有一次 issue 落在 a 在 P 里首次 issue 之后；
   *  - **重复**：两个站点共享一个封闭迭代区域。这条**不是可选项**——第 k 轮的生产者喂第
   *    k+1 轮的拷贝，位置上是「在前」而实际可实现（reduce-accumulator 的教训）。去掉它，
   *    跨阶段的循环携带数据会整片消失，而那是凭空造出并发，唯一被禁止的方向。
   *
   * 与 causality-graph.ts 的 `realizableCarry` 共用同一个 `sharesIteration`：同一个关系上的
   * 同一个问题，两处不能各答一次。
   */
  const admits = (from: string, fromPhase: string, to: string, toPhase: string): boolean => {
    const firstFrom = claims.firstIssue.get(`${from}|${fromPhase}`);
    const lastTo = claims.lastIssue.get(`${to}|${toPhase}`);
    if (firstFrom === undefined || lastTo === undefined) return true; // 无位置可判：不拦
    return lastTo > firstFrom || sharesIteration(from, to);
  };
  /**
   * 受时间可行性约束的 kind。`carry` 不在内：它自己的可实现性在 `realizableCarry` 已经判过，
   * 而且 carry 断言的就是「下一轮」，位置比较对它无意义。`fifo` 不在内：车道规则已经决定了
   * 它，且同站点的两份拷贝共享车道、确实彼此 FIFO 排序。
   */
  const ADMITTED_KINDS = new Set<OrderKind>(["data", "control", "seq"]);

  // --- 1. 跨阶段拷贝 ---------------------------------------------------------------
  // 拷贝是 **both-run，不是候选**——不要顺手按 may-set 拷贝的类比改成 maybe。站点真的从
  // 两个调用方各自发出（共享 helper 在 preflight 与 gate 各跑一次），两份都会执行；每份的
  // certainty 只反映**它自己那个阶段**的认领有多确定，不表示「二者之一」。
  //
  // `region` 与 `repeat` 是**站点级事实**（取自站点首次 issue），故意不按阶段重算：拷贝是
  // 对成品图的机械改写，重算区域归属要的是每阶段一份的 region 树，那是另一个决定。所以
  // gate 那份 bench 拷贝带着 preflight 首个 issue 的 `region` 和 `stack`——不要在没有决定
  // 的情况下把它「修好」。
  const copiesOf = new Map<string, (Step & { phase: string })[]>();
  for (const step of graph.steps) {
    const siteId = step.source ?? step.id;
    const claiming = claimsOf(siteId);
    if (claiming.length < 2) continue;
    copiesOf.set(
      step.id,
      claiming.map((phase) => ({
        ...step,
        certainty: weakest([step.certainty, certaintyOfClaim(siteId, phase)]),
        id: `${step.id}${COPY_SEPARATOR}${phase}`,
        phase,
        // `source` 是运行时实际上报的站点 id，**只设一次**：车道拷贝已经带上了，沿用。
        source: siteId,
      })),
    );
  }

  const steps: Step[] = graph.steps.flatMap((step) => {
    const copies = copiesOf.get(step.id);
    if (copies !== undefined) return copies;
    // k = 1：认领唯一，所以该阶段的 certainty 与 step 自己的逐字相等（全部 issue 都在
    // 这个阶段里），不必覆盖。
    return [{ ...step, phase: claimsOf(step.source ?? step.id)[0] as string }];
  });

  // --- 2. 边改写：镜像 expandMaySetLanes 的机制 --------------------------------------
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));
  const siteOf = (id: string): string => {
    const step = stepById.get(id);
    return step === undefined ? id : (step.source ?? step.id);
  };
  // 事实的来源信息按**站点对**索引（事实先于两种拷贝存在，且每个有序对只有一条），所以
  // 车道拷贝的边先折算回站点对再查。
  const provenance = new Map<string, ReadonlySet<string>>();
  for (const fact of facts) {
    if (fact.toPhases !== undefined) provenance.set(`${fact.from}|${fact.to}`, fact.toPhases);
  }

  const endpointsOf = (
    id: string,
    toPhases?: ReadonlySet<string>,
  ): { certainty: Certainty; id: string; lane?: string; phase: string }[] => {
    const copies = copiesOf.get(id);
    if (copies !== undefined) {
      const heads = new Set(headPhasesOf(claimsOf(siteOf(id)), toPhases));
      return copies
        .filter((copy) => heads.has(copy.phase))
        .map((copy) => ({
          certainty: copy.certainty,
          id: copy.id,
          lane: copy.lane,
          phase: copy.phase,
        }));
    }
    const step = stepById.get(id);
    return [
      {
        certainty: step?.certainty ?? "maybe",
        id,
        lane: step?.lane,
        phase: claimsOf(siteOf(id))[0] as string,
      },
    ];
  };

  const edges: OrderEdge[] = [];
  for (const edge of graph.edges) {
    // 两端都不是拷贝 → 原样保留。这条早退也是「零标记逐字节不变」的构造性保证：单端点对
    // 从不经过下面任何一条规则。
    if (!copiesOf.has(edge.from) && !copiesOf.has(edge.to)) {
      edges.push(edge);
      continue;
    }
    const fromSite = siteOf(edge.from);
    const toSite = siteOf(edge.to);
    // 尾端不按 provenance 收窄（settle 事件不带阶段），但**尾端同样受时间可行性约束**——
    // 这就是那条尾侧伪边（拷贝排在产出它自己实参的那个 ask 之前）的归宿。
    const pairs: { certainty: Certainty; from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const tail of endpointsOf(edge.from)) {
      for (const head of endpointsOf(edge.to, provenance.get(`${fromSite}|${toSite}`))) {
        // fifo 按车道匹配，与车道展开同一条规则。同站点的阶段拷贝共享车道，所以它们之间的
        // fifo 边幸存——这是对的：一个站点的两次发出确实彼此 FIFO 排序。
        if (edge.kind === "fifo" && tail.lane !== head.lane) continue;
        // 同一份拷贝到自己：只有原边本来就是自边时才成立（不同站点的拷贝 id 不可能相等），
        // 所以这是把不变量写下来，不是语料里到达过的分支。
        if (tail.id === head.id && edge.from !== edge.to) continue;
        const pair = {
          certainty: weakest([edge.certainty, tail.certainty, head.certainty]),
          from: tail.id,
          to: head.id,
        };
        pairs.push(pair);
        if (!ADMITTED_KINDS.has(edge.kind) || admits(fromSite, tail.phase, toSite, head.phase)) {
          admitted.push(pair);
        }
      }
    }
    // 全被拦下 → 退回全展开，与 {@link headPhasesOf} 同一个姿态：一条真实的序在哪儿都不
    // 可实现，说明位置判断误导了我们，而静默删掉一条真实的序就是凭空造出并发。
    for (const pair of admitted.length > 0 ? admitted : pairs) {
      edges.push({ ...edge, ...pair });
    }
  }

  // --- 3. 阶段表：有成员的阶段，unphased 排最前 -------------------------------------
  const members = new Set<string>(steps.map((step) => step.phase as string));
  const phaseList: Phase[] = [];
  if (members.has(UNPHASED_ID)) phaseList.push({ id: UNPHASED_ID });
  for (const phase of phases) {
    // 成员为零的阶段丢掉（may-set 收窄可能把某阶段的全部 step 拿走）——空节点没有家可指。
    if (!members.has(phase.id)) continue;
    phaseList.push({
      id: phase.id,
      loc: phase.loc,
      name: phase.name,
      ...(phase.fill === undefined ? {} : { fill: phase.fill }),
    });
  }
  const live = new Set(phaseList.map((phase) => phase.id));

  // --- 4. 商图：在认领关系上算，不依赖拷贝的物化 ------------------------------------
  const quotient: PhaseSourceFact[] = [];
  for (const fact of facts) {
    // 与拷贝改写逐条同规则：头端收窄（{@link headPhasesOf}）+ 时间可行性（{@link admits}），
    // 且同样只在至少一端被拷贝时生效。两个消费者不能各讲一个故事——`phaseEdges` 与下钻里的
    // step 边讲的必须是同一件事。
    const tails = claimsOf(fact.from);
    const heads = headPhasesOf(claimsOf(fact.to), fact.toPhases);
    const copied = tails.length > 1 || claimsOf(fact.to).length > 1;
    const gated = copied && ADMITTED_KINDS.has(fact.kind);
    const pairs: { from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const from of tails) {
      for (const to of heads) {
        pairs.push({ from, to });
        if (!gated || admits(fact.from, from, fact.to, to)) admitted.push({ from, to });
      }
    }
    for (const { from, to } of admitted.length > 0 ? admitted : pairs) {
      if (!live.has(from) || !live.has(to)) continue;
      // 阶段内序不出图；阶段内的 carry 是「循环整个住在一个阶段里」的画法，留成自环。
      if (from === to && fact.kind !== "carry") continue;
      quotient.push({
        certainty: fact.certainty,
        from,
        kind: fact.kind,
        to,
        ...(fact.carryOf === undefined ? {} : { carryOf: fact.carryOf }),
      });
    }
  }

  const position = (id: string): number => claims.position.get(id) ?? 0;
  const deduped = dedupePhaseFacts(quotient).sort(
    (a, b) =>
      position(a.from) - position(b.from) ||
      position(a.to) - position(b.to) ||
      a.kind.localeCompare(b.kind),
  );
  // 阶段边不携带 `exact`：那是 data 边的 taint 见证位，在商上无定义。
  const phaseEdges: OrderEdge[] = reduceOrdering(deduped).map((fact) => ({
    certainty: fact.certainty,
    from: fact.from,
    kind: fact.kind,
    to: fact.to,
  }));

  const sink = graph.sink;
  return {
    edges,
    lanes: graph.lanes,
    phaseEdges,
    phases: phaseList,
    regions: graph.regions,
    steps,
    // 阶段级 sink 边不出图（UI 由 fedBy step 的 phase 推导），但 fedBy 自己要跟着拷贝走。
    ...(sink === undefined
      ? {}
      : { sink: { fedBy: sink.fedBy.flatMap((id) => endpointsOf(id).map((end) => end.id)) } }),
  };
}

/**
 * 每个有序阶段对留一条事实：kind 取最强（{@link KIND_RANK}）、certainty maybe-wins——
 * **逐字镜像 step 级 `dedupeFacts`**，一致性优先（「任一 always 见证即 always」在商上
 * 语义更准）。
 */
function dedupePhaseFacts(facts: readonly PhaseSourceFact[]): PhaseSourceFact[] {
  const byPair = new Map<string, PhaseSourceFact>();
  for (const fact of facts) {
    const key = `${fact.from}|${fact.to}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { ...fact });
      continue;
    }
    if (KIND_RANK[fact.kind] > KIND_RANK[existing.kind]) existing.kind = fact.kind;
    if (existing.carryOf === undefined && fact.carryOf !== undefined) existing.carryOf = fact.carryOf;
    if (fact.certainty === "maybe") existing.certainty = "maybe";
  }
  return [...byPair.values()];
}

function weakest(values: readonly Certainty[]): Certainty {
  return values.includes("maybe") ? "maybe" : "always";
}
