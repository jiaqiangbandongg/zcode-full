/**
 * 浏览器安全的纯投影桶：
 * `@zcode/dynamic-workflow/projections`。
 *
 * 下游浏览器端消费者把 `AnalysisCore` 冻结成 core.json，在浏览器里解码后现场重算站点图 / 因果图 /
 * CFG / 交接图 / actor 图，再用 `*ToMermaid` 或 display 契约画出来。那条链上不能有
 * `typescript`——它是分析器铸造 core 时才需要的编译器，几 MB 大，也不该进前端包。
 *
 * 因此这里**只**再导出运行时不 import `typescript` 的模块：core 的类型与规范文本、JSON
 * 编解码、五个投影、归约器、mermaid 与文本序列化器、图类型。`analyzeWorkflowScript`、
 * 编译器、lowering、引擎一概不在——它们走根导出。
 */
export {
  isActorSite,
  serializeCore,
  type AnalysisCore,
  type CoreActorSite,
  type CoreAskSite,
  type CoreFacts,
  type CoreFanoutSite,
  type CoreHoleSite,
  type CoreSimpleSite,
  type CoreSites,
  type CoreTypes,
} from "./analysis/core.js";
export {
  decodeAnalysisCore,
  encodeAnalysisCore,
  type AnalysisCoreJson,
  type MapEntries,
} from "./analysis/core-json.js";
export type {
  ActorEvent,
  ControlFact,
  IssueEvent,
  JumpEvent,
  MarkEvent,
  OrderEvent,
  OrderRegion,
  OrderTrace,
  PhaseInfo,
  SettleEvent,
} from "./analysis/causality-order.js";
export {
  isStructuralRegionKind,
  UNPHASED_ID,
  type JumpKind,
  type RegionKind,
  type StructuralRegionKind,
  type TraceRegionKind,
} from "./analysis/constants.js";
export { projectSiteGraph } from "./analysis/graph.js";
export { toActorGraph, type ActorEdge, type ActorGraph, type ActorNode } from "./analysis/actor-graph.js";
export {
  MAIN_LANE,
  projectCausalityGraph,
  SINK_ID,
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Lane,
  type NamePattern,
  type OrderEdge,
  type OrderKind,
  type Phase,
  type Region,
  type Step,
  type StepKind,
} from "./analysis/causality-graph.js";
export { reduceOrdering, type ReducibleEdge } from "./analysis/causality-reduce.js";
export {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  projectControlFlow,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowHole,
  type FlowNode,
  type FlowNodeKind,
  type FlowPhase,
  type FlowVia,
} from "./analysis/flow-graph.js";
export {
  FANOUT_EXPAND_CAP,
  projectHandoffGraph,
  UNPHASED,
  type Handoff,
  type HandoffGraph,
  type HandoffParticipant,
} from "./analysis/handoff-graph.js";
export {
  actorGraphToMermaid,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  siteGraphToMermaid,
} from "./analysis/mermaid.js";
export {
  serializeActorGraph,
  serializeCausalityGraph,
  serializeControlFlow,
  serializeGraph,
  serializeHandoffGraph,
} from "./analysis/serialize.js";
export type { ActorSite, SiteEdge, SiteGraph, SiteKind, SiteLoc, SiteNode } from "./analysis/types.js";
