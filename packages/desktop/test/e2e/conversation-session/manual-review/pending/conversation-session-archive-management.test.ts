import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";

const row = (id: string) => $(`[data-testid="archive-task"][data-task-id="${id}"]`);
const home = process.env.ZCODE_E2E_HOME_DIR!;
const ids = ["arm-alpha", "arm-beta", "arm-scheduled", "arm-loose", "arm-removed"];
function readRow(id: string) {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT archived,cli_deleted,project_id FROM tasks WHERE task_id=?")
      .get(id) as { archived: number; cli_deleted: number; project_id: string | null };
  } finally {
    db.close();
  }
}
async function clearSearch() {
  await $('[data-testid="archive-search"]').click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await browser.keys("Backspace");
}
async function setArchiveGroupsOpen(open: boolean) {
  await waitForArchiveAnimations();
  for (const toggle of await $$('[data-testid="archive-group-toggle"]')) {
    if ((await toggle.getAttribute("aria-expanded")) !== String(open)) {
      // 上一组高度动画会移动下一组的点击位置，等布局稳定再继续逐组操作。
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", String(open));
      await waitForArchiveAnimations();
    }
  }
}
async function waitForArchiveAnimations() {
  await browser.waitUntil(() =>
    browser.execute(() =>
      document
        .querySelector('[data-testid="archive-management"]')!
        .getAnimations({ subtree: true })
        .every((animation) => animation.playState !== "running"),
    ),
  );
}
describe("归档管理", () => {
  before(async function () {
    this.timeout(60000);
    if (!home || !basename(home).startsWith("zcode-archive-e2e-"))
      throw new Error("isolated archive HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
    const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
    try {
      for (const [i, name] of ["E2E 虚拟项目甲", "E2E 虚拟项目乙", "E2E 已移除项目"].entries()) {
        db.prepare(
          "INSERT INTO projects(project_id,host_id,name,position,deleted,created_at,updated_at) VALUES(?,'local',?,?,?,1,1)",
        ).run(`arm-project-${i}`, name, i, i === 2 ? 1 : 0);
        db.prepare(
          "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
        ).run(`arm-project-${i}`, DEFAULT_WORKSPACE);
      }
      const baseTime = Date.now() - 100000;
      for (const [i, id] of ids.entries()) {
        const title = [
          "E2E Alpha " + "long title ".repeat(20),
          "E2E Beta",
          "E2E Scheduled",
          "E2E Unclassified",
          "E2E Removed",
        ][i]!;
        const now = baseTime + i;
        const updated = baseTime + 100 - i;
        // 真实历史 fixture 同时提供 CLI 存在性与 Host 归档组织态；删除必须实际写 CLI 软删除。
        cli
          .prepare(
            "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
          )
          .run(id, "arm-cli-scope", id, DEFAULT_WORKSPACE, title, now, updated);
        db.prepare(
          "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,1,?,'custom',?,?,'completed',0,?)",
        ).run(
          DEFAULT_WORKSPACE,
          DEFAULT_WORKSPACE,
          id,
          title,
          now,
          updated,
          DEFAULT_WORKSPACE,
          i === 3 ? null : `arm-project-${i === 4 ? 2 : i === 1 ? 1 : 0}`,
          title,
          now,
          updated,
          JSON.stringify(i === 2 ? { cronAutomationId: "arm-cron" } : {}),
        );
      }
    } finally {
      db.close();
      cli.close();
    }
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await browser.execute(() => {
      (
        window as typeof window & { __testActions: { setLocale(value: string): void } }
      ).__testActions.setLocale("zh-CN");
    });
    // 通过已存在的设置导航入口打开，再点新分区。
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
  });
  it("ARM08：页面标题与固定文案统一为会话", async () => {
    const heading = $("h2=归档管理");
    await expect(heading).toBeDisplayed();
    await expect($('[data-testid="archive-management"] h2')).toHaveText("已归档的会话");
    await expect($('[data-testid="archive-search"]')).toHaveAttribute(
      "placeholder",
      "搜索已归档会话",
    );
    await expect($('[data-testid="archive-auto-archive-switch"]')).toHaveAttribute(
      "aria-label",
      "自动归档旧会话",
    );
    const main = $('main:has([data-testid="archive-management"])');
    expect(await main.getText()).not.toMatch(/任务|对话|聊天/);
    expect(await main.getText()).toContain("2 个会话");
    const titleAboveSettings = await browser.execute(() => {
      const title = [...document.querySelectorAll("main h2")].find(
        (el) => el.textContent === "归档管理",
      )!;
      const settings = document.querySelector('[data-testid="archive-auto-archive-switch"]')!;
      return title.getBoundingClientRect().bottom < settings.getBoundingClientRect().top;
    });
    expect(titleAboveSettings).toBe(true);
    await $('[data-testid="archive-search"]').setValue("E2E_NO_ARCHIVE_MATCH");
    await expect($('[data-testid="archive-management"]')).toHaveText(
      expect.stringContaining("没有匹配的归档会话"),
    );
    await clearSearch();
    await $('[data-testid="archive-delete-all"]').click();
    const confirmation = $('[data-confirm-intent="archive-management-delete"]');
    await expect(confirmation).toHaveText(expect.stringContaining("删除这 5 个归档会话？"));
    expect(await confirmation.getText()).toContain("只删除当前确认范围内的会话。");
    await browser.keys("Escape");
  });
  it("ARM07：默认 30 天，关闭时可先保存时长，开启与刷新保留选择", async () => {
    await $('[data-testid="settings-section-nav-general"]').click();
    expect(await $('//*[normalize-space(text())="自动归档旧会话"]').isExisting()).toBe(false);
    expect(await $('//*[normalize-space(text())="归档保留时长"]').isExisting()).toBe(false);
    await $('[data-testid="settings-section-nav-archives"]').click();
    const toggle = $('[data-testid="archive-auto-archive-switch"]');
    const days = $('[data-testid="archive-auto-archive-days"]');
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(days).toBeEnabled();
    await expect(days).toHaveText("30 天后归档");
    const placement = await browser.execute(() => ({
      settingsBottom: document
        .querySelector('[data-testid="archive-auto-archive-days"]')!
        .getBoundingClientRect().bottom,
      listTop: document.querySelector('[data-testid="archive-management"]')!.getBoundingClientRect()
        .top,
    }));
    expect(placement.settingsBottom).toBeLessThan(placement.listTop);
    // 先保存时长再开启，避免开关一开就按旧阈值归档。
    await days.click();
    await $('[role="option"]*=7 天后归档').click();
    await expect(days).toHaveText("7 天后归档");
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"));
      return (
        settings.taskAutoArchiveEnabled === false && settings.taskAutoArchiveOlderThanDays === 7
      );
    });
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(days).toBeEnabled();
    await expect(days).toHaveText("7 天后归档");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"))).toMatchObject({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 7,
    });
    await days.click();
    await $('[role="option"]*=14 天后归档').click();
    await expect(days).toHaveText("14 天后归档");
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"));
      return (
        settings.taskAutoArchiveEnabled === true && settings.taskAutoArchiveOlderThanDays === 14
      );
    });
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(days).toHaveText("14 天后归档");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(days).toBeEnabled();
    await expect(days).toHaveText("14 天后归档");
    await days.click();
    await $('[role="option"]*=30 天后归档').click();
    await expect(days).toHaveText("30 天后归档");
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"));
      return (
        settings.taskAutoArchiveEnabled === false && settings.taskAutoArchiveOlderThanDays === 30
      );
    });
    expect(ids.map((id) => readRow(id).archived)).toEqual(ids.map(() => 1));
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "ARM07-disabled-30-days.png"),
    );
  });
  it("ARM01/05/06：分组折叠、搜索、时间排序和项目选择", async () => {
    expect(await $$('[data-testid="archive-group"]').length).toBe(4);
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    const firstGroup = $('[data-testid="archive-group"][data-project-id="arm-project-0"]');
    const toggle = firstGroup.$('[data-testid="archive-group-toggle"]');
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await firstGroup.getText()).toContain("2");
    await toggle.click();
    await row("arm-alpha").waitForDisplayed();
    // 展开只挂载当前组；键盘收起后必须真正移除行，不只是 CSS 隐藏。
    expect(await $$('[data-testid="archive-task"]').length).toBe(2);
    await browser.keys("Enter");
    await row("arm-alpha").waitForExist({ reverse: true });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    await firstGroup.$('[data-testid="archive-group-menu"]').click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    await browser.keys("Escape");
    await setArchiveGroupsOpen(true);
    expect(await $$('[data-testid="archive-task"]').length).toBe(5);
    expect(await $('[data-testid="archive-management"]').getText()).toContain("E2E 虚拟项目甲");
    // 防止将静态标签和业务图标再次塞进触发框，扩大下拉点击区域。
    expect(await $('[data-testid="archive-sort"]').getText()).toBe("更新时间");
    expect(await $('[data-testid="archive-project-filter"]').getText()).toBe("所有项目");
    // 筛选栏只保留搜索图标和两个下拉箭头，不再显示排序/项目装饰图标。
    expect(await $('[data-testid="archive-filters"]').$$("svg").length).toBe(3);
    for (const testId of ["archive-sort", "archive-project-filter"]) {
      expect(await $(`[data-testid="${testId}"]`).$$("svg").length).toBe(1);
    }
    const sortLabel = await browser.execute(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid="archive-sort"]')!;
      const label = trigger.labels?.[0];
      return { text: label?.textContent, outside: Boolean(label && !trigger.contains(label)) };
    });
    expect(sortLabel).toEqual({ text: "排序方式", outside: true });
    await $('[data-testid="archive-project-filter"]').click();
    const options = await $$('[role="option"]');
    expect((await options.map((o) => o.getText())).join("\n")).toContain("E2E 虚拟项目乙");
    expect((await options.map((o) => o.getText())).join("\n")).not.toContain(DEFAULT_WORKSPACE);
    await $('[data-testid="archive-project-option-arm-project-1"]').click();
    expect(await $$('[data-testid="archive-task"]').length).toBe(1);
    expect(await row("arm-beta").isDisplayed()).toBe(true);
    await $('[data-testid="archive-project-filter"]').click();
    await $('[data-testid="archive-project-all"]').click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-1"]')
        .$('[data-testid="archive-group-toggle"]')
        .getAttribute("aria-expanded"),
    ).toBe("true");
    await setArchiveGroupsOpen(true);
    await $('[data-testid="archive-sort"]').click();
    // Radix 异步移动选项焦点；确认焦点后再回车，避免同批按键选中旧项。
    await browser.keys("End");
    await expect($('[data-testid="archive-sort-created"]')).toBeFocused();
    await browser.keys("Enter");
    await expect($('[data-testid="archive-sort"]')).toHaveText("创建时间");
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-0"]')
        .$$('[data-testid="archive-task"]')
        .map((r) => r.getAttribute("data-task-id")),
    ).toEqual(["arm-scheduled", "arm-alpha"]);
    expect(await $('[data-testid="archive-sort"]').getAttribute("aria-label")).toBeTruthy();
    await $('[data-testid="archive-sort"]').click();
    await $('[data-testid="archive-sort-updated"]').click();
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-0"]')
        .$$('[data-testid="archive-task"]')
        .map((r) => r.getAttribute("data-task-id")),
    ).toEqual(["arm-alpha", "arm-scheduled"]);
    await $('[data-testid="archive-search"]').setValue("alpha");
    expect(await $$('[data-testid="archive-task"]').length).toBe(1);
    await clearSearch();
    await captureArchiveLayouts();
    await setArchiveGroupsOpen(true);
  });
  it("ARM02：取消归档、取消删除与确认删除后刷新不复活", async () => {
    await row("arm-alpha").$('[data-testid="archive-unarchive"]').click();
    await row("arm-alpha").waitForExist({ reverse: true });
    expect(readRow("arm-alpha").archived).toBe(0);
    await row("arm-beta").$('[data-testid="archive-delete"]').click();
    await browser.keys("Escape");
    expect(readRow("arm-beta").cli_deleted).toBe(0);
    await row("arm-beta").$('[data-testid="archive-delete"]').click();
    await $('[data-testid="confirm-dialog-confirm"]').click();
    await row("arm-beta").waitForExist({ reverse: true });
    expect(readRow("arm-beta").cli_deleted).toBe(1);
    const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
    try {
      expect(
        (
          cli.prepare("SELECT time_deleted FROM session WHERE id=?").get("arm-beta") as {
            time_deleted: number;
          }
        ).time_deleted,
      ).toBeGreaterThan(0);
    } finally {
      cli.close();
    }
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    // 刷新按既有行为回工作区，重新打开设置才能核对持久化后的列表。
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-1"]').isExisting(),
    ).toBe(false);
    expect(await row("arm-beta").isExisting()).toBe(false);
  });
  it("ARM03：全部删除仅作用于当前筛选，分组更多取消归档", async () => {
    await $('[data-testid="archive-search"]').setValue("Unclassified");
    await $('[data-testid="archive-delete-all"]').click();
    expect(await $('[data-confirm-intent="archive-management-delete"]').getText()).toContain("1");
    await $('[data-testid="confirm-dialog-confirm"]').click();
    // 折叠组没有行 DOM，等整个分组消失并核对落库，避免把未渲染误当成已删除。
    await $('[data-testid="archive-group"][data-project-id=""]').waitForExist({ reverse: true });
    expect(readRow("arm-loose").cli_deleted).toBe(1);
    expect(readRow("arm-scheduled").cli_deleted).toBe(0);
    expect(readRow("arm-removed").cli_deleted).toBe(0);
    await clearSearch();
    const group = $('[data-testid="archive-group"][data-project-id="arm-project-0"]');
    expect(
      await group.$('[data-testid="archive-group-toggle"]').getAttribute("aria-expanded"),
    ).toBe("false");
    await group.$('[data-testid="archive-group-menu"]').click();
    await $('[data-testid="archive-group-unarchive"]').click();
    await group.waitForExist({ reverse: true });
    expect(readRow("arm-scheduled").archived).toBe(0);
  });
});

