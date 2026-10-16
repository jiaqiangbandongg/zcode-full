// ============================================================
// CreateWorkflow display graph bounding - 工具输出边界的有界投影
// ============================================================
// 从 create-workflow.ts 拆出：阶段词汇表让
// handler 文件越过 max-lines 上限，而裁剪本身是一段自洽的纯逻辑——分析器全图进，契约
// 形状出，无 I/O、无 memo、无端口。与 zcode-protocol-v4/create-workflow-display.ts 从
// rows.ts 拆出同一先例。
//
// 这里装的是一张**显示图**而不再是因果图的镜像。第二层是子代理导向：step 层只剩站点表
// （运行状态与检视器的键，不再画、不再带边），参与者层（每阶段的子代理卡 + 交接边）由
// 分析器的交接图投影供给、这里只做上限与转发，阶段层仍是控制流图的阶段商、仍由本层归约
// （折叠与缩点归约在 create-workflow-graph-fold.ts）。边只有 `{from, to, back?}` 一种形状；
// region / certainty / 边种类留在分析器里，GUI 从不读它们。函数名与载荷字段名沿用历史。

import {
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES,
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS,
  CREATE_WORKFLOW_GRAPH_MAX_HOLES,
  CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS,
  CREATE_WORKFLOW_GRAPH_MAX_LANES,
  CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS,
  CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS,
  CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES,
  CREATE_WORKFLOW_GRAPH_MAX_PHASES,
  CREATE_WORKFLOW_GRAPH_MAX_STEPS,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowEdge,
  type CreateWorkflowHandoff,
  type CreateWorkflowHole,
  type CreateWorkflowLane,
  type CreateWorkflowNamePattern,
  type CreateWorkflowParticipant,
  type CreateWorkflowPhase,
  type CreateWorkflowStep,
  type CreateWorkflowStream,
} from "@zcode/contracts";
import {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  type CausalityGraph,
  type ControlFlowGraph,
  type FlowHole,
  type HandoffGraph,
  UNPHASED,
  // 浏览器端回放视图直接复用本函数：走 /projections
  // 子路径而非根桶，根桶会把 typescript 编译器一起拖进浏览器包。语义与根桶导出完全相同。
} from "@zcode/dynamic-workflow/projections";
// 阶段边的折叠与归约（含有环输入上的缩点规则）单独成模块，见该文件的文件头。
import { foldPhaseEdges, type RawEdge } from "./create-workflow-graph-fold.js";

