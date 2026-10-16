import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ExecuteToolCallBlock } from "../src/ToolCallBlocks/renderers/execute.js";

describe("ExecuteToolCallBlock", () => {
  it("renders execution results from structured output instead of raw JSON", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ExecuteToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-execute",
              kind: "execute",
              title: "运行 npm install",
              input: {
                command: "npm install",
              },
              output: {
                stdout: "packages installed successfully",
                exitCode: 0,
              },
              status: "completed",
              raw: {
                rawOutput: {
                  stdout: "packages installed successfully",
                  exitCode: 0,
                },
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
          displayModel: {
            inlinePreview: { type: "none" },
            planResult: null,
            viewerSource: null,
            viewerLabelId: "codeViewer.viewCode",
            showSummaryFileLink: true,
            showInput: false,
            showOutput: true,
            showKind: false,
          },
          viewerSource: null,
          rawFileSummaries: [],
          isRunning: false,
          statusLabel: "Completed",
          childToolList: null,
          forceOpen: true,
          canToggle: true,
          showIcon: true,
        }),
      ),
    );

    expect(html).toContain("输出结果");
    expect(html).toContain("packages installed successfully");
    expect(html).not.toContain("&quot;stdout&quot;");
    expect(html).not.toContain("&quot;exitCode&quot;");
  });
});
