import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import graph from "virtual:zcode-feature-boundary-graph";

export const FEATURE_BOUNDARY_NODE_WIDTH = 236;
export const FEATURE_BOUNDARY_NODE_HEIGHT = 72;

export interface FeatureBoundaryNodeLayout {
  id: string;
  position: ElkPoint;
}

export interface FeatureBoundaryGraphLayout {
  width: number;
  height: number;
  nodes: FeatureBoundaryNodeLayout[];
}

function requiredNumber(value: number | undefined, description: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`ELK 未返回有效的 ${description}`);
  }
  return value;
}

function buildLayoutGraph(): ElkNode {
  return {
    id: "feature-boundary-graph",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "24",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.randomSeed": "1",
      "elk.spacing.edgeEdge": "10",
      "elk.spacing.edgeNode": "18",
      "elk.spacing.nodeNode": "18",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: FEATURE_BOUNDARY_NODE_WIDTH,
      height: FEATURE_BOUNDARY_NODE_HEIGHT,
    })),
    edges: graph.edges.map(
      (edge, index): ElkExtendedEdge => ({
        id: edge.id ?? `edge-${index}`,
        sources: [edge.from],
        targets: [edge.to],
      }),
    ),
  };
}

async function calculateFeatureBoundaryGraphLayout(): Promise<FeatureBoundaryGraphLayout> {
  const elk = new ELK({
    workerFactory: () => new ElkWorker(),
  });
  try {
    const result = await elk.layout(buildLayoutGraph());
    return {
      width: requiredNumber(result.width, "feature boundary graph width"),
      height: requiredNumber(result.height, "feature boundary graph height"),
      nodes: (result.children ?? []).map((node) => ({
        id: node.id,
        position: {
          x: requiredNumber(node.x, `${node.id}.x`),
          y: requiredNumber(node.y, `${node.id}.y`),
        },
      })),
    };
  } finally {
    elk.terminateWorker();
  }
}

export const featureBoundaryGraphLayoutPromise = calculateFeatureBoundaryGraphLayout();
