import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "../src/model/index.js";

describe("Anthropic canonical reasoning replay", () => {
  it("does not synthesize thinking for tool-call history without reasoning", () => {
    const toolCallId = "call_anthropic_plain";
    const messages = toAiSdkMessages(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: toolCallId, name: "Read", input: { file_path: "README.md" } }],
        },
      ],
      {
        providerKind: "anthropic",
      },
    );

    expect((messages[0] as any).content).toEqual([
      {
        type: "tool-call",
        toolCallId,
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
  });
});
