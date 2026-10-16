import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ExecuteGroupToolCallBlock } from "@/ToolCallBlocks/renderers/execute-group.js";

function renderExecuteGroup(
  locale: "zh-CN" | "en-US",
  statuses: Array<"pending" | "completed" | "failed" | "stopped" | "in_progress">,
  options: { forceOpen?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ExecuteGroupToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "execute:tool-1",
            kind: "Execute",
            title: "Execute",
            input: {},
            status:
              statuses.includes("in_progress") || statuses.includes("pending")
                ? "in_progress"
                : "completed",
          },
          childToolCalls: statuses.map((status, index) => ({
            toolCall: {
              toolId: `tool-${index + 1}`,
              kind: "execute",
              title: "Bash",
              input: { command: index === 0 ? "pnpm install" : "pnpm test" },
              output: status === "failed" ? "failed output" : "ok",
              status,
            },
            childToolCalls: [],
          })),
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
        isRunning: statuses.includes("in_progress") || statuses.includes("pending"),
        statusLabel:
          statuses.includes("in_progress") || statuses.includes("pending")
            ? "执行中"
            : "已完成",
        childToolList: null,
        forceOpen: options.forceOpen ?? false,
        canToggle: true,
        showIcon: true,
      }),
    ),
  );
}

describe("ExecuteGroupToolCallBlock", () => {
  it("shows the latest active command while running", () => {
    const html = renderExecuteGroup("zh-CN", ["completed", "in_progress"]);
    const enHtml = renderExecuteGroup("en-US", ["completed", "in_progress"]);

    expect(html).toContain(">终端</span>");
    expect(enHtml).toContain(">Terminal</span>");
    expect(html).toContain("正在执行");
    expect(html).toContain("pnpm test");
    expect(html).not.toContain("2 个命令");
    expect(html).toContain(">·</span>");
    expect(enHtml).toContain(
      '<span class="shrink-0 text-foreground-subtle">Running</span>',
    );
    expect(enHtml).toContain(
      '<code class="min-w-0 truncate font-sans">pnpm test</code>',
    );
    expect(html).toContain(
      "relative inline-flex min-w-0 items-center gap-2 overflow-hidden",
    );
  });

  it("shows only the command count in the expanded running summary", () => {
    const html = renderExecuteGroup(
      "en-US",
      ["completed", "in_progress"],
      { forceOpen: true },
    );
    const summaryEnd = html.indexOf('data-slot="collapsible-content"');
    const summary = html.slice(0, summaryEnd);

    expect(summary).toContain("2 commands");
    expect(summary).not.toContain("Running");
    expect(summary).not.toContain("pnpm test");
  });

  it("prefers an earlier pending command over a later completed command", () => {
    const html = renderExecuteGroup("en-US", ["pending", "completed"]);

    expect(html).toContain("pnpm install");
    expect(html).not.toContain("pnpm test");
  });

  it("summarizes command and failure counts after completion", () => {
    const zhHtml = renderExecuteGroup("zh-CN", ["completed", "failed"]);
    const enHtml = renderExecuteGroup("en-US", ["completed", "failed"]);

    expect(zhHtml).toContain("2 个命令");
    expect(zhHtml).toContain("1 个失败");
    expect(enHtml).toContain("2 commands");
    expect(enHtml).toContain("1 failed");
    expect(enHtml).toContain(">Terminal</span>");
    expect(enHtml).toContain(">·</span>");
    expect(enHtml).not.toContain(
      "relative inline-flex min-w-0 items-center overflow-hidden",
    );
  });
});
