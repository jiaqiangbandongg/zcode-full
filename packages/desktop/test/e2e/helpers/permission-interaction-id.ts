import { TID_TOOL_SUMMARY_TRIGGER, testId } from "@zcode/shared/test-ids";

export const PERMISSION_INTERACTION_PREFIX = testId(TID_TOOL_SUMMARY_TRIGGER, "permission:");

/** 只读权限工具摘要携带的真实 requestId，不将通用对话框 test id 当成请求身份。 */
export function readPermissionInteractionIdsInBrowser(prefix: string): string[] {
  const ids = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => node.dataset.testid ?? "")
    .filter((id) => id.startsWith(prefix) && id.length > prefix.length)
    .map((id) => id.slice(prefix.length));
  return [...new Set(ids)];
}

export async function waitForPermissionInteractionId(caseMarker: string): Promise<string> {
  let ids: string[] = [];
  await browser.waitUntil(
    async () => {
      ids = await browser.execute(
        readPermissionInteractionIdsInBrowser,
        PERMISSION_INTERACTION_PREFIX,
      );
      return ids.length === 1;
    },
    { timeout: 30_000, timeoutMsg: `${caseMarker}: 没有唯一可见的权限请求 ID` },
  );
  return ids[0]!;
}
