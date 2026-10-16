import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export function resolveNextHighspeedExpiryMs(
  rows: readonly ConversationRow[],
  nowMs: number,
): number | undefined {
  let nextExpiryMs: number | undefined;
  for (const row of rows) {
    if (row.kind !== "userInput" || !row.highspeed || row.highspeed.expiresAt <= nowMs) continue;
    if (nextExpiryMs === undefined || row.highspeed.expiresAt < nextExpiryMs) {
      nextExpiryMs = row.highspeed.expiresAt;
    }
  }
  return nextExpiryMs;
}
