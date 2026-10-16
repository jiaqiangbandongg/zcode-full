import type { Edge, Node } from "@xyflow/react";
import {
  capabilityEdges,
  capabilityGroups,
  capabilityNodes,
  capabilityRelationNames,
  capabilitySystems,
  type CapabilityEdge,
  type CapabilityCodeEstimateConfidence,
  type CapabilityGroup,
  type CapabilityNode,
  type CapabilityRelationType,
  type CapabilitySystem,
} from "@/data/productCapabilityMap.js";
import type { CapabilityEdgeRoute } from "@/capability-map/capabilityMapLayout.js";

export type EdgeScope = "all" | "cross";
export type CapabilitySelection =
  | { kind: "group"; id: string }
  | { kind: "node"; id: string }
  | null;

export interface CapabilitySystemNodeData extends Record<string, unknown> {
  system: CapabilitySystem;
  dimmed: boolean;
}

export interface CapabilityGroupNodeData extends Record<string, unknown> {
  group: CapabilityGroup;
  dimmed: boolean;
  selected: boolean;
}

export interface CapabilityItemNodeData extends Record<string, unknown> {
  capability: CapabilityNode;
  dimmed: boolean;
  searchMatch: boolean;
  selected: boolean;
}

export interface CapabilityEdgeData extends Record<string, unknown> {
  capability: CapabilityEdge;
  dimmed: boolean;
  highlighted: boolean;
  showLabel: boolean;
  route?: CapabilityEdgeRoute;
}

export interface CapabilityGroupComplexity {
  inDegree: number;
  outDegree: number;
}

export type CapabilityGroupFlowNode = Node<
  CapabilityGroupNodeData,
  "capability-group"
>;
export type CapabilityItemFlowNode = Node<
  CapabilityItemNodeData,
  "capability-item"
>;
export type CapabilitySystemFlowNode = Node<
  CapabilitySystemNodeData,
  "capability-system"
>;
export type CapabilityFlowNode =
  | CapabilitySystemFlowNode
  | CapabilityGroupFlowNode
  | CapabilityItemFlowNode;
export type CapabilityFlowEdge = Edge<CapabilityEdgeData, "capability-edge">;

export const nodeById = new Map(capabilityNodes.map((node) => [node.id, node]));
export const groupById = new Map(
  capabilityGroups.map((group) => [group.id, group]),
);
export const systemById = new Map(
  capabilitySystems.map((system) => [system.id, system]),
);
const mutableGroupComplexityById = new Map<string, CapabilityGroupComplexity>(
  capabilityGroups.map((group) => [
    group.id,
    {
      inDegree: 0,
      outDegree: 0,
    },
  ]),
);

for (const edge of capabilityEdges) {
  const sourceGroupId = nodeById.get(edge.source)?.groupId;
  const targetGroupId = nodeById.get(edge.target)?.groupId;
  if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) {
    continue;
  }
  const sourceComplexity = mutableGroupComplexityById.get(sourceGroupId);
  const targetComplexity = mutableGroupComplexityById.get(targetGroupId);
  if (!sourceComplexity || !targetComplexity) {
    continue;
  }
  sourceComplexity.outDegree += 1;
  targetComplexity.inDegree += 1;
}

export const groupComplexityById = new Map(
  [...mutableGroupComplexityById].map(([groupId, complexity]) => [
    groupId,
    { ...complexity },
  ]),
);

export const relationTypes = Object.keys(
  capabilityRelationNames,
) as CapabilityRelationType[];

export const relationColors: Record<CapabilityRelationType, string> = {
  delivery: "var(--color-relation-delivery)",
  invariant: "var(--color-relation-invariant)",
  runtime: "var(--color-relation-runtime)",
  shared: "var(--color-relation-shared)",
  state: "var(--color-relation-state)",
};

export const capabilityCodeEstimateConfidenceNames: Record<
  CapabilityCodeEstimateConfidence,
  string
> = {
  high: "高（High）",
  "medium-high": "中高（Medium-high）",
  medium: "中（Medium）",
  "medium-low": "中低（Medium-low）",
};

const integerFormatter = new Intl.NumberFormat("zh-CN");

export function formatCapabilityCodeEstimateCompact(productionLines: number) {
  const thousands = Math.round(productionLines / 100) / 10;
  return `≈${thousands}k LOC`;
}

export function formatCapabilityCodeEstimateFull(productionLines: number) {
  return `约 ${integerFormatter.format(productionLines)} 行`;
}

export function getCapabilityGroupComplexity(groupId: string) {
  const complexity = groupComplexityById.get(groupId);
  if (!complexity) {
    throw new Error(`能力群不存在，无法计算复杂度：${groupId}`);
  }
  return complexity;
}

export function groupFlowNodeId(groupId: string) {
  return `group:${groupId}`;
}

export function systemFlowNodeId(systemId: string) {
  return `system:${systemId}`;
}
