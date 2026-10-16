import { describe, expect, it } from "vitest";
import { createTopicHistoryAttachment } from "../src/bots/topicHistoryAttachment.js";

describe("topic history text material", () => {
  const batch = {
    checkpoint: "om_current",
    hasGap: false,
    messages: [
      {
        id: "om_a",
        chatId: "oc_a",
        threadId: "omt_a",
        senderId: "ou_alice",
        senderName: "Alice",
        senderType: "user" as const,
        createdAt: 1000,
        kind: "post",
        text: "line one\nline two",
        attachments: [{ name: "diagram.png", kind: "image" }],
      },
    ],
  };
  it("keeps sender identity and original lines, and scopes resource indexes to this snapshot", () => {
    const result = createTopicHistoryAttachment(batch, "input-a", "Design");
    expect(result).toMatchObject({ sourceKind: "topic-history", messageCount: 1 });
    for (const text of [
      "Alice",
      "ou_alice",
      "line one\nline two",
      "input-a",
      "diagram.png",
      "A1",
      "M1",
      "UTC",
    ])
      expect(result!.textContent).toContain(text);
    expect(result!.textContent).not.toContain("bot_topic_context");
    expect(createTopicHistoryAttachment(batch, "input-b", "Design")!.filename).not.toBe(
      result!.filename,
    );
  });
  it("does not duplicate empty history; preserves unavailable coverage as a file", () => {
    expect(
      createTopicHistoryAttachment({ ...batch, messages: [] }, "empty", "Design"),
    ).toBeUndefined();
    expect(
      createTopicHistoryAttachment({ ...batch, messages: [], hasGap: true }, "gap", "Design")
        ?.textContent,
    ).toContain("incomplete");
  });
});
