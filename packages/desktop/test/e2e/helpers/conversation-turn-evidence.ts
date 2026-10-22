interface ConversationMessageEvidence {
  role: "user" | "assistant";
  text: string;
}

/** 只接受本次唯一 user 行之后、下一 user 行之前的回复，排除历史同文案。 */
export function hasAssistantReplyForUserTurn(
  rows: readonly ConversationMessageEvidence[],
  userMarker: string,
  replyMarker: string,
): boolean {
  const matches = rows.flatMap((row, index) =>
    row.role === "user" && row.text.includes(userMarker) ? [index] : [],
  );
  if (matches.length !== 1) return false;
  for (const row of rows.slice(matches[0]! + 1)) {
    if (row.role === "user") return false;
    if (row.text.includes(replyMarker)) return true;
  }
  return false;
}
