import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_WORKSPACE_FILE_TREE_BUTTON,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_ROW,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  hoverTestIdByWebDriver,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "E2E_FILE_TREE_COMPACT_HIERARCHY");
const COMPACT_DIRECTORY = join(CASE_ROOT, "api", "architecture");
const CHAT_DIRECTORY = join(COMPACT_DIRECTORY, "chat");
const FIRST_CHAT_FILE = join(CHAT_DIRECTORY, "item-00.txt");

describe("工作区文件树 compact hierarchy E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  it("多层空目录展开后保持逐级缩进，并让后代目录无间隙吸顶", async function () {
    this.timeout(150000);

    await createCaseFiles();
    await waitForDefaultWorkspaceReady();
    await openWorkspaceFileTree();

    await waitForWorkspaceFileTreeRow(COMPACT_DIRECTORY);
    await clickWorkspaceFileTreeRow(COMPACT_DIRECTORY);
    await waitForWorkspaceFileTreeRow(CHAT_DIRECTORY);
    await clickWorkspaceFileTreeRow(CHAT_DIRECTORY);
    await waitForWorkspaceFileTreeRow(FIRST_CHAT_FILE);

    const hierarchy = await readHierarchyMetrics(CHAT_DIRECTORY, FIRST_CHAT_FILE);
    expect(hierarchy.parentDepth).toBe(1);
    expect(hierarchy.childDepth).toBe(2);
    expect(hierarchy.childPaddingLeft - hierarchy.parentPaddingLeft).toBe(12);

    await scrollWorkspaceFileTree(280);
    const sticky = await waitForStickyHierarchy(COMPACT_DIRECTORY, CHAT_DIRECTORY);
    expect(sticky.parentIsStatic).toBe(true);
    expect(sticky.childIsStatic).toBe(true);
    expect(Math.abs(sticky.gap)).toBeLessThanOrEqual(0.5);
  });
});

async function createCaseFiles() {
  await rm(CASE_ROOT, { recursive: true, force: true });
  await mkdir(CHAT_DIRECTORY, { recursive: true });
  await writeFile(
    join(COMPACT_DIRECTORY, "index.ts"),
    "export const marker = 'E2E_FILE_TREE_COMPACT_HIERARCHY';\n",
    "utf-8",
  );
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      writeFile(
        join(CHAT_DIRECTORY, `item-${String(index).padStart(2, "0")}.txt`),
        `E2E_FILE_TREE_COMPACT_HIERARCHY_${index}\n`,
        "utf-8",
      ),
    ),
  );
}

async function openWorkspaceFileTree() {
  // 修复原因：workspace action 只在整行 hover/focus 后挂载。
  await hoverTestIdByWebDriver(testId(TID_WORKSPACE_ITEM, DEFAULT_WORKSPACE));
  await clickTestIdByDom(testId(TID_WORKSPACE_FILE_TREE_BUTTON, DEFAULT_WORKSPACE), {
    timeoutMsg: "没有找到工作区文件树入口",
  });
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, {
    timeoutMsg: "文件树面板没有打开",
  });
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
      timeout: 10000,
      timeoutMsg: `文件树没有显示目标路径: ${path}`,
    },
  );
}

async function readHierarchyMetrics(parentPath: string, childPath: string) {
  return browser.execute(
    (parentTestId, childTestId) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"));
      const parent = rows.find((element) => element.dataset.testid === parentTestId);
      const child = rows.find((element) => element.dataset.testid === childTestId);
      const parentGuide = parent?.querySelector<HTMLElement>(
        "[data-workspace-file-tree-hierarchy-guides]",
      );
      const childGuide = child?.querySelector<HTMLElement>(
        "[data-workspace-file-tree-hierarchy-guides]",
      );
      if (!parent || !child || !parentGuide || !childGuide) {
        throw new Error("文件树层级行或引导线不存在");
      }
      return {
        parentDepth: Number(parentGuide.dataset.workspaceFileTreeHierarchyGuides),
        childDepth: Number(childGuide.dataset.workspaceFileTreeHierarchyGuides),
        parentPaddingLeft: Number.parseFloat(getComputedStyle(parent).paddingLeft),
        childPaddingLeft: Number.parseFloat(getComputedStyle(child).paddingLeft),
      };
    },
    testId(TID_WORKSPACE_FILE_TREE_ROW, parentPath),
    testId(TID_WORKSPACE_FILE_TREE_ROW, childPath),
  );
}

async function scrollWorkspaceFileTree(scrollTop: number) {
  await browser.execute(
    (panelTestId, nextScrollTop) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      const scrollContainer = Array.from(panel?.querySelectorAll<HTMLElement>("div") ?? []).find(
        (element) => {
          const overflowY = getComputedStyle(element).overflowY;
          return (
            (overflowY === "auto" || overflowY === "scroll") &&
            element.scrollHeight > element.clientHeight + 1
          );
        },
      );
      if (!scrollContainer) {
        throw new Error("文件树滚动容器不存在或没有溢出");
      }
      scrollContainer.scrollTop = nextScrollTop;
      scrollContainer.dispatchEvent(new Event("scroll"));
    },
    TID_WORKSPACE_FILE_TREE_PANEL,
    scrollTop,
  );
}

async function waitForStickyHierarchy(parentPath: string, childPath: string) {
  const parentTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, parentPath);
  const childTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, childPath);

  await browser.waitUntil(
    async () => (await readStickyHierarchy(parentTestId, childTestId)) !== null,
    {
      timeout: 10000,
      timeoutMsg: "滚动后 compact folder 的后代目录没有进入吸顶区域",
    },
  );

  const result = await readStickyHierarchy(parentTestId, childTestId);
  if (!result) {
    throw new Error("没有读取到文件树吸顶目录");
  }
  return result;
}

function readStickyHierarchy(parentTestId: string, childTestId: string) {
  return browser.execute(
    (currentParentTestId, currentChildTestId) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"));
      const findStaticRow = (rowTestId: string) =>
        rows.find(
          (element) =>
            element.dataset.testid === rowTestId &&
            !element.parentElement?.classList.contains("absolute"),
        );
      const parent = findStaticRow(currentParentTestId);
      const child = findStaticRow(currentChildTestId);
      if (!parent || !child) {
        return null;
      }
      const parentRect = parent.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      return {
        parentIsStatic: true,
        childIsStatic: true,
        gap: childRect.top - parentRect.bottom,
      };
    },
    parentTestId,
    childTestId,
  );
}
