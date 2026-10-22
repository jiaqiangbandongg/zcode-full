import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
const cases = [
  ["WebFetch", { url: "https://example.com/paper", prompt: "hidden extraction" }, "Fetch"],
  ["WebSearch", { query: "test query" }, "Search"],
  ["Read", { file_path: "/Users/dev/example.ts" }, "Read"],
  ["Bash", { command: "echo hello" }, "Terminal"],
  ["Skill", { skill: "test-skill" }, "Skill"],
  ["Agent", { subagent_type: "researcher", description: "Investigate" }, "researcher"],
] as const;
describe("common readonly tool renderer", () => {
  for (const [toolName, input, label] of cases)
    it(`matches App ${toolName} summary`, () => {
      const row: ToolCallRow = {
        kind: "toolCall",
        rowId: 1,
        turnId: "t",
        toolCallId: "tool",
        toolName,
        status: "success",
        inputText: JSON.stringify(input),
        input,
        createdAt: 1,
        createdAtSeq: 1,
      };
      const node = toolCallRowToLegacyNode(row);
      const render = (component: typeof ToolPresentation | typeof ToolCallBlock) =>
        renderToStaticMarkup(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "en-US" },
            createElement(component, {
              toolCallNode: node,
              workspacePath: "",
              showTodoToolCalls: false,
            }),
          ),
        );
      const app = render(ToolCallBlock);
      const share = render(ToolPresentation);
      expect(app).toContain(label);
      expect(share).toContain(label);
      if (toolName === "WebFetch") {
        expect(share).toContain("https://example.com/paper");
        expect(share).not.toContain("hidden extraction");
        expect(share).not.toContain("aria-expanded");
      }
    });
});
