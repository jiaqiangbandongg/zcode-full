import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { PROVIDER_READINESS_HISTORY_SESSION_ID } from "../../../helpers/provider-readiness-history-fixture.js";

const DELETE_ALL = "delete-all-archived-tasks";
const ARCHIVED_ACTIONS = "archived-tasks-actions";

describe("TSL39：一键删除全部归档任务", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("取消不写入，确认删除全部 25 条并保留普通任务和 CLI 会话", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const original = readCounts();
    expect(readCliSessionCount()).toBe(1);
    expect(original.archived).toBe(25);
    expect(original.active).toBe(1);
    expect(await $(`[data-testid="${ARCHIVED_ACTIONS}"]`).isExisting()).toBe(false);
    const opened = await browser.execute(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
      ).find((node) => ["Archived", "归档"].includes(node.getAttribute("aria-label") ?? ""));
      button?.click();
      return Boolean(button);
    });
    expect(opened).toBe(true);
    await $(`[data-testid="${ARCHIVED_ACTIONS}"]`).waitForDisplayed({ timeout: 15_000 });
    expect(
      await browser.execute(() =>
        Boolean(
          document.querySelector(
            '[data-testid="archived-tasks-toolbar-actions"] [data-testid="archived-tasks-actions"]',
          ),
        ),
      ),
    ).toBe(true);
    expect(await $(`[data-testid="${DELETE_ALL}"]`).isExisting()).toBe(false);
    await clickArchiveActions();
    await $(`[data-testid="${DELETE_ALL}"]`).waitForDisplayed();
    expect(readCounts()).toEqual(original);
    await browser.saveScreenshot(
      join(process.cwd(), ".e2e-artifacts", "archived-tasks-more-menu.png"),
    );
    await $(`[data-testid="${DELETE_ALL}"]`).click();
    await browser.waitUntil(async () => (await $("[role='dialog']").getText()).includes("25"));
    await browser.saveScreenshot(
      join(process.cwd(), ".e2e-artifacts", "delete-all-archived-confirm.png"),
    );
    await browser.keys("Escape");
    // 取消后旧 Dialog 会保留到退出动画结束；必须等它卸载，避免下一次确认点中旧按钮。
    await $("[role='dialog']").waitForExist({ reverse: true, timeout: 10_000 });
    expect(readCounts()).toEqual(original);

    await clickArchiveActions();
    await $(`[data-testid="${DELETE_ALL}"]`).waitForDisplayed();
    await $(`[data-testid="${DELETE_ALL}"]`).click();
    await browser.waitUntil(async () => (await $("[role='dialog']").getText()).includes("25"));
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 15_000 });
    await browser.waitUntil(() => readCounts().archived === 0, { timeout: 30_000 });
    await browser.waitUntil(
      async () => !(await $(`[data-testid="${ARCHIVED_ACTIONS}"]`).isEnabled()),
      {
        timeout: 15_000,
      },
    );
    expect(readCounts()).toEqual({ ...original, archived: 0, deleted: 25 });
    expect(readCliSessionCount()).toBe(1);
    expect(await $("body").getText()).toMatch(/暂无归档任务|No archived tasks/);
    await browser.saveScreenshot(
      join(process.cwd(), ".e2e-artifacts", "delete-all-archived-tasks.png"),
    );
  });
});

async function clickArchiveActions() {
  await $(`[data-testid="${ARCHIVED_ACTIONS}"]`).waitForEnabled({ timeout: 15_000 });
  // ChromeDriver element.click 会把侧栏 overflow-hidden 容器横移 65px；
  // 使用真实键盘菜单路径并阻止测试聚焦滚动，避免自动化截图混入该滚动伪影。
  await browser.execute((testId) => {
    document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
      .focus({ preventScroll: true });
  }, ARCHIVED_ACTIONS);
  await browser.keys("ArrowDown");
}

function readCounts() {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(`SELECT
      sum(archived = 1 AND deleted = 0) AS archived,
      sum(deleted = 1) AS deleted,
      sum(task_id = 'bulk-delete-active-control' AND deleted = 0 AND archived = 0) AS active
      FROM tasks`)
      .get() as { archived: number; deleted: number; active: number };
    return row;
  } finally {
    database.close();
  }
}

function readCliSessionCount() {
  const database = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    return (
      database
        .prepare("SELECT count(*) AS count FROM session WHERE id = ?")
        .get(PROVIDER_READINESS_HISTORY_SESSION_ID) as { count: number }
    ).count;
  } finally {
    database.close();
  }
}
