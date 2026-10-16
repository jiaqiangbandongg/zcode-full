import { describe, expect, it } from "vitest";
import {
  readGroupMessage,
  readGroupMentionText,
} from "../src/bots/providers/feishuGroupMessages.js";

describe("group mention gate", () => {
  const mentions = [
    { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" },
    { key: "@_user_2", id: { open_id: "ou_member" }, name: "Member" },
  ];
  it("preserves the current bot mention in canonical text", () => {
    expect(readGroupMentionText("@_user_1 /new", mentions, "ou_bot", "user")).toBe("@Bot /new");
    expect(readGroupMentionText("@_user_1 ask @_user_2", mentions, "ou_bot", "user")).toBe(
      "@Bot ask @Member",
    );
  });
  it("rejects other bots, missing identity and text that merely looks like an at", () => {
    expect(readGroupMentionText("@Bot hello", [], "ou_bot", "user")).toBeNull();
    expect(readGroupMentionText("@_user_1 hello", mentions, "other", "user")).toBeNull();
    expect(readGroupMentionText("@_user_1 hello", mentions, "", "user")).toBeNull();
    expect(readGroupMentionText("@_user_1 hello", mentions, "ou_bot", "app")).toBeNull();
  });
});

describe("native mention assignment", () => {
  const mentions = [
    { key: "@_self", id: { open_id: "ou_self" }, name: "Outline Bot" },
    { key: "@_other", id: { open_id: "ou_other" }, name: "Travel Bot" },
  ];
  it("retains every recipient and their position in a multi-bot assignment", () => {
    const parsed = readGroupMessage(
      "Trip\n@_self handles outline\n@_other handles travel",
      mentions,
      "ou_self",
      "user",
    )!;
    expect(parsed.text).toBe("Trip\n@Outline Bot handles outline\n@Travel Bot handles travel");
    expect(
      parsed.contentParts?.filter((p) => p.type === "channelMention").map((p) => p.targetId),
    ).toEqual(["ou_self", "ou_other"]);
    expect(parsed.commandText).toBe(parsed.text);
  });
  it("strips only leading self mentions from the command copy", () => {
    const parsed = readGroupMessage("@_self /workspace", mentions, "ou_self", "user")!;
    expect(parsed.text).toBe("@Outline Bot /workspace");
    expect(parsed.commandText).toBe("/workspace");
    expect(readGroupMessage("@_other /stop @_self", mentions, "ou_self", "user")?.commandText).toBe(
      "@Travel Bot /stop @Outline Bot",
    );
    expect(readGroupMessage("@Outline Bot /stop", [], "ou_self", "user")?.commandText).toBe(
      "@Outline Bot /stop",
    );
    expect(readGroupMessage("@_self", mentions, "ou_self", "user")?.commandText).toBe("");
  });
});