async function captureArchiveLayouts() {
  const original = await browser.execute(() =>
    (window as typeof window & { __testActions: { getTheme(): string } }).__testActions.getTheme(),
  );
  try {
    for (const width of [1200, 390]) {
      await browser.electron.execute(async (electron, width) => {
        const target = electron.BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && !w.isDestroyed(),
        )!;
        if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
        await target.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }, width);
      for (const [locale, theme] of [
        ["zh-CN", "zai-light"],
        ["zh-CN", "zai-dark"],
        ["en-US", "zai-light"],
        ["en-US", "zai-dark"],
      ] as const) {
        await browser.execute(
          ({ locale, theme }) => {
            const actions = (
              window as typeof window & {
                __testActions: { setTheme(value: string): void; setLocale(value: string): void };
              }
            ).__testActions;
            actions.setTheme(theme);
            actions.setLocale(locale);
          },
          { locale, theme },
        );
        await browser.waitUntil(() =>
          browser.execute(
            (theme) => document.documentElement.classList.contains(`theme-${theme}`),
            theme,
          ),
        );
        await expect($('[data-testid="archive-sort"]')).toHaveText(
          locale === "zh-CN" ? "更新时间" : "Updated time",
        );
        await setArchiveGroupsOpen(false);
        expect(await $$('[data-testid="archive-task"]').length).toBe(0);
        await waitForArchiveAnimations();
        const dimensions = await browser.execute(() => {
          const page = document.querySelector<HTMLElement>('[data-testid="archive-management"]')!;
          const box = page.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            width: innerWidth,
            scrollWidth: page.scrollWidth,
            clientWidth: page.clientWidth,
            filters: ["archive-sort", "archive-project-filter"].map((id) => {
              const trigger = page.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
              return {
                left: trigger.getBoundingClientRect().left,
                labelRight: trigger.labels?.[0]?.getBoundingClientRect().right ?? null,
              };
            }),
          };
        });
        expect(dimensions.right).toBeLessThanOrEqual(dimensions.width);
        expect(dimensions.left).toBeGreaterThanOrEqual(0);
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
        const heading = $(`h2=${locale === "zh-CN" ? "归档管理" : "Archive management"}`);
        await heading.scrollIntoView();
        await expect(heading).toBeDisplayed();
        await expect($('[data-testid="archive-management"] h2')).toHaveText(
          locale === "zh-CN" ? "已归档的会话" : "Archived sessions",
        );
        const autoArchive = $('[data-testid="archive-auto-archive-switch"]');
        await autoArchive.scrollIntoView();
        await expect(autoArchive).toHaveAttribute(
          "aria-label",
          locale === "zh-CN" ? "自动归档旧会话" : "Auto-archive old sessions",
        );
        const controlBounds = await browser.execute(() =>
          ["archive-auto-archive-switch", "archive-auto-archive-days"].map((id) => {
            const box = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth;
          }),
        );
        expect(controlBounds).toEqual([true, true]);
        for (const filter of dimensions.filters) {
          if (filter.labelRight !== null) expect(filter.labelRight).toBeLessThan(filter.left);
        }
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR!,
            `archive-${width}-${locale}-${theme}-collapsed.png`,
          ),
        );
        await $('[data-testid="archive-group-toggle"]').click();
        await $('[data-testid="archive-task"]').waitForDisplayed();
        await waitForArchiveAnimations();
        expect(
          await browser.execute(() => {
            const page = document.querySelector<HTMLElement>('[data-testid="archive-management"]')!;
            return page.scrollWidth <= page.clientWidth + 1;
          }),
        ).toBe(true);
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR!,
            `archive-${width}-${locale}-${theme}-expanded.png`,
          ),
        );
      }
    }
  } finally {
    await browser.electron.execute(async (electron) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (w) => w.isVisible() && !w.isDestroyed(),
      )!;
      await target.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    });
    await browser.execute((value) => {
      const actions = (
        window as typeof window & {
          __testActions: { setTheme(value: string): void; setLocale(value: string): void };
        }
      ).__testActions;
      actions.setTheme(value);
      actions.setLocale("zh-CN");
    }, original);
  }
}
