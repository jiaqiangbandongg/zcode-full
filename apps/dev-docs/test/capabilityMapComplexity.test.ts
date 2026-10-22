import { describe, expect, it, vi } from "vitest";
import { groupComplexityById } from "@/capability-map/capabilityMapTypes.js";

// 原测试依赖当前能力图，并把缺失端点误计为跨群边，导致 136 != 137。
// 使用固定小图独立声明期望，不让文档节点增删或统计实现决定测试答案。
vi.mock("@/data/productCapabilityMap.js", () => ({
  capabilityGroups: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "empty" }],
  capabilityNodes: [
    { id: "a1", groupId: "a" },
    { id: "a2", groupId: "a" },
    { id: "b1", groupId: "b" },
    { id: "c1", groupId: "c" },
    { id: "orphan", groupId: "missing-group" },
  ],
  capabilityEdges: [
    { source: "a1", target: "b1" },
    { source: "b1", target: "a1" },
    { source: "b1", target: "c1" },
    { source: "a1", target: "a2" },
    { source: "missing-node", target: "b1" },
    { source: "a1", target: "missing-node" },
    { source: "orphan", target: "b1" },
  ],
  capabilitySystems: [],
  capabilityRelationNames: {},
}));

describe("能力群复杂度", () => {
  it("只把跨群有向边计入入度和出度", () => {
    expect([...groupComplexityById]).toEqual([
      ["a", { inDegree: 1, outDegree: 1 }],
      ["b", { inDegree: 1, outDegree: 2 }],
      ["c", { inDegree: 1, outDegree: 0 }],
      ["empty", { inDegree: 0, outDegree: 0 }],
    ]);
  });
});
