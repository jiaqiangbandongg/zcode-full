import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_PREVIEW_PANE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";
import { openProjectFileTree } from "../helpers/project-sidebar.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../helpers/e2e-electron-reload.js";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "E2E_FILE_TREE_SHARED_SEARCH");
const JAVA_DIRECTORY = join(CASE_ROOT, "src", "main", "java", "com", "example", "user");
const JAVA_FILE = join(JAVA_DIRECTORY, "UserProfileService.java");

describe("工作区文件树共享搜索 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  it("未展开深层 Java 文件可以通过左侧文件树搜索命中并打开预览", async function () {
    this.timeout(150000);

    await rm(CASE_ROOT, { recursive: true, force: true });
    await mkdir(JAVA_DIRECTORY, { recursive: true });
    await writeFile(
      JAVA_FILE,
      "package com.example.user;\npublic final class UserProfileService {}\n",
      "utf-8",
    );

    await waitForDefaultWorkspaceReady();
    await openWorkspaceFileTree();
    await typeWorkspaceFileTreeSearch("UserProfileService");
    await waitForWorkspaceFileTreeRow(JAVA_FILE);
    await clickWorkspaceFileTreeRow(JAVA_FILE);
    await waitForTestIdByDom(TID_PREVIEW_PANE, {
      timeoutMsg: "文件树搜索结果点击后没有打开 PreviewPane",
    });
  });

  it("搜索结果中的深层目录点击后会回到树态并逐级展开定位", async function () {
    this.timeout(150000);

    await rm(CASE_ROOT, { recursive: true, force: true });
    await mkdir(JAVA_DIRECTORY, { recursive: true });
    await writeFile(
      JAVA_FILE,
      "package com.example.user;\npublic final class UserProfileService {}\n",
      "utf-8",
    );

    await waitForDefaultWorkspaceReady();
    await openWorkspaceFileTree();
    await typeWorkspaceFileTreeSearch("com/example/user");
    await waitForWorkspaceFileTreeRow(JAVA_DIRECTORY);
    await clickWorkspaceFileTreeRow(JAVA_DIRECTORY);
    await waitForWorkspaceFileTreeSearchValue("");
    await waitForWorkspaceFileTreeRow(JAVA_DIRECTORY);
    await waitForWorkspaceFileTreeRow(JAVA_FILE);
  });

  it("显式收起目录后，其他文件与 App 重启沿用同一 workspace 偏好", async function () {
    this.timeout(240000);

    const secondFile = join(CASE_ROOT, "src", "main", "java", "NavigationPreference.java");
    await mkdir(JAVA_DIRECTORY, { recursive: true });
    await writeFile(JAVA_FILE, "public final class UserProfileService {}\n", "utf-8");
    await writeFile(secondFile, "public final class NavigationPreference {}\n", "utf-8");

    await waitForDefaultWorkspaceReady();
    await openFileFromCommandCenter("UserProfileService.java");
    await toggleFileNavigation(false);
    await openFileFromCommandCenter("NavigationPreference.java");
    await waitForFileNavigationExpanded(false);

    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForDefaultWorkspaceReady(30000);
    await openFileFromCommandCenter("UserProfileService.java");
    await waitForFileNavigationExpanded(false);
  });
});

async function openFileFromCommandCenter(fileName: string) {
  await $('[data-testid="sidebar-search-open"]').click();
  const input = $('[role="dialog"] [cmdk-input]');
  await input.waitForDisplayed({ timeout: 10000 });
  await input.setValue(fileName);
  await browser.waitUntil(
    async () =>
      browser.execute((targetFileName) => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"] [cmdk-item]'),
        ).find((candidate) => candidate.textContent?.includes(targetFileName));
        item?.click();
        return Boolean(item);
      }, fileName),
    {
      timeout: 15000,
      timeoutMsg: `命令中心没有找到文件: ${fileName}`,
    },
  );
  await waitForTestIdByDom(TID_PREVIEW_PANE, {
    timeoutMsg: `命令中心打开文件后没有显示 PreviewPane: ${fileName}`,
  });
}

async function readFileNavigationExpanded(): Promise<boolean | null> {
  return browser.execute(() => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-file-manager-pane] button[aria-expanded]",
      ),
    ).find((candidate) => candidate.getClientRects().length > 0);
    if (!button) return null;
    return button.getAttribute("aria-expanded") === "true";
  });
}

async function waitForFileNavigationExpanded(expected: boolean) {
  await browser.waitUntil(async () => (await readFileNavigationExpanded()) === expected, {
    timeout: 10000,
    timeoutMsg: `文件导航显隐状态没有变为: ${String(expected)}`,
  });
}

async function toggleFileNavigation(expanded: boolean) {
  const changed = await browser.execute((nextExpanded) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-file-manager-pane] button[aria-expanded]",
      ),
    ).find((candidate) => candidate.getClientRects().length > 0);
    if (!button) return false;
    if ((button.getAttribute("aria-expanded") === "true") !== nextExpanded) {
      button.click();
    }
    return true;
  }, expanded);
  expect(changed).toBe(true);
  await waitForFileNavigationExpanded(expanded);
}

async function openWorkspaceFileTree() {
  const alreadyOpen = await browser.execute(
    (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
    TID_WORKSPACE_FILE_TREE_PANEL,
  );
  // 修复原因：同一 spec 的第二个 case 会复用已打开的文件树；此时 workspace 行可能
  // 被面板挤出视口，继续 moveTo 会报 out-of-bounds，且没有必要重复点击入口。
  if (alreadyOpen) return;
  // 修复原因：workspace action 只在整行 hover/focus 后挂载。
  await openProjectFileTree(DEFAULT_WORKSPACE, {
    timeoutMsg: "没有找到工作区文件树入口",
  });
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, {
    timeoutMsg: "文件树面板没有打开",
  });
}

async function typeWorkspaceFileTreeSearch(query: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, nextQuery) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          const input = panel?.querySelector<HTMLInputElement>("input");
          if (!input) {
            return false;
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, nextQuery);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        },
        TID_WORKSPACE_FILE_TREE_PANEL,
        query,
      ),
    {
      timeout: 10000,
      timeoutMsg: "文件树搜索框不可输入",
    },
  );
}

async function waitForWorkspaceFileTreeSearchValue(expectedValue: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, currentExpectedValue) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          const input = panel?.querySelector<HTMLInputElement>("input");
          return input?.value === currentExpectedValue;
        },
        TID_WORKSPACE_FILE_TREE_PANEL,
        expectedValue,
      ),
    {
      timeout: 10000,
      timeoutMsg: `文件树搜索框没有变为: ${expectedValue}`,
    },
  );
}

async function clickWorkspaceFileTreeRow(path: string) {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    async () =>
      browser.execute((currentRowTestId) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (element) => element.dataset.testid === currentRowTestId,
        );
        row?.click();
        return Boolean(row);
      }, rowTestId),
    {
      timeout: 10000,
      timeoutMsg: `文件树没有可点击行: ${path}`,
    },
  );
}

async function waitForWorkspaceFileTreeRow(path: string) {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (currentRowTestId) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (element) => element.dataset.testid === currentRowTestId,
          ),
        rowTestId,
      ),
    {
      timeout: 15000,
      timeoutMsg: `文件树搜索没有显示目标路径: ${path}`,
    },
  );
}
