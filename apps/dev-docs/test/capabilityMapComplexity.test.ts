import { describe, expect, it } from "vitest";
import { capabilityEdges } from "@/data/productCapabilityMap.js";
import {
  getCapabilityGroupComplexity,
  groupComplexityById,
  nodeById,
} from "@/capability-map/capabilityMapTypes.js";

describe("能力群复杂度", () => {
  it("只把跨群有向边计入入度和出度", () => {
    const crossGroupEdgeCount = capabilityEdges.filter(
      (edge) =>
        nodeById.get(edge.source)?.groupId !==
        nodeById.get(edge.target)?.groupId,
    ).length;
    const totalInDegree = [...groupComplexityById.values()].reduce(
      (sum, complexity) => sum + complexity.inDegree,
      0,
    );
    const totalOutDegree = [...groupComplexityById.values()].reduce(
      (sum, complexity) => sum + complexity.outDegree,
      0,
    );

    expect(totalInDegree).toBe(crossGroupEdgeCount);
    expect(totalOutDegree).toBe(crossGroupEdgeCount);
  });

  it("智能体核心统计与当前权威关系图一致", () => {
    expect(getCapabilityGroupComplexity("agent-core")).toEqual({
      inDegree: 12,
      outDegree: 7,
    });
  });
});
