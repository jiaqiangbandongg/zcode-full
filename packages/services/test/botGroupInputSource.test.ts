import { describe, expect, it } from "vitest";
import {
  commandPayloadSchemas,
  conversationInputIntentSchema,
} from "@zcode/shared/zcode-protocol-v4";

describe("group source wire contract", () => {
  it("preserves sender separately from destination in command and canonical input", () => {
    const botGroupSource = {
      provider: "feishu",
      botId: "bot",
      chatId: "oc_group",
      senderId: "ou_member",
      senderName: "甲",
      messageId: "om_message",
    };
    expect(
      commandPayloadSchemas.sendText.parse({
        text: "hello",
        botGroupSource,
        inputOrigin: "mobile",
      }),
    ).toMatchObject({
      botGroupSource,
      inputOrigin: "mobile",
    });
    const input = {
      sourceCommandId: "command",
      queueItemId: "queue",
      clientId: "client",
      kind: "sendText",
      text: "hello",
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: 1,
      botGroupSource,
    };
    expect(conversationInputIntentSchema.parse(input)).toMatchObject({ botGroupSource });
  });
});
