import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { buildConversationShareItems } from "@/v4/conversationShareItems.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
const raw = JSON.parse(
  await readFile(
    new URL("../../services/test/fixtures/share-workflow-parity-rows.json", import.meta.url),
    "utf8",
  ),
);
const units = buildConversationTurnRenderUnits(
  raw.map((row: unknown) => conversationRowSchema.parse(row)),
);
const options = {
  assistantEmptyPreview: "empty",
  assistantRunningPreview: "running",
  userFallbackPreview: "user",
};
it("真实完成轮没有 realUser 气泡，但分享全选仍包含它；普通导航不变", () => {
  expect(buildConversationTurnNavigatorItems(units, options)).toHaveLength(2);
  const items = buildConversationShareItems(units, options);
  expect(items).toHaveLength(3);
  expect(items[1]).toMatchObject({ rowId: 16, isRunning: false });
});
