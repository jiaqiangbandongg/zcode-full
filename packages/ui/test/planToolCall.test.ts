import { describe, expect, it } from "vitest";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "../src/lib/planToolCall.js";

describe("planToolCall", () => {
  it("prefers the streaming input plan and resolves a relative plan file", () => {
    expect(
      extractPlanToolCallContent(
        {
          input: {
            plan: "# 计划\n\n- 第一步",
            planFilePath: ".zcode/plans/demo.md",
          },
          output: "fallback",
        },
        "/workspace",
      ),
    ).toEqual({
      markdown: "# 计划\n\n- 第一步",
      planFilePath: "/workspace/.zcode/plans/demo.md",
    });
  });

  it("extracts a directory title from H1 before falling back to the first text line", () => {
    expect(getPlanDirectoryTitle("\n## 摘要\n\n# 最终实施计划\n")).toBe("最终实施计划");
    expect(getPlanDirectoryTitle("\n> 只有一行摘要\n\n- 细节")).toBe("只有一行摘要");
    expect(getPlanDirectoryTitle(" \n\t")).toBeUndefined();
  });

  it("reads a completed plan from serialized tool input text", () => {
    expect(
      extractPlanToolCallContent(
        {
          inputText: JSON.stringify({ plan: "# 冷恢复计划" }),
          output: { content: "tool finished" },
        },
        "/workspace",
      ),
    ).toEqual({ markdown: "# 冷恢复计划" });
  });
});
