import { describe, expect, it } from "vitest";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { expandTopicInputMessages } from "@/v4/topicInputMessages.js";

describe("topic input presentation", () => {
  it("keeps original senders and attachment ownership while showing history only once", () => {
    const row = {
      kind: "userInput",
      rowId: 1,
      entityId: "input",
      text: "combined model text",
      attachments: [{ ref: "file-a" }, { ref: "file-b" }, { ref: "history" }],
      botGroupSource: {
        provider: "feishu",
        botId: "bot",
        chatId: "chat",
        threadId: "topic",
        senderId: "b",
        senderName: "B",
        messageId: "b",
        messages: [
          {
            messageId: "a",
            senderId: "a",
            senderName: "A",
            text: "first",
            attachmentIndexes: [0],
            conversationQuotes: [{ text: "root" }],
          },
          {
            messageId: "b",
            senderId: "b",
            senderName: "B",
            text: "second",
            attachmentIndexes: [1],
          },
        ],
      },
    } as UserInputRow;
    const rows = expandTopicInputMessages(row);
    expect(rows.map((r) => [r.text, r.botGroupSource?.senderName])).toEqual([
      ["first", "A"],
      ["second", "B"],
    ]);
    expect(rows.map((r) => r.attachments?.map((a) => a.ref))).toEqual([
      ["file-a", "history"],
      ["file-b"],
    ]);
    expect(rows[0]?.conversationQuotes).toEqual([{ text: "root" }]);
    expect(rows[1]?.conversationQuotes).toEqual([]);
    expect(row.text).toBe("combined model text");
  });
  it("preserves normal user input identity", () => {
    const row = { kind: "userInput", text: "normal" } as UserInputRow;
    expect(expandTopicInputMessages(row)).toEqual([row]);
    expect(expandTopicInputMessages(row)[0]).toBe(row);
  });
});
