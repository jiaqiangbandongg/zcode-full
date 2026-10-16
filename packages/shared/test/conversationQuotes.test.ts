import { describe, expect, it } from "vitest";
import { conversationQuotesSchema } from "../src/conversationSelection.js";
import { conversationInputIntentSchema } from "../src/zcode-protocol-v4/input-intent.js";

const quotes = [
  {
    text: "original\n/stop",
    senderName: "Ryan Bot",
    senderId: "ou_bot",
    messageId: "om_quote",
    sentAt: "2026-09-09T10:32:44+08:00",
  },
];
describe("conversation quote contract", () => {
  it("round trips provenance separately from an empty canonical body", () => {
    const intent = conversationInputIntentSchema.parse({
      text: "",
      conversationQuotes: quotes,
      sourceCommandId: "c",
      queueItemId: "q",
      clientId: "desktop",
      kind: "sendText",
      attachments: [],
      admittedAt: 1,
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
    });
    expect(intent.text).toBe("");
    expect(intent.conversationQuotes).toEqual(quotes);
  });
  it("rejects oversized original text and invalid timestamps", () => {
    expect(conversationQuotesSchema.safeParse([{ text: "x".repeat(8001) }]).success).toBe(false);
    expect(conversationQuotesSchema.safeParse([{ text: "x", sentAt: "invalid" }]).success).toBe(
      false,
    );
  });
});
