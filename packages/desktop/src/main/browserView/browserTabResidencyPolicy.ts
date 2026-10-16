export const BROWSER_TAB_LIMIT = 32;

export type BrowserTabResidency =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

export interface BrowserTabResidencyCandidate {
  tabId: string;
  windowId: number;
  sessionId: string;
  residency: BrowserTabResidency;
  /** 物理 guest 已 attach 且未 destroyed；logical residency 不能替代此事实。 */
  guestAttached: boolean;
  openedAt: number;
  lastActivityAt: number;
  lastSelectedAt: number | null;
  /** 当前任务最近一次被选择的主 tab；同一 window/session 至多一个。 */
  preferred: boolean;
  currentTask: boolean;
  selected: boolean;
  visible: boolean;
  operationActive: boolean;
  captureActive: boolean;
  audible: boolean;
  mediaActive: boolean;
  loading: boolean;
  downloadActive: boolean;
}

export interface BrowserTabResidencySelectionOptions {
  windowId: number;
  tabLimit?: number;
}

export function isBrowserTabResidencyProtected(candidate: BrowserTabResidencyCandidate): boolean {
  // 产品边界：preferred 只用于恢复默认选中，不提供 30 分钟豁免；达到逻辑 tab
  // 上限时，只有用户可见或正在运行的状态受保护，suspended shell 也可以被直接关闭。
  return (
    candidate.residency === "live-visible" ||
    candidate.residency === "restoring" ||
    candidate.residency === "suspend-pending" ||
    candidate.selected ||
    candidate.visible ||
    candidate.operationActive ||
    candidate.captureActive ||
    candidate.audible ||
    candidate.mediaActive ||
    candidate.loading ||
    candidate.downloadActive
  );
}

export function selectBrowserTabLimitVictim(
  candidates: readonly BrowserTabResidencyCandidate[],
  options: BrowserTabResidencySelectionOptions,
): BrowserTabResidencyCandidate | null {
  const tabLimit = options.tabLimit ?? BROWSER_TAB_LIMIT;
  const windowCandidates = candidates.filter(
    (candidate) => candidate.windowId === options.windowId,
  );
  if (windowCandidates.length <= tabLimit) return null;

  const eligible = windowCandidates.filter(
    (candidate) => !isBrowserTabResidencyProtected(candidate),
  );
  eligible.sort((left, right) => {
    const activityDelta = left.lastActivityAt - right.lastActivityAt;
    if (activityDelta !== 0) return activityDelta;
    const selectionDelta =
      (left.lastSelectedAt ?? Number.NEGATIVE_INFINITY) -
      (right.lastSelectedAt ?? Number.NEGATIVE_INFINITY);
    if (selectionDelta !== 0) return selectionDelta;
    const openedDelta = left.openedAt - right.openedAt;
    if (openedDelta !== 0) return openedDelta;
    return left.tabId.localeCompare(right.tabId);
  });
  return eligible[0] ?? null;
}
