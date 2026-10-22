// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMediaPreview } from "@zcode/shared";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import {
  ToolPresentationCapabilitiesProvider,
  type ToolPresentationCapabilities,
} from "@/ToolCallBlocks/presentationCapabilities.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(cleanup);
function body(capabilities: ToolPresentationCapabilities, path = "/workspace/a.png") {
  return createElement(
    ToolPresentationCapabilitiesProvider,
    { value: capabilities },
    createElement(ToolCallBody, {
      childToolList: null,
      workspacePath: "/workspace",
      toolCall: { toolId: "image", kind: "read", status: "completed" },
      displayModel: {
        inlinePreview: { type: "image", source: { type: "image", path, title: path } },
        planResult: null,
        viewerSource: null,
        viewerLabelId: "codeViewer.viewCode",
        showSummaryFileLink: false,
        showInput: false,
        showOutput: false,
        showKind: false,
      },
    }),
  );
}
const media = (path: string): FileMediaPreview => ({
  path,
  mediaType: "image/png",
  dataBase64: `data:image/png;base64,${path}`,
  totalBytes: 1,
});
describe("inline tool image lifecycle", () => {
  it("renders unavailable without a reader", () => {
    render(body({}));
    expect(screen.getByText("chat.toolCall.previewUnavailable")).toBeTruthy();
  });
  it("settles empty results as unavailable", async () => {
    render(body({ readMediaPreview: async () => ({ ...media("a"), dataBase64: "" }) }));
    expect(await screen.findByText("chat.toolCall.previewUnavailable")).toBeTruthy();
  });
  it("handles rejected reads and exits loading", async () => {
    render(
      body({
        readMediaPreview: async () => {
          throw new Error("read failed");
        },
      }),
    );
    expect(await screen.findByText("chat.toolCall.previewFailed")).toBeTruthy();
  });
  it("uses a public URL without reading workspace files", () => {
    const readMediaPreview = vi.fn(async () => media("unused"));
    render(body({ readMediaPreview, resourceUrl: () => "https://example.com/image.png" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://example.com/image.png");
    expect(readMediaPreview).not.toHaveBeenCalled();
  });
  it("discards stale reads and clears the image when the path or reader changes", async () => {
    let resolveOld!: (value: FileMediaPreview) => void;
    const readMediaPreview = vi.fn((path: string) =>
      path.endsWith("a.png")
        ? new Promise<FileMediaPreview>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(media("new")),
    );
    const view = render(body({ readMediaPreview }));
    view.rerender(body({ readMediaPreview }, "/workspace/b.png"));
    await screen.findByRole("img");
    await act(async () => resolveOld(media("old")));
    expect(screen.getByRole("img").getAttribute("src")).toBe(media("new").dataBase64);
    view.rerender(body({}, "/workspace/b.png"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("chat.toolCall.previewUnavailable")).toBeTruthy();
  });
});