// display 不经过 tool result budget：图必须在进入工具输出（进而进入实时事件和持久化
// metadata）前独立限长。集合互相引用，所以裁剪顺序是固定的——先 step（源序，截尾保留
// 脚本开头），再收敛到它们引用的 lane，最后按存活的 step 过滤边与 sink。引用完整性优先
// 于保留数量：宁可少画，也不能让 UI 拿到指向不存在节点的 id。
export function boundCausalityGraph(
  graph: CausalityGraph,
  flow?: ControlFlowGraph,
  handoff?: HandoffGraph,
): CreateWorkflowCausalityGraph {
  let truncated = graph.steps.length > CREATE_WORKFLOW_GRAPH_MAX_STEPS;
  const headSteps = graph.steps.slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS);

  // 1. Lanes: only the ones the surviving steps stand in, in the graph's lane order
  //    (workspace first, actors in creation order).
  const wantedLanes = new Set<string>();
  for (const step of headSteps) {
    wantedLanes.add(step.lane);
    for (const lane of step.lanes ?? []) wantedLanes.add(lane);
  }
  const laneList = graph.lanes.filter((lane) => wantedLanes.has(lane.id));
  truncated = truncated || laneList.length > CREATE_WORKFLOW_GRAPH_MAX_LANES;
  const keptLanes = laneList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_LANES);
  const laneIds = new Set(keptLanes.map((lane) => lane.id));

  // 2. A step whose own lane got dropped has nowhere to sit; a may-set narrows instead.
  const steps = headSteps.filter((step) => laneIds.has(step.lane));
  truncated = truncated || steps.length < headSteps.length;
  const stepIds = new Set(steps.map((step) => step.id));

  // 3. Participants and hand-offs (the analyzer's projection, already reduced and in
  //    stack order). A card's steps narrow to the surviving ones and a card left with none
  //    goes; the list then truncates in order (the opener survives, the tail does not),
  //    and hand-offs touching a dropped card go with it. A dropped card's steps stay in
  //    `steps` — run status still joins on them, they just have no card.
  const laneOk = (lane: string): boolean => laneIds.has(lane);
  const participantList: CreateWorkflowParticipant[] = [];
  for (const participant of handoff?.participants ?? []) {
    if (!laneOk(participant.lane)) continue;
    const memberSteps = participant.steps.filter((id) => stepIds.has(id));
    if (memberSteps.length === 0) continue;
    participantList.push({
      id: boundGraphText(participant.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      phase: boundGraphText(participant.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      lane: boundGraphText(participant.lane, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      steps: memberSteps
        .slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS)
        .map((id) => boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS)),
      ...(participant.member === undefined ? {} : { member: { ...participant.member } }),
      ...(participant.many === true ? { many: true as const } : {}),
    });
  }
  truncated = truncated || participantList.length < (handoff?.participants.length ?? 0);
  truncated = truncated || participantList.length > CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS;
  const participants = participantList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const handoffList: CreateWorkflowHandoff[] = (handoff?.handoffs ?? [])
    .filter((edge) => participantIds.has(edge.from) && participantIds.has(edge.to))
    .map((edge) => {
      const types = (edge.types ?? [])
        .slice(0, CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
        .map((type) => boundGraphText(type, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS))
        .filter((type) => type.length > 0);
      return {
        from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
        to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
        ...(edge.back === true ? { back: true as const } : {}),
        ...(types.length > 0 ? { types } : {}),
      };
    });
  truncated = truncated || handoffList.length < (handoff?.handoffs.length ?? 0);
  truncated = truncated || handoffList.length > CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS;
  const handoffs = handoffList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS);

  const sink = (graph.sink?.fedBy ?? [])
    .filter((id) => stepIds.has(id))
    .slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS)
    .map((id) => boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));

  // 4. Phases: the vocabulary is all-or-nothing and comes from the
  //    CONTROL-FLOW projection — every phase some occurrence carries, member steps or not
  //    (a marker-only phase is a position control passes through, so it must show). Edges
  //    touching `entry` / `abort` have no node to land on; edges into `sink` become
  //    `exits`; self-loops say nothing at quotient granularity. Over either bound and the
  //    whole vocabulary goes, `phase` stripped from every step with it: a step naming an
  //    unlisted phase is a dangling reference, and referential integrity beats retention.
  const declaredPhases = flow?.phases;
  const phaseIds = new Set((declaredPhases ?? []).map((phase) => phase.id));
  const rawPhaseEdges: RawEdge[] = [];
  const exitSet = new Set<string>();
  for (const edge of flow?.phaseEdges ?? []) {
    if (edge.from === FLOW_ENTRY || edge.from === FLOW_ABORT || edge.to === FLOW_ABORT) continue;
    if (!phaseIds.has(edge.from)) continue;
    if (edge.to === FLOW_SINK) {
      exitSet.add(edge.from);
      continue;
    }
    if (!phaseIds.has(edge.to)) continue;
    rawPhaseEdges.push({ back: edge.kind === "loop", from: edge.from, to: edge.to });
  }
  const phaseEdges: CreateWorkflowEdge[] = foldPhaseEdges(rawPhaseEdges).map((edge) => ({
    from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    ...(edge.back ? { back: true as const } : {}),
  }));
  const phaseStreams = boundPhaseStreams(graph, declaredPhases, phaseIds);
  // 边的上界管的是发出去的东西，所以在归约**之后**判。
  const phaseVocabularyDropped =
    declaredPhases !== undefined &&
    (declaredPhases.length > CREATE_WORKFLOW_GRAPH_MAX_PHASES ||
      phaseEdges.length > CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES ||
      phaseStreams.length > CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES);
  truncated = truncated || phaseVocabularyDropped;
  const emitPhases = declaredPhases !== undefined && !phaseVocabularyDropped;

  const boundPhases: CreateWorkflowPhase[] = (declaredPhases ?? []).map((phase) => {
    // 合成阶段 `unphased` 无 name（UI 本地化）；空名同样按「无名」处理而不是让整个输出
    // 解析失败，与车道 name 同一姿态。
    const name = phase.name ? boundGraphText(phase.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : undefined;
    // `alongside`：进入这个阶段时还在跑的其他阶段（strand 未 join）。与边同一条引用完整性
    // 规则——指向未列出阶段的引用丢掉，自引用丢掉（自己不与自己并行），去重保序，上界同
    // 阶段表。它**不**经过 foldEdges / reduceOrdering：这是节点事实不是边，控制没有从那里
    // 转移过来，归约会把它当成一条 runs after 去砍掉真正的边。随词汇表同进同退是自动的
    // ——boundPhases 整张表只在 emitPhases 为真时进载荷。
    const alongside: string[] = [];
    const alongsideSeen = new Set<string>();
    for (const id of phase.alongside ?? []) {
      if (id === phase.id || !phaseIds.has(id) || alongsideSeen.has(id)) continue;
      if (alongside.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
      alongsideSeen.add(id);
      alongside.push(boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));
    }
    return {
      id: boundGraphText(phase.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      ...(name === undefined ? {} : { name }),
      ...(phase.loc === undefined ? {} : { line: phase.loc.line, column: phase.loc.column }),
      ...(alongside.length === 0 ? {} : { alongside }),
      // 补全写进来的阶段带补全它的留白 id；控制流图的阶段表没标时退回因果图同 id 阶段的标记。
      ...fillMark(
        phase,
        graph.phases?.find((candidate) => candidate.id === phase.id),
      ),
    };
  });
  const exits = (declaredPhases ?? [])
    .filter((phase) => exitSet.has(phase.id))
    .map((phase) => boundGraphText(phase.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));

  const boundLanes: CreateWorkflowLane[] = keptLanes.map((lane) => {
    // 空 name（如 agent("")）会违反契约的 min(1)，按“无名”处理而不是让整个输出解析失败。
    const name = lane.name ? boundGraphText(lane.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : undefined;
    const namePattern = boundNamePattern(lane.namePattern);
    return {
      id: boundGraphText(lane.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      ...(name === undefined ? {} : { name }),
      ...(namePattern === undefined ? {} : { namePattern }),
      ...(lane.loc === undefined ? {} : { line: lane.loc.line, column: lane.loc.column }),
    };
  });

  const boundSteps: CreateWorkflowStep[] = steps.map((step) => {
    const lanes = (step.lanes ?? []).filter((lane) => laneIds.has(lane));
    // ask 的 label 来自脚本字面量，可能为空；契约要求 min(1)，退回 step id。
    const label = step.label ? boundGraphText(step.label, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : step.id;
    const labelPattern = boundNamePattern(step.labelPattern);
    return {
      id: boundGraphText(step.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      kind: step.kind,
      label,
      ...(labelPattern === undefined ? {} : { labelPattern }),
      line: step.loc.line,
      column: step.loc.column,
      lane: boundGraphText(step.lane, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      ...(lanes.length > 1 ? { lanes } : {}),
      // may-set 拷贝的关联键：这里指向的站点已被拷贝替换，所以它**不**参与上面的引用完整性
      // 收敛（那条规则管的是边与 sink 指向的节点）。字段可选，漏掉不会被 schema 抓住，只会
      // 让实时叠加悄悄关联不上实例。
      ...(step.source === undefined
        ? {}
        : { source: boundGraphText(step.source, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) }),
      // 词汇表整体降级时 `phase` 必须一起消失，指向未列出阶段的 `phase` 同样消失：带着一个
      // 不在 `phases` 里的阶段 id 的卡片是悬空引用，UI 会去查一个不存在的阶段。分析器保证
      // 「每个 issue 的阶段都是某个 node 的阶段」，所以正常输入下这一收紧零行为变化；裁剪层
      // 的姿态照旧是自卫而非信任生产者。
      ...(emitPhases && step.phase !== undefined && phaseIds.has(step.phase)
        ? { phase: boundGraphText(step.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) }
        : {}),
      ...(step.repeat === undefined ? {} : { repeat: step.repeat }),
      // 补全写进来的站点带补全它的留白 id（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
      // 只搬、不校验它指向的留白：那个留白已经补过，不在 `holes` 里，也不是任何节点。
      ...fillMark(step),
    };
  });

  // 卡的阶段与 step 的 `phase` 同一条规则：词汇表降级、或指向未列出的阶段 → 归入 `unphased`
  // （契约：`participant.phase` ∈ `phases[].id`，或 `phases` 缺席时全部为 `unphased`）。卡 id
  // 不改——它是不透明键，交接边与运行状态都按它关联；UI 的隐式模块只看 `phase` 字段。
  const boundParticipants: CreateWorkflowParticipant[] = participants.map((participant) =>
    emitPhases && phaseIds.has(participant.phase)
      ? participant
      : { ...participant, phase: UNPHASED },
  );

  // 5. Open holes (docs/dynamic-workflow/presentation.md「The display contract」): source order,
  //    capped like the phase table. A hole's `phase` follows the step rule — dropped when the
  //    vocabulary went or the phase is unlisted — so the payload never references a phase it
  //    does not carry.
  const openHoles: readonly FlowHole[] = flow?.holes ?? [];
  truncated = truncated || openHoles.length > CREATE_WORKFLOW_GRAPH_MAX_HOLES;
  const holes: CreateWorkflowHole[] = openHoles
    .slice(0, CREATE_WORKFLOW_GRAPH_MAX_HOLES)
    .map((hole) => ({
      siteId: boundGraphText(hole.siteId, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      name: hole.name
        ? boundGraphText(hole.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS)
        : hole.siteId,
      type: hole.type ? boundGraphText(hole.type, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "unknown",
      ...(emitPhases && hole.phase !== undefined && phaseIds.has(hole.phase)
        ? { phase: boundGraphText(hole.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) }
        : {}),
      ...(hole.tail === true ? { tail: true as const } : {}),
    }));

  return {
    steps: boundSteps,
    lanes: boundLanes,
    participants: boundParticipants,
    handoffs,
    ...(emitPhases ? { phases: boundPhases, phaseEdges, exits } : {}),
    ...(emitPhases && phaseStreams.length > 0 ? { phaseStreams } : {}),
    ...(sink.length > 0 ? { sink } : {}),
    ...(holes.length > 0 ? { holes } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * 6. 阶段流（docs/dynamic-workflow/presentation.md「Streams」）：channel 串起来的两个 future 阶段在
 *    控制流视图里只是互为 `alongside` 的两条 strand，没有箭头；因果图的阶段商却有 producer →
 *    consumer 的 `data` 边（send 是容器写、for await 把它读回来）。流 = 两端互为 alongside 的
 *    那些 `data` 边：两条都活着的 strand 之间只能经由共享容器传数据，那就是 channel。进入一个
 *    **不** alongside 的阶段的 `data` 边（join 之后的写作者）是控制箭头的事，不是流。
 *    因果商已由分析器归约过，这里只做引用完整性（未列出的阶段、自环）、alongside 过滤与去重，
 *    不再归约；它也**不**并进 phaseEdges——箭头仍然只说 runs after。上界由调用方与边一起判。
 */
function boundPhaseStreams(
  graph: CausalityGraph,
  declaredPhases: ControlFlowGraph["phases"] | undefined,
  phaseIds: ReadonlySet<string>,
): CreateWorkflowStream[] {
  const alongside = new Set<string>();
  for (const phase of declaredPhases ?? []) {
    for (const id of phase.alongside ?? []) {
      alongside.add(`${phase.id}>${id}`);
      alongside.add(`${id}>${phase.id}`);
    }
  }
  const streams: CreateWorkflowStream[] = [];
  const seen = new Set<string>();
  for (const edge of graph.phaseEdges ?? []) {
    if (edge.kind !== "data" || edge.from === edge.to) continue;
    if (!phaseIds.has(edge.from) || !phaseIds.has(edge.to)) continue;
    const key = `${edge.from}>${edge.to}`;
    if (!alongside.has(key) || seen.has(key)) continue;
    seen.add(key);
    streams.push({
      from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    });
  }
  return streams;
}

/**
 * 补全标记（`fill: <留白 id>`，分析器标在因果图的 Step / Phase 与控制流图的 FlowPhase 上）：第一个
 * 候选带着就搬，第二个候选（因果图的同 id 阶段）在第一个没标时兜底。id 是分析生成的 ASCII，限长
 * 恒等通过。
 */
function fillMark(...nodes: ({ fill?: string } | undefined)[]): { fill?: string } {
  for (const node of nodes) {
    const fill = node?.fill;
    if (fill !== undefined && fill.length > 0) {
      return { fill: boundGraphText(fill, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) };
    }
  }
  return {};
}

// Bug 预防：actor 名 / ask label 来自脚本字符串字面量（外部输入），直接 slice 可能截断
// UTF-16 surrogate pair；与 result-display 的 MCP 文本限长同一处理——边界落在高位
// surrogate 后则丢弃半字符，保证载荷可安全序列化。id 是分析生成的 ASCII，slice 恒等通过。
function boundGraphText(value: string, maxChars: number): string {
  const bounded = value.slice(0, maxChars);
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

/**
 * name pattern 的限长：两个 affix 同样来自脚本字面量，走同一条 surrogate-safe 截断。
 *
 * 截断后可能一个 affix 都不剩（理论上分析器已保证非空，但契约的 min(1) 不该依赖上游的
 * 保证）——那时整个字段缺席，而不是发一个 `{}` 让 `.strict()` 通过却渲染出一个孤零零的
 * 省略号。
 */
function boundNamePattern(
  pattern: { head?: string; tail?: string } | undefined,
): CreateWorkflowNamePattern | undefined {
  if (pattern === undefined) return undefined;
  const head = pattern.head ? boundGraphText(pattern.head, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "";
  const tail = pattern.tail ? boundGraphText(pattern.tail, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "";
  if (head === "" && tail === "") return undefined;
  return {
    ...(head === "" ? {} : { head }),
    ...(tail === "" ? {} : { tail }),
  };
}
