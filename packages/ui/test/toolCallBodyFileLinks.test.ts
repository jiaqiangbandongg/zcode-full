import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import type { ToolDisplayModel } from "@/lib/toolDisplay.js";

const messageResponseProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/components/ai-elements/message.js", async () => {
  const React = await import("react");
  return {
    MessageResponse: ({ children, ...props }: { children?: ReactNode }) => {
      messageResponseProps.push(props);
      return React.createElement("div", null, children);
    },
  };
});

describe("ToolCallBody markdown file links", () => {
  it("passes the file-link opener to tool markdown before falling back to code viewer", () => {
    const onOpenCodeViewer = vi.fn();
    const onOpenFileLink = vi.fn();
    const displayModel: ToolDisplayModel = {
      inlinePreview: {
        type: "text",
        source: {
          type: "text",
          title: "Tool markdown",
          content: "See [demo.ts](./src/demo.ts)",
          language: "markdown",
        },
      },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    };

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBody, {
          childToolList: null,
          displayModel,
          toolCall: {
            toolId: "tool-markdown-link",
            kind: "Read",
            status: "completed",
          },
          workspacePath: "/workspace",
          onOpenCodeViewer,
          onOpenFileLink,
        }),
      ),
    );

    expect(messageResponseProps).toHaveLength(1);
    expect(messageResponseProps[0]?.onOpenCodeViewer).toBe(onOpenCodeViewer);
    expect(messageResponseProps[0]?.onOpenFileLink).toBe(onOpenFileLink);
  });
});
