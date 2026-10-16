import { describe, expect, it } from "vitest";
import { capabilityEdges, capabilityNodes } from "@/data/productCapabilityMap.js";

function node(id: string) {
  const result = capabilityNodes.find((candidate) => candidate.id === id);
  expect(result, `能力节点 ${id} 应存在`).toBeDefined();
  return result!;
}

function edge(source: string, target: string) {
  const result = capabilityEdges.find(
    (candidate) => candidate.source === source && candidate.target === target,
  );
  expect(result, `能力边 ${source} -> ${target} 应存在`).toBeDefined();
  return result!;
}

describe("能力地图当前功能事实", () => {
  it("记录 Office 只读预览与未来原生编辑的边界", () => {
    expect(node("office-document-preview").scope).toEqual(expect.stringContaining("DOCX/DOC"));
    expect(node("office-document-preview").scope).toEqual(expect.stringContaining("XLSX"));
    expect(edge("office-document-preview", "file-service")).toMatchObject({
      type: "delivery",
    });
  });

  it("记录视频媒体、Hook 摘要和 /plan 的对话入口", () => {
    expect(node("sent-media-preview").scope).toMatch(/image\/video|视频/);
    expect(node("hook-turn-summary").scope).toContain("client-visible");
    expect(node("plan-shortcut").scope).toContain("/plan");
    expect(edge("product-projection", "hook-turn-summary")).toMatchObject({
      type: "state",
    });
    expect(edge("hook-turn-summary", "desktop-continuous")).toMatchObject({
      type: "delivery",
    });
    expect(edge("hook-turn-summary", "mobile-replayable")).toMatchObject({
      type: "delivery",
    });
    expect(edge("composer", "plan-shortcut")).toMatchObject({
      type: "shared",
    });
  });

  it("记录 MCP 诊断、官方 Server MCP 与浏览器 Tab 生命周期", () => {
    expect(node("mcp-settings-diagnostics").scope).toContain("pluginId");
    expect(node("official-server-mcp").scope).toMatch(/auth|quota/);
    expect(node("browser-tab-residency").scope).toContain("32-tab");
    expect(edge("mcp-settings-diagnostics", "mcp-runtime")).toMatchObject({
      type: "state",
    });
    expect(edge("official-server-mcp", "plan-identity")).toMatchObject({
      type: "state",
    });
    expect(edge("browser-tab-residency", "embedded-browser-host")).toMatchObject({
      type: "delivery",
    });
  });

  it("把 Document Skills 的格式范围与模型有效模态写清楚", () => {
    expect(node("document-skills").scope).toContain("PPTX/XLSX");
    expect(node("model-modalities").scope).toContain("video");
    expect(node("model-modalities").scope).toContain("provider wire");
    expect(node("model-selector").scope).toMatch(/模态|vision|reasoning/i);
  });
});
