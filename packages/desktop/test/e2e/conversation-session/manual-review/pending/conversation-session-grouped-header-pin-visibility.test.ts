import { TID_TASK_ITEM, TID_WORKSPACE_MORE_BUTTON, testId } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  PROVIDER_READINESS_HISTORY_SESSION_ID,
  PROVIDER_READINESS_HISTORY_TITLE,
} from "../../../helpers/provider-readiness-history-fixture.js";
import { selectV4TaskById } from "../../../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 120_000;
const GROUP_LABELS = ["Group", "分组"];
const PIN_LABELS = ["Pin task", "置顶任务"];
const UNPIN_LABELS = ["Unpin task", "取消置顶任务"];
const PINNED_SECTION_LABELS = ["Pinned", "已置顶"];

interface GroupedPinSnapshot {
  membershipKinds: string[];
  pinnedSectionVisible: boolean;
  taskPresentInCache: boolean;
  taskRowCount: number;
  taskRowTexts: string[];
}

describe("TSL27：Group 里从 Header 置顶后任务仍可见", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Header 置顶把唯一任务移入已置顶区，取消置顶后回到 grouped 主体", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await waitForTestIdByDom(testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID), {
      timeout: 30_000,
      timeoutMsg: "TSL27 预置任务没有出现在 Project 列表",
    });
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    await activateGroupView();

    await waitForGroupedPinState(false, "进入 Group 后预置任务没有保持普通 membership");

    await clickHeaderTaskAction(PIN_LABELS);
    await waitForGroupedPinState(true, "Header 置顶后任务没有唯一地移动到 Group 页的已置顶区");

    await clickHeaderTaskAction(UNPIN_LABELS);
    await waitForGroupedPinState(false, "Header 取消置顶后任务没有回到 Group 主体");
  });
});

async function activateGroupView() {
  const tabs = await $$('[role="tab"]');
  const groupTab = await findElementByLabels(tabs, GROUP_LABELS);
  if (!groupTab) {
    throw new Error("侧栏没有可用的 Group 视图入口");
  }
  // Bug 根因：Radix Tabs 依赖真实 pointer/click 事件序列；直接调用 DOM click()
  // 不会稳定触发 onValueChange。E2E 必须走 WebDriver 点击，才能覆盖用户真实交互链路。
  await groupTab.click();
  await browser.waitUntil(
    () =>
      browser.execute(
        (title) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-grouped-task-key]")).some(
            (row) => (row.textContent ?? "").includes(title),
          ),
        PROVIDER_READINESS_HISTORY_TITLE,
      ),
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: "侧栏没有切换到 Group 视图或预置任务没有进入 grouped 主体",
    },
  );
}

async function clickHeaderTaskAction(labels: string[]) {
  const moreButton = $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`);
  await moreButton.waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: "Workspace Header 更多菜单入口不可见",
  });
  await moreButton.click();
  let menuItemIndex = -1;
  await browser.waitUntil(
    async () => {
      const menuItems = await $$('[role="menuitem"]');
      for await (const [index, item] of menuItems.entries()) {
        if (
          labels.includes((await item.getText()).trim()) &&
          (await item.isDisplayed()) &&
          (await item.isEnabled())
        ) {
          menuItemIndex = index;
          return true;
        }
      }
      return false;
    },
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: `Workspace Header 菜单没有可点击动作: ${labels.join("/")}`,
    },
  );
  const menuItem = (await $$('[role="menuitem"]'))[menuItemIndex];
  if (!menuItem) {
    throw new Error(`Workspace Header 菜单动作挂载后消失: ${labels.join("/")}`);
  }
  await menuItem.click();
}

async function findElementByLabels(elements: ReturnType<typeof $$>, labels: readonly string[]) {
  for (const element of elements) {
    if (labels.includes((await element.getText()).trim()) && (await element.isDisplayed())) {
      return element;
    }
  }
  return null;
}

async function waitForGroupedPinState(expectedPinned: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    async () => {
      const snapshot = await readGroupedPinSnapshot();
      const cacheMatches = expectedPinned
        ? snapshot.membershipKinds.includes("pinned") &&
          !snapshot.membershipKinds.includes("workspace")
        : !snapshot.membershipKinds.includes("pinned") &&
          snapshot.membershipKinds.includes("workspace");
      return (
        snapshot.taskPresentInCache &&
        snapshot.taskRowCount === 1 &&
        snapshot.pinnedSectionVisible === expectedPinned &&
        cacheMatches
      );
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${timeoutMsg}: ${JSON.stringify(await readGroupedPinSnapshot())}`,
    },
  );

  const snapshot = await readGroupedPinSnapshot();
  expect(snapshot.taskRowCount).toBe(1);
  expect(snapshot.taskRowTexts[0]).toContain(PROVIDER_READINESS_HISTORY_TITLE);
  expect(snapshot.pinnedSectionVisible).toBe(expectedPinned);
  expect(snapshot.taskPresentInCache).toBe(true);
  expect(snapshot.membershipKinds.includes("pinned")).toBe(expectedPinned);
}

function readGroupedPinSnapshot(): Promise<GroupedPinSnapshot> {
  return browser.execute(
    (taskItemTestId, taskTitle, pinnedSectionLabels, workspacePath, taskId) => {
      const isVisible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const standardTaskRows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${taskItemTestId}"]`),
      ).filter(isVisible);
      const groupedTaskRows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-grouped-task-key]"),
      ).filter((row) => isVisible(row) && (row.textContent ?? "").includes(taskTitle));
      const taskRows = [...new Set([...standardTaskRows, ...groupedTaskRows])];
      const pinnedSectionVisible = Array.from(document.querySelectorAll<HTMLElement>("h3")).some(
        (heading) =>
          isVisible(heading) && pinnedSectionLabels.includes((heading.textContent ?? "").trim()),
      );
      const membershipProbe = (
        window as Window & {
          __testActions?: {
            getTaskListMembershipProbe?: (params: { workspacePath: string; taskId: string }) => {
              membershipKinds: string[];
              taskPresent: boolean;
            };
          };
        }
      ).__testActions?.getTaskListMembershipProbe?.({
        workspacePath,
        taskId,
      });

      return {
        membershipKinds: membershipProbe?.membershipKinds ?? [],
        pinnedSectionVisible,
        taskPresentInCache: membershipProbe?.taskPresent ?? false,
        taskRowCount: taskRows.length,
        taskRowTexts: taskRows.map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim()),
      };
    },
    testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID),
    PROVIDER_READINESS_HISTORY_TITLE,
    PINNED_SECTION_LABELS,
    DEFAULT_WORKSPACE,
    PROVIDER_READINESS_HISTORY_SESSION_ID,
  );
}
