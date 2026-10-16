import { Background, Controls, ReactFlow } from "@xyflow/react";
import {
  capabilityMapEdgeTypes,
  capabilityMapNodeTypes,
} from "@/capability-map/CapabilityMapFlowElements.js";
import type {
  CapabilityFlowEdge,
  CapabilityFlowNode,
} from "@/capability-map/capabilityMapTypes.js";

export function CapabilityMapGraph({
  edges,
  layoutReady,
  nodes,
  onPaneClick,
  onSelectGroup,
  onSelectNode,
}: {
  edges: CapabilityFlowEdge[];
  layoutReady: boolean;
  nodes: CapabilityFlowNode[];
  onPaneClick: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="capability-map-canvas min-w-0 overflow-hidden rounded-lg border border-card-border bg-card">
      {layoutReady ? (
        <ReactFlow<CapabilityFlowNode, CapabilityFlowEdge>
          defaultEdgeOptions={{ type: "capability-edge" }}
          edges={edges}
          edgeTypes={capabilityMapEdgeTypes}
          fitView
          fitViewOptions={{ maxZoom: 0.8, padding: 0.08 }}
          maxZoom={2.4}
          minZoom={0.08}
          nodeTypes={capabilityMapNodeTypes}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          onlyRenderVisibleElements
          onNodeClick={(_event, node) => {
            if (node.type === "capability-group") {
              onSelectGroup(node.data.group.id);
            } else if (node.type === "capability-item") {
              onSelectNode(node.data.capability.id);
            }
          }}
          onPaneClick={onPaneClick}
          // 交互约定：滚轮缩放，平移只通过拖拽；panOnScroll 会吞掉滚轮缩放。
          panOnDrag
          panOnScroll={false}
          proOptions={{ hideAttribution: true }}
          zoomOnScroll
        >
          <Background color="var(--color-border)" gap={24} size={1} />
          <Controls
            fitViewOptions={{ maxZoom: 0.8, padding: 0.08 }}
            position="top-right"
            showInteractive={false}
          />
        </ReactFlow>
      ) : (
        <div className="grid h-full place-items-center text-ui-base text-foreground-subtle">
          正在计算 ELK 复合群组布局…
        </div>
      )}
    </div>
  );
}
