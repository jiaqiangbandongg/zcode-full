import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
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

it.each(["zh-CN", "en-US"] as const)("无宿主图片能力时 %s 展示静态不可用状态", (locale) => {
  const toolCall = {
    toolId: "read-image",
    kind: "Read",
    toolName: "Read",
    input: { file_path: "/workspace/chart.png" },
    status: "completed" as const,
  };
  const displayModel = buildToolDisplayModel(toolCall, "/workspace");
  expect(displayModel.inlinePreview.type).toBe("image");
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        ToolPresentationCapabilitiesProvider,
        { value: { readonly: true, resourceUrl: () => undefined } },
        createElement(ToolCallBody, {
          childToolList: null,
          displayModel,
          toolCall,
          workspacePath: "",
        }),
      ),
    ),
  );
  expect(html).toContain(locale === "zh-CN" ? "预览不可用" : "Preview unavailable");
  expect(html).not.toMatch(/Loading|正在加载/);
});
it("公开图片资源命中时直接渲染图片", () => {
  const toolCall = {
    toolId: "read-image",
    kind: "Read",
    toolName: "Read",
    input: { file_path: "/workspace/chart.png" },
    status: "completed" as const,
  };
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ToolPresentationCapabilitiesProvider,
        { value: { readonly: true, resourceUrl: () => "https://files.example.com/chart.png" } },
        createElement(ToolCallBody, {
          childToolList: null,
          displayModel: buildToolDisplayModel(toolCall, "/workspace"),
          toolCall,
          workspacePath: "",
        }),
      ),
    ),
  );
  expect(html).toContain('src="https://files.example.com/chart.png"');
  expect(html).not.toContain("Preview unavailable");
});
