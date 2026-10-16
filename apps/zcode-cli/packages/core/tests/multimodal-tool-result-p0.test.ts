import { describe, expect, it } from "vitest";

import {
  CASE_NAMES,
  buildCase,
  hasOrderedMarkers,
  parseSelectedCases,
} from "../../../../../scripts/multimodal-tool-result-p0.mjs";

describe("multimodal tool-result P0 cases", () => {
  it("keeps the case selection explicit", () => {
    expect(parseSelectedCases(undefined)).toEqual(CASE_NAMES);
    expect(parseSelectedCases("text-three-blocks,cua-observation")).toEqual([
      "text-three-blocks",
      "cua-observation",
    ]);
    expect(() => parseSelectedCases("unknown-case")).toThrow("Unknown MM_P0_CASES");
  });

  it("checks marker presence and order without trusting the model's JSON formatting", () => {
    expect(hasOrderedMarkers("[A, B, C]", ["A", "B", "C"])).toBe(true);
    expect(hasOrderedMarkers("[A, C, B]", ["A", "B", "C"])).toBe(false);
    expect(hasOrderedMarkers("[A, B]", ["A", "B", "C"])).toBe(false);
  });

  it("constructs the production-shaped P0 block sequences", async () => {
    // 标记图改为纯 Node 生成（scripts/multimodal-marker-png.mjs）后不再需要预加载 sharp。
    const expectedBlockTypes: Record<string, string[]> = {
      "text-three-blocks": ["text", "text", "text"],
      "mcp-text-image-text": ["text", "image", "text"],
      "android-screenshot-shape": ["text", "image"],
      "ios-screenshot-shape": ["text", "image"],
      "browser-multiple-images": ["image", "image", "text"],
      "cua-observation": ["image", "text", "text", "text"],
    };

    for (const caseName of Object.keys(expectedBlockTypes)) {
      const probe = await buildCase(caseName, "abc123");
      const toolResult = probe.messages
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .find((part) => part.type === "tool_result");
      expect(
        toolResult?.content?.map((block) => block.type),
        caseName,
      ).toEqual(expectedBlockTypes[caseName]);

      const instruction = probe.messages
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .find((part) => part.type === "text" && part.text.includes("actually visible"));
      expect(instruction?.text).not.toContain("abc123");
    }

    const multiToolProbe = await buildCase("multiple-tool-results", "abc123");
    const multiToolResults = multiToolProbe.messages
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .filter((part) => part.type === "tool_result");
    expect(multiToolResults).toHaveLength(2);
    expect(multiToolResults.map((part) => part.content.map((block) => block.type))).toEqual([
      ["text", "text"],
      ["text", "text"],
    ]);
  });
});
