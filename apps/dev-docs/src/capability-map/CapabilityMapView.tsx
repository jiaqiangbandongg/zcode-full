import "@xyflow/react/dist/style.css";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { MarkerType, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  capabilityEdges,
  capabilityNodes,
  type CapabilityRelationType,
} from "@/data/productCapabilityMap.js";
import {
  CAPABILITY_NODE_HEIGHT,
  CAPABILITY_NODE_WIDTH,
} from "@/capability-map/capabilityMapGeometry.js";
import { CapabilityMapDetail } from "@/capability-map/CapabilityMapDetail.js";
import { CapabilityMapGraph } from "@/capability-map/CapabilityMapGraph.js";
import { CapabilityMapToolbar } from "@/capability-map/CapabilityMapToolbar.js";
import { useCapabilityMapHighlight } from "@/capability-map/useCapabilityMapHighlight.js";
import { useCapabilityMapLayout } from "@/capability-map/useCapabilityMapLayout.js";
import {
  groupById,
  groupFlowNodeId,
  nodeById,
  relationColors,
  relationTypes,
  type CapabilityFlowEdge,
  type CapabilityFlowNode,
  type CapabilityGroupFlowNode,
  type CapabilityItemFlowNode,
  type CapabilitySelection,
  type CapabilitySystemFlowNode,
  type EdgeScope,
  systemById,
  systemFlowNodeId,
} from "@/capability-map/capabilityMapTypes.js";

