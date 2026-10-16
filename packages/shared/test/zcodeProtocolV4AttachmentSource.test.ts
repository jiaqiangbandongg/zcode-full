import { describe, expect, it } from "vitest";
import {
  userInputRowSchema,
  v4AttachmentReadResultSchema,
  PROTOCOL_V4_LIMITS,
} from "../src/zcode-protocol-v4/index.js";

describe("V4 attachment source across row transport", () => {
  it("accepts text preview responses and keeps the text attachment size limit", () => {
    const response = {
      dataBase64: "aGk=",
      mediaType: "text/plain; charset=utf-8",
      totalBytes: 2,
      nextOffset: null,
    };
    expect(v4AttachmentReadResultSchema.parse(response)).toEqual(response);
    expect(() =>
      v4AttachmentReadResultSchema.parse({
        ...response,
        totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
      }),
    ).toThrow();
    expect(() =>
      v4AttachmentReadResultSchema.parse({ ...response, mediaType: "text/html" }),
    ).toThrow();
  });
  it.each(["clipboard-text", "topic-history"])(
    "preserves %s on the executed user row",
    (sourceKind) => {
      const attachment = {
        ref: "zcode-artifact://history",
        fileName: "history.txt",
        mime: "text/plain",
        bytes: 84,
        sourceKind,
        messageCount: 1,
      };
      const row = userInputRowSchema.parse({
        rowId: 1,
        turnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "userInput",
        origin: "realUser",
        text: "request",
        attachments: [attachment],
      });
      expect(row.attachments).toEqual([attachment]);
    },
  );
});
