import { describe, expect, it } from "vitest";
import { createGroupAdminAttention } from "../src/bots/groupAdminAttention.js";
import type { BotActor } from "@zcode/shared";
const actor: BotActor = {
  botId: "bot",
  provider: "feishu",
  providerUserId: "member",
  chatType: "group",
  chatId: "oc_group",
  threadId: "topic",
};
describe("group administrator attention", () => {
  it("deduplicates a blocker and allows a new reminder after recovery", () => {
    const notices = createGroupAdminAttention();
    expect(notices.mention(actor, "ou_owner", "model")).toEqual(["ou_owner"]);
    expect(notices.mention({ ...actor, providerUserId: "other" }, "ou_owner", "model")).toEqual([]);
    notices.clear(actor, "ou_owner", "model");
    expect(notices.mention(actor, "ou_owner", "model")).toEqual(["ou_owner"]);
  });
  it("isolates topics, owners and approval requests and skips private chats", () => {
    const notices = createGroupAdminAttention();
    for (const [target, owner, reason] of [
      [actor, "ou_owner", "approval:1"],
      [actor, "ou_owner", "approval:2"],
      [{ ...actor, threadId: "other" }, "ou_owner", "approval:1"],
      [actor, "ou_new", "approval:1"],
    ] as const) {
      expect(notices.mention(target, owner, reason)).toEqual([owner]);
    }
    expect(notices.mention({ ...actor, chatType: "private" }, "ou_owner", "model")).toBeUndefined();
    expect(notices.mention(actor, undefined, "model")).toBeUndefined();
  });
});
