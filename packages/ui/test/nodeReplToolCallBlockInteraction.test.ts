/** @vitest-environment jsdom */

import type { IBroadcastService } from "@zcode/services";
import {
  createElement,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({
    children,
    code,
    style,
  }: {
    children: ReactNode;
    code: string;
    style?: CSSProperties;
  }) =>
    createElement(
      "div",
      { "data-testid": "code-block", style },
      children,
      createElement("pre", null, code),
    ),
  CodeBlockActions: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CodeBlockCopyButton: (props: ComponentProps<"button">) =>
    createElement("button", { ...props, type: "button" }),
  CodeBlockHeader: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CodeBlockTitle: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CodeBlockWrapButton: (props: ComponentProps<"button">) =>
    createElement("button", { ...props, type: "button" }),
}));

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

const displayModel = {
  inlinePreview: { type: "none" as const },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode" as const,
  showSummaryFileLink: false,
  showInput: false,
  showOutput: false,
  showKind: false,
};

function renderImageToolCall(source?: "browser_turn_end", imageCount = 1) {
  const toolCall = {
    toolId: source ? "tool-browser-turn-screenshot" : "tool-node-repl-image",
    toolName: "mcp__node_repl__js",
    kind: "mcp__node_repl__js",
    input: source
      ? { source }
      : { code: "nodeRepl.emitImage(await tab.screenshot());" },
    output: "",
    raw: {
      schemaVersion: 1,
      display: {
        kind: "node_repl_images",
        ...(source ? { source } : {}),
        images: Array.from({ length: imageCount }, (_, index) => ({
          base64: index === 0 ? "AAAA" : "BBBB",
          mimeType: "image/png",
        })),
      },
    },
    status: "completed" as const,
  };

  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        StoreProvider,
        { broadcastService: mockBroadcastService },
        createElement(
          TooltipProvider,
          null,
          createElement(NodeReplToolCallBlock, {
            toolCallNode: { toolCall, childToolCalls: [] },
            workspacePath: "/workspace",
            displayModel,
            viewerSource: null,
            rawFileSummaries: [],
            isRunning: false,
            statusLabel: "已执行",
            childToolList: null,
            forceOpen: true,
            canToggle: true,
            showIcon: true,
          }),
        ),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("node repl tool interaction", () => {
  it("uses the real code height when opening the tool and execution details", () => {
    const toolCall = {
      toolId: "tool-node-repl-stable-details-height",
      toolName: "js",
      kind: "js",
      title: "js",
      input: {
        code: "return await tab.title();",
        title: "读取页面标题",
      },
      output: { type: "text", value: '{\n  "title": "示例页面"\n}' },
      status: "completed" as const,
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          StoreProvider,
          { broadcastService: mockBroadcastService },
          createElement(
            TooltipProvider,
            null,
            createElement(NodeReplToolCallBlock, {
              toolCallNode: { toolCall, childToolCalls: [] },
              workspacePath: "/workspace",
              displayModel,
              viewerSource: null,
              rawFileSummaries: [],
              isRunning: false,
              statusLabel: "已执行",
              childToolList: null,
              forceOpen: true,
              canToggle: true,
              showIcon: true,
            }),
          ),
        ),
      ),
    );

    const [resultBlock] = screen.getAllByTestId("code-block");
    expect(resultBlock.style.contentVisibility).toBe("visible");
    expect(resultBlock.style.containIntrinsicSize).toBe("none");
    const expandedContent = screen.getByTestId("node-repl-expanded-content");
    expect(expandedContent.className).not.toContain("bg-card");
    expect(expandedContent.className).not.toContain("border");
    const resultSurface = screen.getByTestId("node-repl-result-surface");
    expect(resultSurface.className).toContain("bg-card");
    expect(resultSurface.className).toContain("rounded-xl");
    expect(resultSurface.className).toContain("border");
    expect(resultSurface.className).toContain("border-border");

    fireEvent.click(screen.getByRole("button", { name: "查看执行细节" }));

    const [, detailsBlock] = screen.getAllByTestId("code-block");
    expect(detailsBlock.style.contentVisibility).toBe("visible");
    expect(detailsBlock.style.containIntrinsicSize).toBe("none");
    const detailSurface = screen.getByTestId("node-repl-detail-surface");
    expect(detailSurface.className).toContain("bg-card");
    expect(detailSurface.className).toContain("rounded-xl");
    expect(detailSurface.className).toContain("border");
    expect(detailSurface.className).toContain("border-border");
  });

  it("renders a short single-line result as secondary text instead of a code block", () => {
    const toolCall = {
      toolId: "tool-node-repl-compact-result",
      toolName: "js",
      kind: "js",
      input: {
        code: "return await tab.title();",
        title: "读取页面标题",
      },
      output: { type: "text", value: "示例页面" },
      status: "completed" as const,
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          StoreProvider,
          { broadcastService: mockBroadcastService },
          createElement(
            TooltipProvider,
            null,
            createElement(NodeReplToolCallBlock, {
              toolCallNode: { toolCall, childToolCalls: [] },
              workspacePath: "/workspace",
              displayModel,
              viewerSource: null,
              rawFileSummaries: [],
              isRunning: false,
              statusLabel: "已执行",
              childToolList: null,
              forceOpen: true,
              canToggle: true,
              showIcon: true,
            }),
          ),
        ),
      ),
    );

    const resultSurface = screen.getByTestId("node-repl-result-surface");
    expect(resultSurface.textContent).toBe("示例页面");
    expect(resultSurface.className).toContain("bg-card");
    expect(resultSurface.className).toContain("border-border");
    expect(screen.queryByTestId("code-block")).toBeNull();
  });

  it.each([
    ["显式 Node REPL 图片", undefined],
    ["自动轮尾图片", "browser_turn_end" as const],
  ])(
    "opens and closes the fullscreen preview for %s",
    async (_name, source) => {
      renderImageToolCall(source);

      const thumbnail = screen.getByRole("button", { name: "打开图片预览 1" });
      expect(thumbnail.className).toContain("max-w-1/2");
      expect(thumbnail.querySelector("img")?.className).toContain("max-h-90");
      expect(thumbnail.querySelector("img")?.className).toContain("rounded-xl");
      expect(screen.queryByTestId("node-repl-image-lightbox")).toBeNull();

      fireEvent.click(thumbnail);

      const lightbox = screen.getByTestId("node-repl-image-lightbox");
      const previewImage = screen.getByTestId("node-repl-image-lightbox-image");
      expect(lightbox.className).toContain("w-[calc(100vw-1rem)]");
      expect(lightbox.className).toContain("h-[calc(100dvh-1rem)]");
      expect(lightbox.className).toContain("sm:w-[calc(100vw-2rem)]");
      expect(lightbox.className).toContain("pointer-events-auto");
      expect(lightbox.className).toContain("[app-region:no-drag]");
      expect(previewImage.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      );
      expect(previewImage.className).toContain("max-h-full");
      expect(previewImage.className).toContain("max-w-full");
      expect(previewImage.getAttribute("draggable")).toBe("false");
      expect(screen.getByText("100%")).toBeTruthy();
      expect(screen.getByRole("button", { name: "下载图片" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "上一张图片" })).toBeNull();
      const closeButton = screen.getByRole("button", { name: "关闭" });
      const topActions = closeButton.parentElement;
      expect(
        screen.getByRole("button", { name: "下载图片" }).parentElement,
      ).toBe(topActions);
      expect(topActions?.className).toContain("pointer-events-auto");
      expect(topActions?.className).toContain("[app-region:no-drag]");
      expect(topActions?.className).toContain("right-4");
      expect(topActions?.className).toContain("top-4");
      expect(topActions?.className).toContain(
        "platform-windows-desktop:right-6",
      );
      expect(topActions?.className).toContain(
        "platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]",
      );
      expect(topActions?.className).toContain("platform-linux-desktop:right-6");
      expect(topActions?.className).toContain("platform-linux-desktop:top-4");
      expect(topActions?.className).toContain("platform-mac-desktop:top-12");

      fireEvent.click(previewImage);
      expect(screen.getByTestId("node-repl-image-lightbox")).toBeTruthy();

      const previewViewport = previewImage.parentElement as HTMLDivElement;
      const setPointerCapture = vi.fn();
      const releasePointerCapture = vi.fn();
      previewViewport.setPointerCapture = setPointerCapture;
      previewViewport.hasPointerCapture = vi.fn(() => true);
      previewViewport.releasePointerCapture = releasePointerCapture;

      fireEvent.pointerDown(previewViewport, {
        clientX: 100,
        clientY: 100,
        pointerId: 7,
      });
      fireEvent.pointerUp(previewViewport, {
        clientX: 100,
        clientY: 100,
        pointerId: 7,
      });
      expect(setPointerCapture).toHaveBeenCalledWith(7);
      expect(releasePointerCapture).toHaveBeenCalledWith(7);

      fireEvent.keyDown(screen.getByTestId("node-repl-image-lightbox"), {
        key: "Escape",
        code: "Escape",
      });
      await waitFor(() =>
        expect(screen.queryByTestId("node-repl-image-lightbox")).toBeNull(),
      );
      expect(document.activeElement).toBe(thumbnail);

      fireEvent.click(thumbnail);
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      await waitFor(() =>
        expect(screen.queryByTestId("node-repl-image-lightbox")).toBeNull(),
      );
      expect(document.activeElement).toBe(thumbnail);
    },
  );

  it("groups Browser Use result images and navigates inside the shared preview", () => {
    renderImageToolCall(undefined, 2);

    const gallery = document.querySelector("[data-node-repl-image-gallery]");
    expect(gallery?.className).toContain("grid-cols-1");
    expect(gallery?.className).toContain("sm:grid-cols-2");
    expect(gallery?.className).toContain("md:flex-wrap");
    expect(gallery?.className).toContain(
      "md:[&>[data-image-thumbnail-trigger]]:h-44",
    );

    fireEvent.click(screen.getByRole("button", { name: "打开图片预览 1" }));
    expect(
      screen.getByTestId("node-repl-image-lightbox-image").getAttribute("src"),
    ).toBe("data:image/png;base64,AAAA");

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(
      screen.getByTestId("node-repl-image-lightbox-image").getAttribute("src"),
    ).toBe("data:image/png;base64,BBBB");

    fireEvent.keyDown(screen.getByTestId("node-repl-image-lightbox"), {
      key: "ArrowLeft",
      code: "ArrowLeft",
    });
    expect(
      screen.getByTestId("node-repl-image-lightbox-image").getAttribute("src"),
    ).toBe("data:image/png;base64,AAAA");
  });

  it("falls back to browser-native navigation when a remote image rejects CORS fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ImagePreviewDialog, {
          initialIndex: 0,
          items: [
            {
              alt: "remote cat",
              src: "https://images.example.test/no-cors-cat.png",
            },
          ],
          onOpenChange: vi.fn(),
          open: true,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(
      document.querySelector(
        'a[href="https://images.example.test/no-cors-cat.png"]',
      ),
    ).toBeNull();
  });

  it("navigates from an image to a video in the shared media gallery", () => {
    const onActiveIndexChange = vi.fn();
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => undefined);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ImagePreviewDialog, {
          initialIndex: 0,
          items: [
            { alt: "shot.png", mediaType: "image/png", src: "blob:image" },
            { alt: "demo.mp4", mediaType: "video/mp4", src: "blob:video" },
          ],
          onActiveIndexChange,
          onOpenChange: vi.fn(),
          open: true,
        }),
      ),
    );

    expect(screen.getByRole("img", { name: "shot.png" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "下载图片" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));

    const video = document.querySelector("video");
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    expect(video?.getAttribute("src")).toBe("blob:video");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(screen.queryByRole("button", { name: "下载图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "放大" })).toBeNull();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("img", { name: "shot.png" })).not.toBeNull();
    expect(pause).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    const reopenedVideo = document.querySelector("video");
    fireEvent.error(reopenedVideo!);
    expect(screen.getByRole("alert").textContent).toContain(
      "当前设备不支持预览",
    );
    expect(screen.getByRole("button", { name: "上一张图片" })).not.toBeNull();
  });

  it("does not navigate natively when Content-Length exceeds the Web download limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        body: new ReadableStream(),
        headers: new Headers({
          "content-length": String(50 * 1024 * 1024 + 1),
        }),
        ok: true,
      })),
    );
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ImagePreviewDialog, {
          initialIndex: 0,
          items: [
            {
              alt: "large remote image",
              src: "https://images.example.test/large.png",
            },
          ],
          onOpenChange: vi.fn(),
          open: true,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "下载图片" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(anchorClick).not.toHaveBeenCalled();
  });
});
