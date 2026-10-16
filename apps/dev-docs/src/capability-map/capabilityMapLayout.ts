import ELK, {
  type ELK as ElkApi,
  type ElkEdgeSection,
  type ElkExtendedEdge,
  type ElkNode,
  type ElkPoint,
} from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import { orderGroupsByRelations } from "@/capability-map/capabilityMapGroupOrder.js";
import {
  capabilityEdges,
  capabilityGroups,
  capabilityNodes,
  capabilitySystems,
} from "@/data/productCapabilityMap.js";
import {
  CAPABILITY_GROUP_CONTENT_TOP,
  CAPABILITY_NODE_HEIGHT,
  CAPABILITY_NODE_WIDTH,
  CAPABILITY_SYSTEM_CONTENT_TOP,
} from "@/capability-map/capabilityMapGeometry.js";
import { buildCapabilitySystemPositions } from "@/capability-map/capabilityMapSystemPlacement.js";

export interface CapabilitySystemLayout {
  id: string;
  position: ElkPoint;
  width: number;
  height: number;
}

export interface CapabilityGroupLayout {
  id: string;
  systemId: string;
  position: ElkPoint;
  width: number;
  height: number;
}

export interface CapabilityNodeLayout {
  id: string;
  groupId: string;
  position: ElkPoint;
}

export interface CapabilityEdgeRoute {
  id: string;
  points: ElkPoint[];
  labelPosition: ElkPoint;
}

export interface CapabilityMapLayout {
  systems: CapabilitySystemLayout[];
  groups: CapabilityGroupLayout[];
  nodes: CapabilityNodeLayout[];
  edgeRoutes: Map<string, CapabilityEdgeRoute>;
}

const capabilityGroupById = new Map(
  capabilityGroups.map((group) => [group.id, group]),
);

interface InternalGroupLayout {
  id: string;
  width: number;
  height: number;
  nodes: CapabilityNodeLayout[];
  edgeRoutes: CapabilityEdgeRoute[];
}

interface InternalSystemLayout {
  id: string;
  width: number;
  height: number;
  groups: CapabilityGroupLayout[];
}

function getRequiredNumber(value: number | undefined, description: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`ELK 未返回有效的 ${description}`);
  }
  return value;
}

function getRequiredPosition(
  positions: Map<string, ElkPoint>,
  id: string,
  description: string,
) {
  const position = positions.get(id);
  if (!position) {
    throw new Error(`缺少${description} ${id}`);
  }
  return position;
}

function groupNodeId(groupId: string) {
  return `group:${groupId}`;
}

function systemNodeId(systemId: string) {
  return `system:${systemId}`;
}

function buildGroupGraph(groupId: string): ElkNode {
  const groupNodeIds = new Set(
    capabilityNodes
      .filter((node) => node.groupId === groupId)
      .map((node) => node.id),
  );
  return {
    id: groupNodeId(groupId),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      "elk.layered.greedySwitch.activationThreshold": "4",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "8",
      "elk.layered.spacing.edgeNodeBetweenLayers": "16",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.padding": `[top=${CAPABILITY_GROUP_CONTENT_TOP},left=12,bottom=12,right=12]`,
      "elk.randomSeed": "1",
      "elk.spacing.edgeEdge": "8",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.nodeNode": "8",
    },
    children: capabilityNodes
      .filter((node) => node.groupId === groupId)
      .map((node) => ({
        id: node.id,
        width: CAPABILITY_NODE_WIDTH,
        height: CAPABILITY_NODE_HEIGHT,
      })),
    edges: capabilityEdges
      .filter(
        (edge) =>
          groupNodeIds.has(edge.source) && groupNodeIds.has(edge.target),
      )
      .map(
        (edge): ElkExtendedEdge => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
        }),
      ),
  };
}

function buildSystemGraph(
  systemId: string,
  groupLayoutsById: Map<string, InternalGroupLayout>,
): ElkNode {
  return {
    id: systemNodeId(systemId),
    layoutOptions: {
      "elk.algorithm": "rectpacking",
      "elk.aspectRatio": "1.5",
      "elk.padding": `[top=${CAPABILITY_SYSTEM_CONTENT_TOP},left=16,bottom=16,right=16]`,
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": "24",
    },
    children: orderGroupsByRelations(systemId).map((groupId) => {
      const groupLayout = groupLayoutsById.get(groupId);
      if (!groupLayout) {
        throw new Error(`缺少能力群布局 ${groupId}`);
      }
      return {
        id: groupNodeId(groupId),
        width: groupLayout.width,
        height: groupLayout.height,
      };
    }),
  };
}

function getRoutePoints(section: ElkEdgeSection) {
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

function getRouteLabelPosition(points: ElkPoint[]) {
  let longestLength = 0;
  let labelPosition = points[0] ?? { x: 0, y: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestLength) {
      longestLength = length;
      labelPosition = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };
    }
  }
  return labelPosition;
}

