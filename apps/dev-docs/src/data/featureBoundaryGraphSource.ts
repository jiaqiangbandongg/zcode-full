import type { FeatureBoundaryGraph, FeatureBoundaryNode } from "@/data/featureBoundaryGraph.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function normalizeFeatureBoundaryGraph(value: unknown): FeatureBoundaryGraph {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("feature-boundary graph YAML 必须包含 nodes 和 edges 数组");
  }

  const nodes = value.nodes.flatMap((nodeValue) => {
    if (!isRecord(nodeValue) || typeof nodeValue.id !== "string") {
      return [];
    }
    const codeSeeds = Array.isArray(nodeValue.codeSeeds)
      ? nodeValue.codeSeeds.flatMap((seedValue) => {
          if (!isRecord(seedValue) || typeof seedValue.file !== "string") {
            return [];
          }
          const symbol = typeof seedValue.symbol === "string" ? `${seedValue.symbol} · ` : "";
          return [`${symbol}${seedValue.file}`];
        })
      : [];
    return [
      {
        id: nodeValue.id,
        kind: readString(nodeValue.kind, "unresolved") as FeatureBoundaryNode["kind"],
        label: readString(nodeValue.label, nodeValue.id),
        aliases: readStringArray(nodeValue.aliases),
        docs: readStringArray(nodeValue.docs),
        codeSeeds,
        invariants: readStringArray(nodeValue.invariants),
      },
    ];
  });

  const edges = value.edges.flatMap((edgeValue, index) => {
    if (
      !isRecord(edgeValue) ||
      typeof edgeValue.from !== "string" ||
      typeof edgeValue.to !== "string"
    ) {
      return [];
    }
    return [
      {
        id: `edge-${index}`,
        from: edgeValue.from,
        to: edgeValue.to,
        type: readString(edgeValue.type, "related-to"),
        ...(typeof edgeValue.rank === "string"
          ? { rank: edgeValue.rank as FeatureBoundaryGraph["edges"][number]["rank"] }
          : {}),
        ...(typeof edgeValue.condition === "string" ? { condition: edgeValue.condition } : {}),
      },
    ];
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const missingEndpointIds = new Set<string>();
  for (const edge of edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!nodeIds.has(endpoint)) {
        missingEndpointIds.add(endpoint);
      }
    }
  }
  for (const id of [...missingEndpointIds].sort()) {
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

  return {
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    graphId: readString(value.graphId, "zcode-feature-relationships"),
    purpose: readString(value.purpose),
    nodes,
    edges,
  };
}
