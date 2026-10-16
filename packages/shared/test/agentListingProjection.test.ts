import { describe, expect, it } from "vitest";
import { zcodeSyntheticUserMessageSourceSchema } from "../src/zcode-protocol-legacy-types.js";
import {
  getConversationMessageProjectionPolicy,
  getConversationModelOnlyTurnTriggerSource,
} from "../src/conversation-message-projection-policy.js";

describe("agent listing shared projection", () => {
  it("accepts the persisted source and keeps it as provider context without a turn trigger", () => {
    expect(zcodeSyntheticUserMessageSourceSchema.parse("agent_listing_delta")).toBe(
      "agent_listing_delta",
    );
    const message = {
      info: { role: "user", source: "agent_listing_delta", synthetic: true },
      parts: [{ type: "text", text: "Available agent types for the Agent tool:", synthetic: true }],
    };
    expect(getConversationMessageProjectionPolicy(message)).toBe("providerContextOnly");
    expect(getConversationModelOnlyTurnTriggerSource(message)).toBeNull();
  });
});
