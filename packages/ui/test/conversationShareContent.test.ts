import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { conversationShareContentBlockSchema } from "@zcode/shared";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
const blocks = JSON.parse(
  await readFile(
    new URL("../../services/test/fixtures/share-content-blocks.json", import.meta.url),
    "utf8",
  ),
);
const base = { turnId: "t1", productTurnId: "share-product-turn-1", createdAt: 1 };
const rows: ConversationRow[] = [
  {
    ...base,
    rowId: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  },
  {
    ...base,
    rowId: 2,
    createdAtSeq: 2,
    kind: "assistantText",
    state: "complete",
    text: "ORIGINAL_FINAL_TEXT",
  },
  {
    ...base,
    rowId: 3,
    createdAtSeq: 3,
    kind: "assistantText",
    state: "complete",
    text: "WORKFLOW_FALLBACK",
  },
];
it("完整内容不依赖桌面宿主，正文不被摘要挤进折叠历史", () => {
  expect(conversationShareContentBlockSchema.safeParse(blocks[0]).success).toBe(true);
  const html = renderToStaticMarkup(
    createElement(ConversationShareReadonlyTimeline, { rows, contentBlocks: blocks }),
  );
  expect(html).toContain("ORIGINAL_FINAL_TEXT");
  expect(html).toContain("军棋项目进度看板");
  expect(html).toContain("军棋项目交付报告");
  expect(html).not.toContain("WORKFLOW_FALLBACK");
  expect(html).not.toContain('data-history-open="false"');
});
it("不展示空的不可用工作流卡及本地网站卡，也不恢复其占位摘要", () => {
  const unavailable = {
    ...blocks[0],
    payload: {
      name: "Missing workflow",
      completion: false,
      unavailable: "source_unavailable",
      artifacts: [],
    },
  };
  const input = rows.map((row) =>
    row.rowId === 2 ? { ...row, text: "ORIGINAL_FINAL_TEXT http://127.0.0.1:8080" } : row,
  );
  const html = renderToStaticMarkup(
    createElement(ConversationShareReadonlyTimeline, { rows: input, contentBlocks: [unavailable] }),
  );
  expect(html).toContain("ORIGINAL_FINAL_TEXT");
  expect(html).not.toContain("WORKFLOW_FALLBACK");
  expect(html).not.toContain("data-share-content-block");
  expect(html).not.toContain("data-share-local-website");
  expect(html).not.toContain("Snapshot at sharing");
});
it("未知类型、版本及损坏块不吞掉原位摘要", () => {
  for (const block of [
    { ...blocks[0], type: "future" },
    { ...blocks[0], version: 99 },
    { ...blocks[0], payload: null },
  ]) {
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, { rows, contentBlocks: [block] }),
    );
    expect(html).toContain("WORKFLOW_FALLBACK");
    expect(html).toContain("ORIGINAL_FINAL_TEXT");
  }
});
