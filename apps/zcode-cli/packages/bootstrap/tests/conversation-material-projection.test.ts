import { describe, expect, it } from "vitest";
import { buildUserInputRow } from "../src/zcode-protocol-v4/projection-rows.js";

describe("conversation material projection", () => {
  it.each(["", "weather?"])("keeps model-only bot instructions out of visible body %j", (text) => {
    const source = { botId: "bot", chatId: "chat", provider: "feishu" as const };
    const row = buildUserInputRow(
      { rowId: 1, turnId: "turn", createdAt: 1, createdAtSeq: 1 },
      {
        input: "expanded model material",
        intent: { kind: "sendText", text, botGroupSource: source },
      },
    );
    expect(row.text).toBe(text);
    expect(row.botGroupSource).toEqual(source);
    expect(row.conversationQuotes).toBeUndefined();
  });
});
