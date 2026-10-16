import { describe, expect, it } from "vitest";
import { botGroupInputSourceSchema } from "@zcode/shared";

const source = {
  provider: "feishu",
  botId: "bot",
  chatId: "chat",
  threadId: "topic",
  senderId: "last",
  senderName: "Last",
  messageId: "m2",
};
const messages = [
  {
    messageId: "m1",
    senderId: "first",
    senderName: "First",
    mentionedBot: true,
    text: "first request",
    attachmentIndexes: [0],
  },
  {
    messageId: "m2",
    senderId: "last",
    senderName: "Last",
    mentionedBot: false,
    text: "correction",
    attachmentIndexes: [],
  },
];
describe("topic batch original messages", () => {
  it("preserves each sender and body independently inside one accepted input", () => {
    expect(botGroupInputSourceSchema.parse({ ...source, messages }).messages).toEqual(messages);
  });
  it("rejects duplicate source messages and a mismatching boundary", () => {
    expect(
      botGroupInputSourceSchema.safeParse({ ...source, messages: [messages[0], messages[0]] })
        .success,
    ).toBe(false);
    expect(
      botGroupInputSourceSchema.safeParse({ ...source, messageId: "other", messages }).success,
    ).toBe(false);
  });
});
