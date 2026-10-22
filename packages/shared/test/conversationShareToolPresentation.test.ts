import { describe, expect, it } from "vitest";
import {
  conversationShareContentBlockSchema,
  decodeConversationShareContentBlocks,
} from "../src/conversation-share-content.js";
const block = {
  id: "share-content-1",
  type: "tool-presentation",
  version: 1,
  product_turn_id: "share-product-turn-1",
  fallback_row_id: 2,
  captured_at: 1,
  resource_ids: [],
  payload: { display: { kind: "bash_output", output: "hello", truncated: false } },
};
describe("share tool presentation contract", () => {
  it("accepts a typed tool snapshot and leaves the V1 row independent", () =>
    expect(conversationShareContentBlockSchema.safeParse(block).success).toBe(true));
  it("rejects runtime output paths, plugin UI and raw metadata", () => {
    for (const payload of [
      {
        display: {
          kind: "bash_output",
          output: "hello",
          truncated: false,
          outputPath: "/Users/dev/log",
        },
      },
      { raw: {} },
      {
        display: {
          kind: "mcp_tool",
          serverName: "example",
          toolName: "test",
          ui: { resourceUri: "ui://app" },
        },
      },
    ])
      expect(conversationShareContentBlockSchema.safeParse({ ...block, payload }).success).toBe(
        false,
      );
  });
  it("rejects unclosed image references and falls back on unknown versions", () => {
    expect(
      conversationShareContentBlockSchema.safeParse({
        ...block,
        payload: { images: [{ resource_id: "share-artifact-1", mime_type: "image/png" }] },
      }).success,
    ).toBe(false);
    expect(decodeConversationShareContentBlocks([{ ...block, version: 99 }])).toEqual([]);
  });
});
