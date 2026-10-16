import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

function renderPreview(isPermissionPreview: boolean) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ExecuteToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "command",
            kind: "execute",
            status: "completed",
            input: { command: "echo hello" },
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: "",
        childToolList: null,
        forceOpen: true,
        isPermissionPreview,
      } as ToolCallBlockRenderContext),
    ),
  );
}

describe("execute permission preview", () => {
  it("does not describe an unexecuted permission request as empty output", () => {
    expect(renderPreview(true)).not.toContain("没有输出。");
  });
  it("retains the empty-output hint for completed execution", () => {
    expect(renderPreview(false)).toContain("没有输出。");
  });
});
