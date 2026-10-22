import { describe, expect, it } from "vitest";
import {
  conversationShareContentBlockSchema,
  decodeConversationShareContentBlocks,
} from "../src/conversation-share-content.js";

const block = {
  id: "share-content-1",
  type: "workflow",
  version: 1,
  product_turn_id: "share-product-turn-1",
  fallback_row_id: 3,
  captured_at: 1,
  resource_ids: [],
  payload: { name: "军棋", completion: true, artifacts: [] },
};
describe("公开内容块", () => {
  it("v2 文档正文有字节上限，v1 不接受该扩展", () => {
    const artifact = {
      id: "doc",
      resource_id: "share-artifact-1",
      kind: "markdown",
      title: "报告",
      version: 1,
      content_type: "text/markdown",
      preview_text: "# Frozen report",
    };
    const extended = { ...block, version: 2, payload: { ...block.payload, artifacts: [artifact] } };
    expect(conversationShareContentBlockSchema.safeParse(extended).success).toBe(true);
    expect(conversationShareContentBlockSchema.safeParse({ ...extended, version: 1 }).success).toBe(
      false,
    );
    expect(
      conversationShareContentBlockSchema.safeParse({
        ...extended,
        payload: {
          ...extended.payload,
          artifacts: [{ ...artifact, preview_text: "中".repeat(25000) }],
        },
      }).success,
    ).toBe(false);
  });
  it("已知块严格校验，未知块独立降级", () => {
    expect(conversationShareContentBlockSchema.parse(block)).toEqual(block);
    expect(decodeConversationShareContentBlocks([block, { ...block, version: 99 }])).toEqual([
      block,
    ]);
    expect(
      conversationShareContentBlockSchema.safeParse({
        ...block,
        payload: { ...block.payload, sessionId: "private" },
      }).success,
    ).toBe(false);
  });
  it("看板禁止可执行字段和本地引用", () => {
    const artifact = {
      id: "board",
      title: "进度",
      kind: "board",
      version: 1,
      spec: { key: "id", status: "status", columns: ["done"] },
      items: [{ sequence: 1, siteId: "report", ordinal: 1, item: { id: "a", status: "done" } }],
    };
    expect(
      conversationShareContentBlockSchema.safeParse({
        ...block,
        payload: { ...block.payload, artifacts: [artifact] },
      }).success,
    ).toBe(true);
    expect(
      conversationShareContentBlockSchema.safeParse({
        ...block,
        payload: {
          ...block.payload,
          artifacts: [{ ...artifact, spec: { ...artifact.spec, onClick: "execute" } }],
        },
      }).success,
    ).toBe(false);
    expect(
      conversationShareContentBlockSchema.safeParse({
        ...block,
        payload: {
          ...block.payload,
          artifacts: [
            {
              ...artifact,
              items: [{ sequence: 1, siteId: "report", ordinal: 1, item: "file:///secret" }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
