import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";

function renderAttachmentWithOpen(openable: boolean) {
  return renderToStaticMarkup(
    createElement(
      Attachments,
      { variant: "inline" },
      createElement(
        Attachment,
        {
          data: {
            id: "screenshot",
            type: "file",
            filename: "screenshot.png",
            mediaType: "image/png",
            url: "blob:zcode-preview",
          },
          onOpen: openable ? () => undefined : undefined,
          openLabel: "Open image preview",
        },
        "screenshot.png",
      ),
    ),
  );
}

describe("Attachment preview affordance", () => {
  it("renders uploaded image attachments as keyboard-openable preview triggers", () => {
    const html = renderAttachmentWithOpen(true);

    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Open image preview"');
    expect(html).toContain("cursor-pointer");
  });

  it("does not add button semantics when no preview action is provided", () => {
    const html = renderAttachmentWithOpen(false);

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain("cursor-default");
    expect(html).not.toContain("cursor-pointer");
  });

  it("renders the shared play affordance over grid video thumbnails", () => {
    const html = renderToStaticMarkup(
      createElement(
        Attachment,
        {
          data: {
            id: "video",
            type: "file",
            filename: "demo.mov",
            mediaType: "video/quicktime",
            url: "blob:video-preview",
          },
          variant: "grid",
        },
        createElement(AttachmentPreview),
      ),
    );

    expect(html).toContain('data-attachment-video-play-overlay="true"');
    expect(html).toContain("rounded-full");
    expect(html).toContain("bg-black/55");
    expect(html).toContain("backdrop-blur-sm");
    expect(html).toContain("pointer-events-none");
  });

  it("renders inline clipboard text attachments as a single line with description", () => {
    const html = renderToStaticMarkup(
      createElement(
        Attachments,
        { variant: "inline" },
        createElement(
          Attachment,
          {
            data: {
              description: "128 行",
              displayName: "粘贴文本",
              id: "pasted-text",
              filename: "pasted-text-20260627-153012.txt",
              mediaType: "text/plain",
              sourceKind: "clipboard-text",
              type: "file",
              url: "",
            },
          },
          createElement(AttachmentInfo),
        ),
      ),
    );

    expect(html).toContain("粘贴文本");
    expect(html).toContain("128 行");
    expect(html).not.toContain("18 KB");
    expect(html).not.toContain("pasted-text-20260627-153012.txt");
  });

  it("renders inline remove action as a side-pane-style trailing overlay", () => {
    const html = renderToStaticMarkup(
      createElement(
        Attachments,
        { variant: "inline" },
        createElement(
          Attachment,
          {
            data: {
              id: "pasted-text",
              filename: "pasted-text.txt",
              mediaType: "text/plain",
              type: "file",
              url: "",
            },
            onRemove: () => undefined,
          },
          createElement(AttachmentInfo),
          createElement(AttachmentRemove, { label: "移除附件" }),
        ),
      ),
    );

    expect(html).toContain("absolute inset-y-0 right-0");
    expect(html).toContain("bg-gradient-to-r from-transparent");
    expect(html).toContain("pointer-events-auto");
    expect(html).toContain('aria-label="移除附件"');
  });
});
