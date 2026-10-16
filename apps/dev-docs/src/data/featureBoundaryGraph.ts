export const featureBoundaryNodeKinds = [
  "capability",
  "ui-surface",
  "service",
  "state-owner",
  "persistence",
  "delivery-boundary",
  "shared-ui",
  "evidence",
  "boundary",
  "unresolved",
] as const;

export type FeatureBoundaryNodeKind = (typeof featureBoundaryNodeKinds)[number];

export type FeatureBoundaryRelationRank =
  | "must-inspect"
  | "should-inspect"
  | "conditional"
  | "invariant-only"
  | "evidence-only";

export interface FeatureBoundaryNode {
  id: string;
  kind: FeatureBoundaryNodeKind;
  label: string;
  aliases: string[];
  docs: string[];
  codeSeeds: string[];
  invariants: string[];
}

export interface FeatureBoundaryEdge {
  id?: string;
  from: string;
  to: string;
  type: string;
  rank?: FeatureBoundaryRelationRank;
  condition?: string;
}

export interface FeatureBoundaryGraph {
  schemaVersion: number;
  graphId: string;
  purpose: string;
  nodes: FeatureBoundaryNode[];
  edges: FeatureBoundaryEdge[];
}

export interface FeatureBoundaryGraphStats {
  nodeCount: number;
  edgeCount: number;
  unresolvedEndpointCount: number;
  kindCounts: Partial<Record<FeatureBoundaryNodeKind, number>>;
}

export interface FeatureBoundaryNeighborhoodEdge extends FeatureBoundaryEdge {
  source: string;
  target: string;
}

export interface FeatureBoundaryNeighborhood {
  nodes: FeatureBoundaryNode[];
  edges: FeatureBoundaryNeighborhoodEdge[];
}

export function getFeatureBoundaryGraphStats(
  graph: FeatureBoundaryGraph,
): FeatureBoundaryGraphStats {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const kindCounts: Partial<Record<FeatureBoundaryNodeKind, number>> = {};
  for (const node of graph.nodes) {
    kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
  }

  const unresolvedEndpointIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === "unresolved") {
      unresolvedEndpointIds.add(node.id);
    }
  }
  for (const edge of graph.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!nodeIds.has(endpoint)) {
        unresolvedEndpointIds.add(endpoint);
      }
    }
  }

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    unresolvedEndpointCount: unresolvedEndpointIds.size,
    kindCounts,
  };
}

export function getFeatureBoundaryNeighborhood(
  graph: FeatureBoundaryGraph,
  nodeId: string,
): FeatureBoundaryNeighborhood {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set<string>([nodeId]);

  for (const edge of graph.edges) {
    if (edge.from === nodeId) {
      nodeIds.add(edge.to);
    }
    if (edge.to === nodeId) {
      nodeIds.add(edge.from);
    }
  }

  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
  for (const id of nodeIds) {
    if (nodeById.has(id)) {
      continue;
    }
    nodes.push({
      id,
      kind: "unresolved",
      label: id,
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    });
  }

  const edges = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({
      ...edge,
      source: edge.from,
      target: edge.to,
    }));

  return { nodes, edges };
}

export const featureBoundaryNodeKindLabels: Record<FeatureBoundaryNodeKind, string> = {
  capability: "能力",
  "ui-surface": "UI 入口",
  service: "服务",
  "state-owner": "状态归属",
  persistence: "持久化",
  "delivery-boundary": "交付边界",
  "shared-ui": "共享 UI",
  evidence: "证据",
  boundary: "架构边界",
  unresolved: "未声明端点",
};
