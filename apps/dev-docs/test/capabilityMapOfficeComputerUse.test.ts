import { describe, expect, it } from "vitest";
import { capabilityEdges, capabilityGroups, capabilityNodes } from "@/data/productCapabilityMap.js";

describe("办公套件与 Computer Use 孵化能力", () => {
  it("在 Renderer 中保留独立能力群，并只统计当前代码量", () => {
    const group = capabilityGroups.find(
      (candidate) => candidate.id === "office-computer-use-incubation",
    );
    const nodes = capabilityNodes.filter((node) => node.groupId === group?.id);

    expect(group).toMatchObject({
      systemId: "renderer",
      codeEstimate: {
        productionLines: 1_200,
      },
    });
    expect(nodes.map((node) => node.id)).toEqual([
      "office-document-preview",
      "office-spreadsheet-workbench",
      "office-presentation-workbench",
      "office-native-editing",
      "computer-use-task-ux",
      "computer-use-takeover",
    ]);
    expect(nodes.some((node) => node.scope.includes("当前："))).toBe(true);
    expect(nodes.some((node) => node.scope.includes("规划："))).toBe(true);
  });

  it("把 Renderer 体验连接到 Host 和 CLI 的当前支撑能力", () => {
    expect(capabilityNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "office-document-service",
          groupId: "workbench-services",
        }),
        expect.objectContaining({
          id: "document-skills",
          groupId: "extension-runtime",
        }),
        expect.objectContaining({
          id: "computer-use-mcp",
          groupId: "extension-runtime",
        }),
        expect.objectContaining({
          id: "cua-helper-lifecycle",
          groupId: "browser-platform",
        }),
      ]),
    );
    expect(capabilityEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "document-skills",
          target: "office-native-editing",
        }),
        expect.objectContaining({
          source: "computer-use-mcp",
          target: "computer-input-execution",
        }),
        expect.objectContaining({
          source: "mobile-remote",
          target: "cua-helper-lifecycle",
          type: "invariant",
        }),
      ]),
    );
  });

  it("把 Windows 按工具触发的顶部提示记录为当前本地 Host 投影能力", () => {
    expect(capabilityNodes.find((node) => node.id === "computer-use-task-ux")).toMatchObject({
      scope: expect.stringContaining("Windows 顶部操作提示"),
      authority: "Desktop Main native projection + Renderer tool projection",
    });
    expect(capabilityNodes.find((node) => node.id === "computer-use-task-ux")?.scope).toContain(
      "computer-use/operation-event",
    );
    expect(capabilityEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "local-host",
          target: "computer-use-task-ux",
          type: "state",
          label: expect.stringContaining("computer-use/operation-event"),
        }),
      ]),
    );
    expect(
      capabilityEdges.find(
        (edge) => edge.source === "local-host" && edge.target === "computer-use-task-ux",
      )?.label,
    ).toContain("computer-use/operation-event");
  });
});
