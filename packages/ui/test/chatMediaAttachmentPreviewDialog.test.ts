/** @vitest-environment jsdom */

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMediaAttachmentPreviewDialog } from "@/ChatMediaAttachmentPreviewDialog.js";

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/ui/pdf-viewer.js", () => ({
  PdfViewer: ({ labels }: { labels?: Record<string, string> }) =>
    createElement(
      "div",
      {
        "data-testid": "pdf-viewer",
        "data-labels": JSON.stringify(labels ?? {}),
      },
      "pdf",
    ),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

afterEach(cleanup);

describe("ChatMediaAttachmentPreviewDialog", () => {
  it("renders topic history as readable original text without interpreting markup", () => {
    const view = render(
      createElement(ChatMediaAttachmentPreviewDialog, {
        attachment: {
          filename: "topic-history.txt",
          mediaType: "text/plain",
          textContent: "Alice | ou_a\n<script>history</script>",
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    );
    expect(view.container.querySelector("pre")?.textContent).toBe(
      "Alice | ou_a\n<script>history</script>",
    );
    expect(view.container.querySelector("script")).toBeNull();
  });
  it("loads every video MIME through the native inline player without autoplay", () => {
    const view = render(
      createElement(ChatMediaAttachmentPreviewDialog, {
        attachment: {
          filename: "demo.mov",
          mediaType: "video/quicktime",
          url: "blob:video-preview",
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    );

    const video = view.container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(video?.getAttribute("src")).toBe("blob:video-preview");
    expect(screen.getByRole("status").textContent).toBe("chat.attachments.preview.videoLoading");

    fireEvent.loadedMetadata(video!);

    expect(screen.queryByRole("status")).toBeNull();
    expect(video?.className).not.toContain("invisible");
  });

  it("shows a non-blocking format notice when the native player cannot decode the video", () => {
    const onOpenChange = vi.fn();
    const view = render(
      createElement(ChatMediaAttachmentPreviewDialog, {
        attachment: {
          filename: "unsupported.mov",
          mediaType: "video/quicktime",
          url: "blob:unsupported-video",
        },
        open: true,
        onOpenChange,
      }),
    );
    const video = view.container.querySelector("video");

    fireEvent.error(video!);

    expect(screen.getByRole("alert").textContent).toBe("chat.attachments.preview.videoUnsupported");
    expect(view.container.querySelector("video")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    view.rerender(
      createElement(ChatMediaAttachmentPreviewDialog, {
        attachment: {
          filename: "unsupported.mov",
          mediaType: "video/quicktime",
          url: "blob:unsupported-video",
        },
        open: false,
        onOpenChange,
      }),
    );
    expect(view.container.querySelector("video")).not.toBeNull();
  });

  it("preserves the existing image preview branch", () => {
    const view = render(
      createElement(ChatMediaAttachmentPreviewDialog, {
        attachment: {
          filename: "screen.png",
          mediaType: "image/png",
          url: "blob:image-preview",
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    );

    expect(screen.getByRole("img", { name: "screen.png" }).getAttribute("src")).toBe(
      "blob:image-preview",
    );
    expect(view.container.querySelector("video")).toBeNull();
  });

  it("passes the complete localized PDF control label set to PdfViewer", async () => {
    render(
      createElement(ChatMediaAttachmentPreviewDialog, {
        attachment: {
          filename: "report.pdf",
          mediaType: "application/pdf",
          url: "blob:pdf-preview",
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    );

    const viewer = await screen.findByTestId("pdf-viewer");
    const labels = JSON.parse(viewer.getAttribute("data-labels") ?? "{}");
    for (const key of [
      "loading",
      "loadError",
      "noData",
      "previousPage",
      "nextPage",
      "pageInput",
      "zoomIn",
      "zoomOut",
    ]) {
      expect(labels[key]).toBeTruthy();
    }
    expect(labels.previousPage).toBe("codeViewer.pdf.previousPage");
    expect(labels.zoomIn).toBe("codeViewer.pdf.zoomIn");
  });
});
