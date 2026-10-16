import { expect, it, vi } from "vitest";
import { uploadComposerAttachment } from "@/v4/composer/attachmentUpload.js";

it.each([true, false])(
  "preserves deferred text material metadata across local/remote upload (local=%s)",
  async (local) => {
    const put = vi.fn(async () => ({ ref: "zcode-artifact://history" }));
    const ref = await uploadComposerAttachment(put, "task", {
      kind: "file",
      filename: "history.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      sourceKind: "topic-history",
      messageCount: 2,
      ...(local ? { localPath: "/target/history.txt" } : { textContent: "abc" }),
    });
    expect(ref).toMatchObject({ sourceKind: "topic-history", messageCount: 2 });
  },
);
