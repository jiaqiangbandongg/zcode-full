/** 两端按实际用户行对账，不能用整页正文（标题/侧栏也会出现同一 prompt）计数。 */
export function readV4UserMessagesInBrowser(
  paneTestId: string,
): Array<{ id: string; text: string }> {
  const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
  return Array.from(pane?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
    .filter((row) => row.getClientRects().length > 0 && row.classList.contains("group/user-row"))
    .map((row) => ({
      id: row.getAttribute("data-row-id") ?? "",
      text: row.innerText.replace(/\u00a0/gu, " ").trim(),
    }));
}
