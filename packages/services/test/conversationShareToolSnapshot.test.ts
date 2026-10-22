import { describe, expect, it } from "vitest";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
const rows: ConversationRow[] = [
  {
    kind: "turnHeader",
    rowId: 1,
    turnId: "t",
    productTurnId: "p",
    createdAt: 1,
    createdAtSeq: 1,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  },
  {
    kind: "toolCall",
    rowId: 2,
    turnId: "t",
    entityId: "e",
    productTurnId: "p",
    createdAt: 2,
    createdAtSeq: 2,
    toolCallId: "tool",
    toolName: "Bash",
    status: "success",
    inputText: "{}",
    input: { command: "echo hello" },
    output: {
      text: "hello",
      display: {
        kind: "bash_output",
        output: "hello",
        truncated: false,
        outputPath: "/Users/dev/private.log",
      },
    },
  },
];
describe("public tool snapshots", () => {
  it("keeps typed result facts outside the legacy row and strips local output paths", () => {
    const result = buildConversationSharePublicProjection({
      rows,
      selectedProductTurnIds: ["p"],
      toolPresentation: true,
    });
    expect(result.contentBlocks?.[0]).toMatchObject({
      type: "tool-presentation",
      fallback_row_id: 2,
      payload: { display: { kind: "bash_output", output: "hello", truncated: false } },
    });
    expect(JSON.stringify(result)).not.toContain("private.log");
  });
  it("does not change old-server payloads", () =>
    expect(
      buildConversationSharePublicProjection({ rows, selectedProductTurnIds: ["p"] }).contentBlocks,
    ).toBeUndefined());
});
