import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";

const base = { turnId: "turn-1", productTurnId: "product-1", createdAt: 1 };
const rows: ConversationRow[] = [
  {
    ...base,
    rowId: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  },
  {
    ...base,
    rowId: 2,
    createdAtSeq: 2,
    kind: "userInput",
    origin: "realUser",
    text: "Describe this image",
    attachments: [
      {
        ref: "zcode-artifact://share/image-1",
        previewRef: "zcode-artifact://share/thumb-1",
        fileName: "photo.png",
        mime: "image/png",
        bytes: 120,
      },
      {
        ref: "zcode-artifact://share/text-1",
        fileName: "notes.txt",
        mime: "text/plain",
        bytes: 20,
      },
    ],
  },
];
const original = "https://resources.example.com/photo.png";
function render(urls: ReadonlyMap<string, string>) {
  return renderToStaticMarkup(
    createElement(ConversationShareReadonlyTimeline, { rows, artifactUrls: urls }),
  );
}

describe("shared user input images", () => {
  it("previews the image while opening the original and keeping ordinary file pills", () => {
    const html = render(
      new Map([
        ["image-1", original],
        ["thumb-1", "https://resources.example.com/thumb.png"],
        ["text-1", "https://resources.example.com/notes.txt"],
      ]),
    );
    expect(html).toMatch(/<img[^>]*src="https:\/\/resources.example.com\/thumb.png"/u);
    expect(html).toContain('alt="photo.png"');
    expect(html).toContain(`href="${original}"`);
    expect(html).toContain('data-v4-user-input-attachment-pill="true"');
    expect(html).toContain("notes.txt");
  });
  it("uses the original image when there is no separate thumbnail URL", () => {
    expect(render(new Map([["image-1", original]]))).toMatch(
      /<img[^>]*src="https:\/\/resources.example.com\/photo.png"/u,
    );
  });
  it("keeps unavailable images as file metadata without a broken image", () => {
    const html = render(new Map());
    expect(html).not.toContain("<img");
    expect(html).toContain("photo.png");
    expect(html).toContain('aria-disabled="true"');
  });
});
