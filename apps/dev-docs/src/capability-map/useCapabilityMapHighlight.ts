import { useMemo } from "react";
import {
  capabilityNodes,
  type CapabilityEdge,
} from "@/data/productCapabilityMap.js";
import {
  nodeById,
  type CapabilitySelection,
} from "@/capability-map/capabilityMapTypes.js";

export function useCapabilityMapHighlight(
  selection: CapabilitySelection,
  visibleEdges: readonly CapabilityEdge[],
) {
  const highlightedEdgeIds = useMemo(() => {
    if (!selection) {
      return new Set<string>();
    }
    return new Set(
      visibleEdges
        .filter((edge) => {
          if (selection.kind === "node") {
            return edge.source === selection.id || edge.target === selection.id;
          }
          return (
            nodeById.get(edge.source)?.groupId === selection.id ||
            nodeById.get(edge.target)?.groupId === selection.id
          );
        })
        .map((edge) => edge.id),
    );
  }, [selection, visibleEdges]);

  const connectedNodeIds = useMemo(() => {
    const connected = new Set<string>();
    if (!selection) {
      return connected;
    }
    if (selection.kind === "node") {
      connected.add(selection.id);
    } else {
      for (const node of capabilityNodes) {
        if (node.groupId === selection.id) {
          connected.add(node.id);
        }
      }
    }
    for (const edge of visibleEdges) {
      if (highlightedEdgeIds.has(edge.id)) {
        connected.add(edge.source);
        connected.add(edge.target);
      }
    }
    return connected;
  }, [highlightedEdgeIds, selection, visibleEdges]);

  return {
    connectedNodeIds,
    highlightedEdgeIds,
  };
}
