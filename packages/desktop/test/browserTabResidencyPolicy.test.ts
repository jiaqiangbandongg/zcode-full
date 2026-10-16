import { describe, expect, it } from "vitest";
import {
  BROWSER_TAB_LIMIT,
  selectBrowserTabLimitVictim,
  type BrowserTabResidencyCandidate,
} from "../src/main/browserView/browserTabResidencyPolicy.js";

function candidate(
  tabId: string,
  overrides: Partial<BrowserTabResidencyCandidate> = {},
): BrowserTabResidencyCandidate {
  return {
    tabId,
    windowId: 1,
    sessionId: "task-a",
    residency: "live-background",
    guestAttached: true,
    openedAt: 1,
    lastActivityAt: 1,
    lastSelectedAt: null,
    preferred: false,
    currentTask: false,
    selected: false,
    visible: false,
    operationActive: false,
    captureActive: false,
    audible: false,
    mediaActive: false,
    loading: false,
    downloadActive: false,
    ...overrides,
  };
}

describe("Browser tab residency policy", () => {
  it("BTL04: 第 33 个逻辑 tab 出现时忽略 task/preferred 身份并选择最老 victim", () => {
    const tabs = Array.from({ length: BROWSER_TAB_LIMIT + 1 }, (_, index) =>
      candidate(`tab-${String(index).padStart(2, "0")}`, {
        openedAt: index + 2,
        lastActivityAt: index + 2,
      }),
    );
    tabs[0] = candidate("oldest-preferred-within-former-protection-window", {
      lastActivityAt: 0,
      lastSelectedAt: 19_999,
      preferred: true,
    });
    tabs[1] = candidate("current-task-secondary", {
      currentTask: true,
      lastActivityAt: 1,
    });

    expect(
      selectBrowserTabLimitVictim(tabs, {
        windowId: 1,
      })?.tabId,
    ).toBe("oldest-preferred-within-former-protection-window");
  });

  it("BTL04: preferred tab 即使刚选择过也不再获得常驻保护", () => {
    const tabs = Array.from({ length: BROWSER_TAB_LIMIT + 1 }, (_, index) =>
      candidate(`tab-${index}`, {
        openedAt: index,
        lastActivityAt: index,
        lastSelectedAt: 20_000 + index,
        preferred: true,
      }),
    );

    expect(
      selectBrowserTabLimitVictim(tabs, {
        windowId: 1,
      })?.tabId,
    ).toBe("tab-0");
  });

  it("BTL05: 所有候选都处于运行态保护时允许暂时超额", () => {
    const protectedTabs = Array.from({ length: BROWSER_TAB_LIMIT + 1 }, (_, index) =>
      candidate(`protected-${index}`, { operationActive: true }),
    );

    expect(
      selectBrowserTabLimitVictim(protectedTabs, {
        windowId: 1,
      }),
    ).toBeNull();
  });

  it("保护可见、选中、操作、捕获、声音、媒体、加载和下载中的 tab", () => {
    const protectedVariants: Array<Partial<BrowserTabResidencyCandidate>> = [
      { visible: true, residency: "live-visible" },
      { selected: true },
      { operationActive: true },
      { captureActive: true },
      { audible: true },
      { mediaActive: true },
      { loading: true },
      { downloadActive: true },
      { residency: "restoring" },
    ];
    const tabs = [
      ...protectedVariants.map((overrides, index) => candidate(`protected-${index}`, overrides)),
      ...Array.from({ length: BROWSER_TAB_LIMIT + 1 }, (_, index) =>
        candidate(`eligible-${index}`, { lastActivityAt: index }),
      ),
    ];

    expect(
      selectBrowserTabLimitVictim(tabs, {
        windowId: 1,
      })?.tabId,
    ).toBe("eligible-0");
  });

  it("每个 BrowserWindow 独立计数，visible tab 也占逻辑 tab 上限", () => {
    const firstWindow = Array.from({ length: BROWSER_TAB_LIMIT - 1 }, (_, index) =>
      candidate(`first-${index}`),
    );
    const secondWindow = Array.from({ length: BROWSER_TAB_LIMIT }, (_, index) =>
      candidate(`second-${index}`, { windowId: 2 }),
    );
    const visible = candidate("visible", {
      residency: "live-visible",
      selected: true,
      visible: true,
    });

    expect(
      selectBrowserTabLimitVictim([...firstWindow, ...secondWindow, visible], {
        windowId: 1,
      }),
    ).toBeNull();
    expect(
      selectBrowserTabLimitVictim(
        [...firstWindow, ...secondWindow, { ...visible, tabId: "visible-2", windowId: 2 }],
        {
          windowId: 2,
        },
      )?.tabId,
    ).toBe("second-0");
  });

  it("BTL20: suspended 或 detached logical shell 仍计入上限并可成为最老 victim", () => {
    const tabs = [
      candidate("suspended-oldest", {
        residency: "suspended",
        guestAttached: false,
        openedAt: 0,
        lastActivityAt: 0,
      }),
      candidate("live-a", { openedAt: 1, lastActivityAt: 1 }),
      candidate("live-b", { openedAt: 2, lastActivityAt: 2 }),
    ];

    expect(
      selectBrowserTabLimitVictim(tabs, {
        tabLimit: 2,
        windowId: 1,
      })?.tabId,
    ).toBe("suspended-oldest");
  });
});
