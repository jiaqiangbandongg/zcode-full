import { describe, expect, it } from "vitest";
import {
  channelContentPartsSchema,
  channelContentText,
  resolveChannelReplyParts,
} from "@zcode/shared";
import { readGroupMessage } from "../src/bots/providers/feishuGroupMessages.js";
describe("trusted channel mention nodes", () => {
  const mentions = [
    { key: "@_user_1", id: { open_id: "ou_bot" }, name: "ZBot" },
    { key: "@_user_2", id: { open_id: "ou_target" }, name: "Ryan Bot" },
  ];
  it("keeps identity, order and text including the bot wakeup", () => {
    const result = readGroupMessage("@_user_1 帮我 @_user_2 确认", mentions, "ou_bot", "user");
    expect(result?.text).toBe("@ZBot 帮我 @Ryan Bot 确认");
    expect(result?.contentParts).toContainEqual(
      expect.objectContaining({ type: "channelMention", targetId: "ou_target", name: "Ryan Bot" }),
    );
    expect(channelContentText(result!.contentParts!)).toBe(result!.text);
  });
  it("does not remove a longer target key sharing the bot key prefix", () => {
    const result = readGroupMessage(
      "@_user_1 帮我 @_user_10",
      [mentions[0], { ...mentions[1], key: "@_user_10" }],
      "ou_bot",
      "user",
    );
    expect(result?.text).toBe("@ZBot 帮我 @Ryan Bot");
    expect(result?.contentParts).toContainEqual(expect.objectContaining({ targetId: "ou_target" }));
  });
  it("does not promote typed names into identities and rejects unknown refs", () => {
    const result = readGroupMessage("帮我 @Ryan Bot", [], "ou_bot", "user");
    expect(result?.contentParts?.some((p) => p.type === "channelMention")).not.toBe(true);
    expect(() => resolveChannelReplyParts([{ type: "mention", refId: "invented" }], [])).toThrow();
  });
  it("rejects conflicting identity references", () => {
    const parts = readGroupMessage("@_user_2", mentions, "ou_bot", "user")!.contentParts!;
    const node = parts.find((part) => part.type === "channelMention")!;
    expect(() =>
      resolveChannelReplyParts(
        [{ type: "mention", refId: node.refId }],
        [node, { ...node, targetId: "ou_other" }],
      ),
    ).toThrow("Conflicting");
  });
  it("rejects broadcast identities and malformed nodes", () => {
    expect(
      channelContentPartsSchema.safeParse([
        {
          type: "channelMention",
          refId: "m1",
          channel: "feishu",
          targetId: "all",
          name: "all",
          idType: "open_id",
          entityType: "unknown",
        },
      ]).success,
    ).toBe(false);
  });
});
