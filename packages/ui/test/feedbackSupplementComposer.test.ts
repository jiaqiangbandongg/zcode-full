import { describe, expect, it, vi } from "vitest";
import type { IFeedbackService } from "@zcode/services";
import {
  MAX_SUPPLEMENT_ATTACHMENT_BYTES,
  MAX_SUPPLEMENT_ATTACHMENTS,
  submitSupplementFeedback,
  type SupplementAttachmentDraft,
} from "@/feedback/FeedbackSupplementComposer.js";

describe("FeedbackSupplementComposer", () => {
  it("uses the feedback API attachment limits for supplemental files", () => {
    expect(MAX_SUPPLEMENT_ATTACHMENTS).toBe(6);
    expect(MAX_SUPPLEMENT_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
  });

  it("creates the supplemental message before uploading attachments to that message", async () => {
    const calls: string[] = [];
    const attachment: SupplementAttachmentDraft = {
      id: "att-local",
      filename: "detail.log",
      contentType: "text/plain",
      dataBase64: "ZGV0YWls",
      size: 6,
      kind: "other",
    };
    const feedbackService = {
      comment: vi.fn(async () => {
        calls.push("comment");
        return {
          id: 1,
          message_id: "msg_123",
          body: "补充说明",
          is_staff: false,
          created_at: "2026-06-25T00:00:00.000Z",
        };
      }),
      uploadAttachmentData: vi.fn(async (_ticketId, _kind, file) => {
        calls.push("upload");
        expect(file.messageId).toBe("msg_123");
        return {
          id: 2,
          kind: "other",
          filename: file.filename,
          size: 6,
          redacted: false,
          created_at: "2026-06-25T00:00:00.000Z",
        };
      }),
    } as unknown as IFeedbackService;

    await submitSupplementFeedback({
      ticketId: "tkt_1",
      feedbackService,
      comment: "补充说明",
      attachments: [attachment],
      formatUploadedAttachments: (names) => `附件：${names.join("、")}`,
    });

    expect(calls).toEqual(["comment", "upload"]);
    expect(feedbackService.comment).toHaveBeenCalledWith(
      "tkt_1",
      "补充说明\n\n附件：detail.log",
    );
    expect(feedbackService.uploadAttachmentData).toHaveBeenCalledWith("tkt_1", "other", {
      dataBase64: "ZGV0YWls",
      filename: "detail.log",
      contentType: "text/plain",
      messageId: "msg_123",
    });
  });
});