function CapabilityMapCanvas() {
  const { fitView } = useReactFlow<CapabilityFlowNode, CapabilityFlowEdge>();
  const { error, layout } = useCapabilityMapLayout();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [edgeScope, setEdgeScope] = useState<EdgeScope>("all");
  const [selection, setSelection] = useState<CapabilitySelection>(null);
  const [enabledRelations, setEnabledRelations] = useState(
    () => new Set<CapabilityRelationType>(relationTypes),
  );
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();

  const visibleEdges = useMemo(
    () =>
      capabilityEdges.filter((edge) => {
        if (!enabledRelations.has(edge.type)) {
          return false;
        }
        return (
          edgeScope === "all" ||
          nodeById.get(edge.source)?.groupId !==
            nodeById.get(edge.target)?.groupId
        );
      }),
    [edgeScope, enabledRelations],
  );

  const { connectedNodeIds, highlightedEdgeIds } = useCapabilityMapHighlight(
    selection,
    visibleEdges,
  );

  const matchingNodeIds = useMemo(() => {
    if (!normalizedQuery) {
      return new Set<string>();
    }
    return new Set(
      capabilityNodes
        .filter((node) => {
          const group = groupById.get(node.groupId);
          const system = group ? systemById.get(group.systemId) : undefined;
          return [
            node.label,
            node.scope,
            node.authority,
            group?.name ?? "",
            group?.owner ?? "",
            system?.name ?? "",
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        })
        .map((node) => node.id),
    );
  }, [normalizedQuery]);

  const flowNodes = useMemo<CapabilityFlowNode[]>(() => {
    if (!layout) {
      return [];
    }
    const systems: CapabilitySystemFlowNode[] = layout.systems.map(
      (systemLayout) => {
        const system = systemById.get(systemLayout.id);
        if (!system) {
          throw new Error(`未知顶层区域 ${systemLayout.id}`);
        }
        const systemNodeIds = capabilityNodes
          .filter((node) => groupById.get(node.groupId)?.systemId === system.id)
          .map((node) => node.id);
        const active =
          !selection ||
          systemNodeIds.some((nodeId) => connectedNodeIds.has(nodeId));
        const hasSearchMatch =
          !normalizedQuery ||
          systemNodeIds.some((nodeId) => matchingNodeIds.has(nodeId));
        return {
          id: systemFlowNodeId(system.id),
          type: "capability-system",
          position: systemLayout.position,
          style: {
            height: systemLayout.height,
            width: systemLayout.width,
            zIndex: -1,
          },
          data: {
            system,
            dimmed: !active || !hasSearchMatch,
          },
          draggable: false,
          selectable: false,
        };
      },
    );
    const groups: CapabilityGroupFlowNode[] = layout.groups.map(
      (groupLayout) => {
        const group = groupById.get(groupLayout.id);
        if (!group) {
          throw new Error(`未知能力群 ${groupLayout.id}`);
        }
        const groupNodeIds = capabilityNodes
          .filter((node) => node.groupId === group.id)
          .map((node) => node.id);
        const active =
          !selection ||
          groupNodeIds.some((nodeId) => connectedNodeIds.has(nodeId));
        const hasSearchMatch =
          !normalizedQuery ||
          groupNodeIds.some((nodeId) => matchingNodeIds.has(nodeId));
        return {
          id: groupFlowNodeId(group.id),
          type: "capability-group",
          parentId: systemFlowNodeId(group.systemId),
          extent: "parent",
          position: groupLayout.position,
          style: {
            height: groupLayout.height,
            width: groupLayout.width,
            zIndex: 1,
          },
          data: {
            group,
            selected: selection?.kind === "group" && selection.id === group.id,
            dimmed: !active || !hasSearchMatch,
          },
          draggable: false,
          selectable: true,
        };
      },
    );
    const items: CapabilityItemFlowNode[] = layout.nodes.map((nodeLayout) => {
      const capability = nodeById.get(nodeLayout.id);
      if (!capability) {
        throw new Error(`未知能力节点 ${nodeLayout.id}`);
      }
      const searchMatch = normalizedQuery
        ? matchingNodeIds.has(capability.id)
        : false;
      return {
        id: capability.id,
        type: "capability-item",
        parentId: groupFlowNodeId(nodeLayout.groupId),
        extent: "parent",
        position: nodeLayout.position,
        style: {
          height: CAPABILITY_NODE_HEIGHT,
          width: CAPABILITY_NODE_WIDTH,
          zIndex: 3,
        },
        data: {
          capability,
          selected:
            selection?.kind === "node" && selection.id === capability.id,
          searchMatch,
          dimmed:
            (Boolean(selection) && !connectedNodeIds.has(capability.id)) ||
            (Boolean(normalizedQuery) && !searchMatch),
        },
        draggable: false,
        selectable: true,
      };
    });
    return [...systems, ...groups, ...items];
  }, [connectedNodeIds, layout, matchingNodeIds, normalizedQuery, selection]);

  const visibleEdgeIdSet = useMemo(
    () => new Set(visibleEdges.map((edge) => edge.id)),
    [visibleEdges],
  );

  const flowEdges = useMemo<CapabilityFlowEdge[]>(() => {
    if (!layout) {
      return [];
    }
    return capabilityEdges.map((edge) => {
      const highlighted = highlightedEdgeIds.has(edge.id);
      const sourceGroup = nodeById.get(edge.source)?.groupId;
      const targetGroup = nodeById.get(edge.target)?.groupId;
      return {
        id: edge.id,
        type: "capability-edge",
        source: edge.source,
        sourceHandle: "source",
        target: edge.target,
        targetHandle: "target",
        hidden: !visibleEdgeIdSet.has(edge.id),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: relationColors[edge.type],
          height: highlighted ? 17 : 13,
          width: highlighted ? 17 : 13,
        },
        zIndex: highlighted ? 4 : sourceGroup === targetGroup ? 3 : 1,
        data: {
          capability: edge,
          route: layout.edgeRoutes.get(edge.id),
          highlighted,
          dimmed: Boolean(selection) && !highlighted,
          showLabel: selection?.kind === "node" && highlighted,
        },
        selectable: false,
      };
    });
  }, [highlightedEdgeIds, layout, selection, visibleEdgeIdSet]);

  const selectNode = useCallback((nodeId: string) => {
    if (nodeById.has(nodeId)) {
      setSelection({ kind: "node", id: nodeId });
    }
  }, []);

  const selectGroup = useCallback((groupId: string) => {
    if (groupById.has(groupId)) {
      setSelection({ kind: "group", id: groupId });
    }
  }, []);

  const clearHighlight = useCallback(() => {
    // 修复原因：画布空白点击只表示取消当前高亮；复用完整重置会调用 fitView，
    // 抹掉用户刚调整好的缩放与平移视角。
    setSelection(null);
  }, []);

  const reset = useCallback(() => {
    setQuery("");
    setSelection(null);
    setEdgeScope("all");
    setEnabledRelations(new Set(relationTypes));
    window.requestAnimationFrame(() => {
      void fitView({ duration: 220, maxZoom: 0.8, padding: 0.08 });
    });
  }, [fitView]);

  const toggleRelation = useCallback((type: CapabilityRelationType) => {
    setEnabledRelations((current) => {
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  if (error) {
    return (
      <main className="p-4">
        <div className="rounded-lg border border-warning/35 bg-card p-4 text-ui-base text-foreground">
          能力图布局失败：{error}
        </div>
      </main>
    );
  }

  return (
    <main className="grid gap-4 px-4 py-4">
      <CapabilityMapToolbar
        edgeScope={edgeScope}
        enabledRelations={enabledRelations}
        onEdgeScopeChange={setEdgeScope}
        onQueryChange={setQuery}
        onReset={reset}
        onToggleRelation={toggleRelation}
        query={query}
      />
      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <CapabilityMapGraph
          edges={flowEdges}
          layoutReady={Boolean(layout)}
          nodes={flowNodes}
          onPaneClick={clearHighlight}
          onSelectGroup={selectGroup}
          onSelectNode={selectNode}
        />
        <CapabilityMapDetail
          edgeScope={edgeScope}
          enabledRelations={enabledRelations}
          onSelectGroup={selectGroup}
          onSelectNode={selectNode}
          selection={selection}
        />
      </section>
    </main>
  );
}

export default function CapabilityMapView() {
  return (
    <ReactFlowProvider>
      <CapabilityMapCanvas />
    </ReactFlowProvider>
  );
}
