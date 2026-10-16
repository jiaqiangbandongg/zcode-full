import { TID_TASK_ITEM, TID_WORKSPACE_ITEM, testId } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  ensureWorkspaceItemExpanded,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_ID,
  TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_TITLE,
  TASK_INDEX_ROW_AUTHORITY_TASK_IDS,
  TASK_INDEX_ROW_AUTHORITY_TOTAL,
} from "../../../helpers/task-list-row-authority-fixture.js";

const CASE_TIMEOUT_MS = 120_000;
const SHOW_MORE_LABELS = ["Show more", "显示更多"];

describe("TSL23：tasks-index 是 Project 持久任务行权威", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("冷启动 sessions-index 只有一个摘要时仍分页展示 25 个持久任务", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await ensureWorkspaceItemExpanded(DEFAULT_WORKSPACE);
    await waitForAuthorityTaskCount(5, "Project 首屏没有显示 5 个 tasks-index 任务");

    let visibleCount = await readAuthorityTaskIds().then((ids) => ids.length);
    while (visibleCount < TASK_INDEX_ROW_AUTHORITY_TOTAL) {
      const clicked = await clickWorkspaceShowMore();
      expect(clicked).toBe(true);
      const previousCount = visibleCount;
      await browser.waitUntil(
        async () => {
          visibleCount = await readAuthorityTaskIds().then((ids) => ids.length);
          return visibleCount > previousCount;
        },
        {
          timeout: 15_000,
          timeoutMsg: `Project 点击显示更多后任务数没有增长: previous=${previousCount}`,
        },
      );
    }

    const visibleTaskIds = await readAuthorityTaskIds();
    expect(visibleTaskIds).toHaveLength(TASK_INDEX_ROW_AUTHORITY_TOTAL);
    expect(new Set(visibleTaskIds).size).toBe(TASK_INDEX_ROW_AUTHORITY_TOTAL);
    expect(new Set(visibleTaskIds)).toEqual(new Set(TASK_INDEX_ROW_AUTHORITY_TASK_IDS));

    const missingSummaryRow = await browser.execute(
      (taskItemTestId) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${taskItemTestId}"]`);
        return {
          exists: Boolean(row),
          hasLoadingIndicator: Boolean(row?.querySelector(".animate-spin")),
          text: row?.textContent?.trim() ?? "",
        };
      },
      testId(TID_TASK_ITEM, TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_ID),
    );
    expect(missingSummaryRow.exists).toBe(true);
    expect(missingSummaryRow.text).toContain(TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_TITLE);
    // Bug 根因：tasks-index 里的历史 running 只是一份持久 meta；没有 sessions-index
    // 实时摘要时不能把它解释成当前仍在运行的 spinner。
    expect(missingSummaryRow.hasLoadingIndicator).toBe(false);
  });
});

async function waitForAuthorityTaskCount(expected: number, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readAuthorityTaskIds()).length >= expected, {
    timeout: 45_000,
    timeoutMsg,
  });
}

function readAuthorityTaskIds(): Promise<string[]> {
  return browser.execute(
    (taskIds, taskItemPrefix) => {
      const visibleTestIds = new Set(
        Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid^="${taskItemPrefix}-"]`),
        ).map((element) => element.dataset.testid ?? ""),
      );
      return taskIds.filter((taskId) => visibleTestIds.has(`${taskItemPrefix}-${taskId}`));
    },
    TASK_INDEX_ROW_AUTHORITY_TASK_IDS,
    TID_TASK_ITEM,
  );
}

function clickWorkspaceShowMore(): Promise<boolean> {
  return browser.execute(
    (workspaceTestId, labels) => {
      const workspaceRow = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === workspaceTestId,
      );
      const workspaceListItem = workspaceRow?.closest("li");
      const showMore = Array.from(
        workspaceListItem?.querySelectorAll<HTMLElement>("span") ?? [],
      ).find((element) => labels.includes((element.textContent ?? "").trim()));
      showMore?.click();
      return Boolean(showMore);
    },
    testId(TID_WORKSPACE_ITEM, DEFAULT_WORKSPACE),
    SHOW_MORE_LABELS,
  );
}
