import { TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared";

export type ConversationToolGroupName =
  | "Explore"
  | "ExecuteGroup"
  | "ChangesGroup";

export interface ConversationToolGroupSnapshot {
  childCount: number;
  expanded: boolean;
  status: string | null;
  summaryText: string;
  text: string;
  toolCallId: string;
  toolName: ConversationToolGroupName;
}

export function listConversationToolGroups(): Promise<
  ConversationToolGroupSnapshot[]
> {
  return browser.execute((summaryPrefix) => {
    const groupNames = new Set(["Explore", "ExecuteGroup", "ChangesGroup"]);
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-tool-call-id][data-tool-name]"),
    )
      .filter((block) => groupNames.has(block.dataset.toolName ?? ""))
      .map((block) => {
        const trigger = block.querySelector<HTMLElement>(
          `[data-testid^="${summaryPrefix}-"]`,
        );
        const childCount = Array.from(
          block.querySelectorAll<HTMLElement>("[data-tool-call-id]"),
        ).filter((child) => child !== block).length;
        return {
          childCount,
          expanded: trigger?.getAttribute("aria-expanded") === "true",
          status: block.dataset.status ?? null,
          summaryText: (trigger?.innerText ?? "").replace(/\u00a0/g, " ").trim(),
          text: block.innerText.replace(/\u00a0/g, " ").trim(),
          toolCallId: block.dataset.toolCallId ?? "",
          toolName: block.dataset.toolName as ConversationToolGroupName,
        };
      });
  }, TID_TOOL_SUMMARY_TRIGGER);
}

export async function waitForConversationToolGroup(
  toolName: ConversationToolGroupName,
  predicate: (snapshot: ConversationToolGroupSnapshot) => boolean,
  failureMessage: string,
  timeout = 30000,
): Promise<ConversationToolGroupSnapshot> {
  let latest: ConversationToolGroupSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = (await listConversationToolGroups())
        .filter((group) => group.toolName === toolName)
        .at(-1) ?? null;
      return latest !== null && predicate(latest);
    },
    {
      timeout,
      timeoutMsg: `${failureMessage}; latest=${JSON.stringify(latest)}`,
    },
  );
  if (!latest) throw new Error(`${failureMessage}; group missing`);
  return latest;
}

export async function toggleLatestConversationToolGroup(
  toolName: ConversationToolGroupName,
  targetExpanded: boolean,
): Promise<ConversationToolGroupSnapshot> {
  const clicked = await browser.execute(
    (summaryPrefix, expectedToolName, shouldExpand) => {
      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-tool-name="${expectedToolName}"]`,
        ),
      );
      const block = blocks.at(-1);
      const trigger = block?.querySelector<HTMLElement>(
        `[data-testid^="${summaryPrefix}-"]`,
      );
      if (!trigger) return false;
      const expanded = trigger.getAttribute("aria-expanded") === "true";
      if (expanded !== shouldExpand) trigger.click();
      return true;
    },
    TID_TOOL_SUMMARY_TRIGGER,
    toolName,
    targetExpanded,
  );
  if (!clicked) throw new Error(`没有找到 ${toolName} summary trigger`);
  return waitForConversationToolGroup(
    toolName,
    (snapshot) => snapshot.expanded === targetExpanded,
    `${toolName} 没有切换到 expanded=${targetExpanded}`,
  );
}