function offsetPoint(point: ElkPoint, offset: ElkPoint) {
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
  };
}

function getEdgeRoutes(edges: ElkExtendedEdge[] | undefined) {
  const routes: CapabilityEdgeRoute[] = [];
  for (const edge of edges ?? []) {
    const section = edge.sections?.[0];
    if (!section) {
      continue;
    }
    const points = getRoutePoints(section);
    routes.push({
      id: edge.id,
      points,
      labelPosition: getRouteLabelPosition(points),
    });
  }
  return routes;
}

async function calculateGroupLayout(elk: ElkApi, groupId: string) {
  const graph = await elk.layout(buildGroupGraph(groupId));
  return {
    id: groupId,
    width: getRequiredNumber(graph.width, `${graph.id}.width`),
    height: getRequiredNumber(graph.height, `${graph.id}.height`),
    nodes: (graph.children ?? []).map((node) => ({
      id: node.id,
      groupId,
      position: {
        x: getRequiredNumber(node.x, `${node.id}.x`),
        y: getRequiredNumber(node.y, `${node.id}.y`),
      },
    })),
    edgeRoutes: getEdgeRoutes(graph.edges),
  } satisfies InternalGroupLayout;
}

async function calculateSystemLayout(
  elk: ElkApi,
  systemId: string,
  groupLayoutsById: Map<string, InternalGroupLayout>,
) {
  const graph = await elk.layout(
    buildSystemGraph(systemId, groupLayoutsById),
  );
  return {
    id: systemId,
    width: getRequiredNumber(graph.width, `${graph.id}.width`),
    height: getRequiredNumber(graph.height, `${graph.id}.height`),
    groups: (graph.children ?? []).map((group) => ({
      id: group.id.replace(/^group:/u, ""),
      systemId,
      position: {
        x: getRequiredNumber(group.x, `${group.id}.x`),
        y: getRequiredNumber(group.y, `${group.id}.y`),
      },
      width: getRequiredNumber(group.width, `${group.id}.width`),
      height: getRequiredNumber(group.height, `${group.id}.height`),
    })),
  } satisfies InternalSystemLayout;
}

function offsetRoute(route: CapabilityEdgeRoute, offset: ElkPoint) {
  const points = route.points.map((point) => offsetPoint(point, offset));
  return {
    id: route.id,
    points,
    labelPosition: getRouteLabelPosition(points),
  };
}

async function calculateCapabilityMapLayout(): Promise<CapabilityMapLayout> {
  const elk = new ELK({
    workerFactory: () => new ElkWorker(),
  });
  try {
    const groupLayouts: InternalGroupLayout[] = [];
    for (const group of capabilityGroups) {
      groupLayouts.push(await calculateGroupLayout(elk, group.id));
    }
    const groupLayoutsById = new Map(
      groupLayouts.map((groupLayout) => [groupLayout.id, groupLayout]),
    );

    const systemLayouts: InternalSystemLayout[] = [];
    for (const system of capabilitySystems) {
      systemLayouts.push(
        await calculateSystemLayout(elk, system.id, groupLayoutsById),
      );
    }
    const systemPositions = buildCapabilitySystemPositions(systemLayouts);
    const groups = systemLayouts.flatMap((systemLayout) => systemLayout.groups);
    const groupLayoutPositions = new Map(
      groups.map((group) => [group.id, group.position]),
    );
    const nodes = groupLayouts.flatMap((groupLayout) => groupLayout.nodes);
    const edgeRoutes = new Map<string, CapabilityEdgeRoute>();
    for (const groupLayout of groupLayouts) {
      const group = capabilityGroupById.get(groupLayout.id);
      const systemPosition = group
        ? systemPositions.get(group.systemId)
        : undefined;
      const groupPosition = groupLayoutPositions.get(groupLayout.id);
      if (!systemPosition || !groupPosition) {
        throw new Error(`缺少能力群全局位置 ${groupLayout.id}`);
      }
      const offset = {
        x: systemPosition.x + groupPosition.x,
        y: systemPosition.y + groupPosition.y,
      };
      for (const route of groupLayout.edgeRoutes) {
        const globalRoute = offsetRoute(route, offset);
        edgeRoutes.set(globalRoute.id, globalRoute);
      }
    }

    return {
      systems: systemLayouts.map((systemLayout) => ({
        id: systemLayout.id,
        position: getRequiredPosition(
          systemPositions,
          systemLayout.id,
          "顶层区域全局位置",
        ),
        width: systemLayout.width,
        height: systemLayout.height,
      })),
      groups,
      nodes,
      edgeRoutes,
    };
  } finally {
    elk.terminateWorker();
  }
}

export const capabilityMapLayoutPromise = calculateCapabilityMapLayout();
