/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/pdf-viewer.js", () => {
  throw new Error("PDF viewer must not be loaded while importing the media dialog");
});

describe("ChatMediaAttachmentPreviewDialog module loading", () => {
  it("does not eagerly load the PDF.js viewer", async () => {
    await expect(import("@/ChatMediaAttachmentPreviewDialog.js")).resolves.toBeDefined();
  });
});
