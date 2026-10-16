import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ExecuteToolCallBlock } from "../src/ToolCallBlocks/renderers/execute.js";

describe("Bash bounded output preview", () => {
  it.each([false, true])(
    "renders V4 preview only inside expanded details (expanded=%s)",
    (expanded) => {
      const toolCallNode = toolCallRowToLegacyNode({
        kind: "toolCall",
        rowId: 1,
        turnId: "turn",
        createdAt: 1,
        createdAtSeq: 1,
        toolCallId: "preview-bash",
        toolName: "Bash",
        status: "running",
        inputText: "",
        input: { command: "build" },
        outputPreview: {
          text: "latest-line",
          fullText: "earlier-line\nlatest-line",
          totalLines: 1234,
          totalBytes: 40960,
          linesEstimated: true,
        },
      } as ToolCallRow);
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ExecuteToolCallBlock, {
            toolCallNode,
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
            isRunning: true,
            statusLabel: "Running",
            childToolList: null,
            forceOpen: expanded,
          }),
        ),
      );
      expect(html.includes("latest-line")).toBe(expanded);
      expect(html.includes("earlier-line")).toBe(expanded);
      expect(html.includes("bash-output-preview-full")).toBe(expanded);
      expect(html).not.toContain("bash-output-preview-short");
      expect(html).not.toContain("1,234");
      expect(html).not.toContain("40,960");
      expect(html).not.toContain("约");
      if (expanded) expect(html).toContain("whitespace-pre-wrap");
    },
  );
});

describe("Bash final output content", () => {
  function renderResult(display: unknown, expanded = true, truncated?: ToolCallRow["output"]) {
    const row = {
      kind: "toolCall",
      rowId: 1,
      turnId: "turn",
      createdAt: 1,
      createdAtSeq: 1,
      toolCallId: "result-bash",
      toolName: "Bash",
      status: "success",
      inputText: "",
      input: { command: "build" },
      output: { text: "provider summary", display, ...truncated },
    } as ToolCallRow;
    return renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ExecuteToolCallBlock, {
          toolCallNode: toolCallRowToLegacyNode(row),
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
          forceOpen: expanded,
        }),
      ),
    );
  }
  it.each([false, true])(
    "shows only the output when expanded, without notices or a file link (%s)",
    (expanded) => {
      const html = renderResult(
        {
          kind: "bash_output",
          output: "head of output",
          truncated: true,
          outputPath: "/中文 空格/output.log",
        },
        expanded,
      );
      expect(html).not.toContain("仅显示部分输出");
      expect(html).not.toContain("/中文 空格/output.log");
      expect(html).not.toContain("bash-output-notice");
      expect(html).not.toContain("bash-output-file");
      expect(html).not.toContain("provider summary");
      expect(html.includes("head of output")).toBe(expanded);
    },
  );
  it("does not infer truncation from exactly 30,000 characters", () => {
    const html = renderResult({ kind: "bash_output", output: "x".repeat(30000), truncated: false });
    expect(html).not.toContain("bash-output-notice");
    expect(html).toContain("x".repeat(30000));
  });
  it("keeps only the output when a truncated file was cleaned up", () => {
    const html = renderResult({ kind: "bash_output", output: "head", truncated: true });
    expect(html).toContain("head");
    expect(html).not.toContain("仅显示部分输出");
    expect(html).not.toContain("完整输出");
  });
  it("keeps old output text without adding a notice or exposing the protocol truncation ref", () => {
    const html = renderResult(undefined, true, {
      text: "legacy head and tail",
      truncated: { totalBytes: 100000, ref: "tool-output/result-bash" },
    });
    expect(html).toContain("legacy head and tail");
    expect(html).not.toContain("仅显示部分输出");
    expect(html).not.toContain("tool-output/result-bash");
  });
});
