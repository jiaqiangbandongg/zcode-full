import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  v4ConversationPlansParamsSchema,
  v4ConversationPlansResultSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("v4 conversation plans query", () => {
  it("declares a strict read-only session query", () => {
    expect(V4_METHODS.conversationPlans).toBe("v4/conversation/plans");
    expect(v4ConversationPlansParamsSchema.parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
    });
    expect(() =>
      v4ConversationPlansParamsSchema.parse({ sessionId: "session-1", workspacePath: "/repo" }),
    ).toThrow();
  });

  it("validates the authoritative rows and freshness watermarks", () => {
    const result = {
      plans: [
        {
          rowId: 7,
          turnId: "turn-1",
          createdAt: 1_700_000_000_000,
          createdAtSeq: 7,
          kind: "toolCall" as const,
          toolCallId: "plan-7",
          toolName: "ExitPlanMode",
          status: "success" as const,
          input: { plan: "# 计划" },
          inputText: JSON.stringify({ plan: "# 计划" }),
        },
      ],
      atSeq: 12,
      atLogEpoch: "epoch-1",
    };

    expect(v4ConversationPlansResultSchema.parse(result)).toEqual(result);
    expect(() =>
      v4ConversationPlansResultSchema.parse({ ...result, atSeq: -1 }),
    ).toThrow();
  });
});
