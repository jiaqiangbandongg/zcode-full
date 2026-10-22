import { describe, expect, it } from "vitest";
import { hasAssistantReplyForUserTurn } from "./e2e/helpers/conversation-turn-evidence.js";

describe("续发必须有本回合的新回复", () => {
  it("旧回复和新 user 行不能冒充新回复", () => {
    expect(
      hasAssistantReplyForUserTurn(
        [
          { role: "user", text: "FIRST" },
          { role: "assistant", text: "SAME_REPLY" },
          { role: "user", text: "FOLLOW:turn-1:" },
        ],
        "FOLLOW:turn-1:",
        "SAME_REPLY",
      ),
    ).toBe(false);
  });
  it("只有对应新 user 之后的回复才通过", () => {
    expect(
      hasAssistantReplyForUserTurn(
        [
          { role: "assistant", text: "SAME_REPLY" },
          { role: "user", text: "FOLLOW:turn-1:" },
          { role: "assistant", text: "SAME_REPLY" },
        ],
        "FOLLOW:turn-1:",
        "SAME_REPLY",
      ),
    ).toBe(true);
  });
  it("重复 user 或另一条输入之后的回复不能算当前回合成功", () => {
    expect(
      hasAssistantReplyForUserTurn(
        [
          { role: "user", text: "FOLLOW:turn-1:" },
          { role: "user", text: "FOLLOW:turn-1:" },
          { role: "assistant", text: "SAME_REPLY" },
        ],
        "FOLLOW:turn-1:",
        "SAME_REPLY",
      ),
    ).toBe(false);
    expect(
      hasAssistantReplyForUserTurn(
        [
          { role: "user", text: "FOLLOW:turn-1:" },
          { role: "user", text: "ANOTHER_TURN" },
          { role: "assistant", text: "SAME_REPLY" },
        ],
        "FOLLOW:turn-1:",
        "SAME_REPLY",
      ),
    ).toBe(false);
  });
});
