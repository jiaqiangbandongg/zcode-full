import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Attachment, AttachmentInfo, Attachments } from "@/components/ai-elements/attachments.js";

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
  });

  it("does not add button semantics when no preview action is provided", () => {
    const html = renderAttachmentWithOpen(false);

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="0"');
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
});
