import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_PREVIEW_PANE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";
import { openProjectFileTree } from "./helpers/project-sidebar.js";

const TREE_DIR = join(DEFAULT_WORKSPACE, "e2e-file-tree-refresh");
const OLD_FILE = join(TREE_DIR, "old-name.txt");
const RENAMED_FILE = join(TREE_DIR, "renamed-name.txt");
const WATCHED_FILE = join(TREE_DIR, "watcher-created.txt");

describe("工作区文件树刷新 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(TREE_DIR, { recursive: true, force: true });
  });

  it("重命名后点击刷新会更新已加载子目录，新增文件会实时出现在文件树", async function () {
    this.timeout(150000);

    await rm(TREE_DIR, { recursive: true, force: true });
    await waitForDefaultWorkspaceReady();
    await assertTaskListScrollMask();
    await mkdir(TREE_DIR, { recursive: true });
    await writeFile(OLD_FILE, "old file", "utf-8");

    await observeSidebarSlide();
    await openWorkspaceFileTree();
    await assertSidebarSlide("open");
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const panel = document.querySelector<HTMLElement>('[data-project-sidebar-panel="files"]');
          const navigation = document.querySelector<HTMLElement>(
            '[data-project-sidebar-panel="navigation"]',
          );
          if (!panel || !navigation) return false;
          const style = getComputedStyle(panel);
          return (
            panel.getAttribute("aria-hidden") === "false" &&
            navigation.getAttribute("aria-hidden") === "true" &&
            style.transitionProperty.includes("transform") &&
            Math.abs(
              panel.getBoundingClientRect().left -
                panel.parentElement!.getBoundingClientRect().left,
            ) < 1
          );
        }),
      { timeout: 10000, timeoutMsg: "查看文件没有完成 transform 滑入动效" },
    );
    await observeSidebarSlide();
    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('[data-project-sidebar-panel="files"] button')
        ?.click();
    });
    await assertSidebarSlide("close");
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const files = document.querySelector<HTMLElement>('[data-project-sidebar-panel="files"]');
          const navigation = document.querySelector<HTMLElement>(
            '[data-project-sidebar-panel="navigation"]',
          );
          if (!files || !navigation) return false;
          return (
            files.inert &&
            files.getAttribute("aria-hidden") === "true" &&
            !navigation.inert &&
            Math.abs(
              navigation.getBoundingClientRect().left -
                navigation.parentElement!.getBoundingClientRect().left,
            ) < 1
          );
        }),
      { timeout: 10000, timeoutMsg: "返回项目列表没有完成反向滑动或隐藏文件树仍可聚焦" },
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelector('[data-project-sidebar-panel="files"]')?.childElementCount === 0,
        ),
      { timeout: 10000, timeoutMsg: "退场完成后文件树未卸载，目录监听仍可能持续运行" },
    );
    await openWorkspaceFileTree();
    await clickWorkspaceFileTreeRow(TREE_DIR);
    await waitForWorkspaceFileTreeRow(OLD_FILE);

    await clickWorkspaceFileTreeRow(TREE_DIR);
    await waitForWorkspaceFileTreeRowMissing(OLD_FILE);
    await rename(OLD_FILE, RENAMED_FILE);
    await clickTestIdByDom(TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON, {
      timeoutMsg: "文件树刷新按钮不可点击",
    });

    await clickWorkspaceFileTreeRow(TREE_DIR);
    await waitForWorkspaceFileTreeRow(RENAMED_FILE);
    await waitForWorkspaceFileTreeRowMissing(OLD_FILE);

    await clickWorkspaceFileTreeRow(RENAMED_FILE);
    await waitForTestIdByDom(TID_PREVIEW_PANE, {
      timeoutMsg: "重命名后的文件没有正常打开预览",
    });

    await writeFile(WATCHED_FILE, "created by watcher", "utf-8");
    await waitForWorkspaceFileTreeRow(WATCHED_FILE, {
      timeout: 15000,
      timeoutMsg: "已加载目录新增文件后，文件树没有通过 watcher 实时刷新",
    });
  });
});

async function openWorkspaceFileTree() {
  // 修复原因：workspace action 只在整行 hover/focus 后挂载。
  await openProjectFileTree(DEFAULT_WORKSPACE, {
    timeoutMsg: "没有找到工作区文件树入口",
  });
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, {
    timeoutMsg: "文件树面板没有打开",
  });
}

async function clickWorkspaceFileTreeRow(path: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (rowTestId) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) => element.dataset.testid === rowTestId,
          );
          if (!row) {
            return false;
          }
          row.click();
          return true;
        },
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    {
      timeout: 10000,
      timeoutMsg: `文件树没有可点击行: ${path}`,
    },
  );
}

async function waitForWorkspaceFileTreeRow(
  path: string,
  options: { timeout?: number; timeoutMsg?: string } = {},
) {
  const { timeout = 10000, timeoutMsg = `文件树没有显示目标路径: ${path}` } = options;
  await browser.waitUntil(
    async () =>
      browser.execute(
        (rowTestId) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (element) => element.dataset.testid === rowTestId,
          ),
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout, timeoutMsg },
  );
}

async function waitForWorkspaceFileTreeRowMissing(path: string) {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (currentRowTestId) =>
          !Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (element) => element.dataset.testid === currentRowTestId,
          ),
        rowTestId,
      ),
    {
      timeout: 10000,
      timeoutMsg: `文件树仍显示已重命名的旧路径: ${path}`,
    },
  );
}

// 只检查终点会把瞬间跳转误判为动效成功；用真实 transition 事件和逐帧位置验证过程。
async function observeSidebarSlide() {
  await browser.execute(() => {
    for (const panel of document.querySelectorAll<HTMLElement>("[data-project-sidebar-panel]")) {
      const start = panel.getBoundingClientRect().left;
      const samples = [start];
      panel.dataset.slideEvidence = JSON.stringify({ samples, ended: false });
      const record = () => {
        if (panel.dataset.slideRunning !== "true") return;
        samples.push(panel.getBoundingClientRect().left);
        panel.dataset.slideEvidence = JSON.stringify({ samples, ended: false });
        if (panel.dataset.slideRunning === "true") requestAnimationFrame(record);
      };
      panel.addEventListener("transitionrun", function onRun(event) {
        if (event.target !== panel || !["translate", "transform"].includes(event.propertyName))
          return;
        panel.removeEventListener("transitionrun", onRun);
        panel.dataset.slideRunning = "true";
        requestAnimationFrame(record);
      });
      panel.addEventListener("transitionend", function onEnd(event) {
        if (event.target !== panel || !["translate", "transform"].includes(event.propertyName))
          return;
        panel.removeEventListener("transitionend", onEnd);
        panel.dataset.slideRunning = "false";
        samples.push(panel.getBoundingClientRect().left);
        panel.dataset.slideEvidence = JSON.stringify({
          samples,
          ended: true,
          elapsed: event.elapsedTime,
        });
      });
    }
  });
}

async function assertSidebarSlide(direction: "open" | "close") {
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-project-sidebar-panel]")).every(
          (panel) => JSON.parse(panel.dataset.slideEvidence ?? "{}").ended === true,
        ),
      ),
    { timeout: 5000, timeoutMsg: `${direction}: 没有发生实际 CSS 位移动画` },
  );
  const evidence = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-project-sidebar-panel]")).map(
      (panel) => ({
        panel: panel.dataset.projectSidebarPanel,
        ...(JSON.parse(panel.dataset.slideEvidence!) as { samples: number[]; elapsed: number }),
      }),
    ),
  );
  for (const item of evidence) {
    const start = item.samples[0]!;
    const end = item.samples[item.samples.length - 1]!;
    expect(
      item.samples.some((x) => x > Math.min(start, end) + 1 && x < Math.max(start, end) - 1),
    ).toBe(true);
    expect(direction === "open" ? end < start : end > start).toBe(true);
    expect(item.elapsed).toBeCloseTo(0.2, 2);
  }
  console.log("[sidebar-slide-evidence]", direction, JSON.stringify(evidence));
}

async function assertTaskListScrollMask() {
  const selector = '[data-project-sidebar-panel="navigation"] [data-scroll-mask]';
  const previousStyle = await browser.execute((query) => {
    const viewport = document.querySelector<HTMLElement>(query);
    if (!viewport) throw new Error("task 列表未使用滚动渐隐容器");
    const style = viewport.getAttribute("style");
    viewport.style.flex = "none";
    viewport.style.height = "40px";
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    return style;
  }, selector);
  const assertMask = async (mask: string) => {
    await browser.waitUntil(
      () =>
        browser.execute(
          (query, expected) => {
            const viewport = document.querySelector<HTMLElement>(query);
            return (
              viewport?.dataset.scrollMask === expected &&
              (expected === "none"
                ? getComputedStyle(viewport).maskImage === "none"
                : getComputedStyle(viewport!).maskImage.includes("linear-gradient"))
            );
          },
          selector,
          mask,
        ),
      { timeout: 5000, timeoutMsg: `task 列表 mask 未变为 ${mask}` },
    );
  };
  try {
    await assertMask("bottom");
    await browser.execute((query) => {
      const viewport = document.querySelector<HTMLElement>(query)!;
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
      viewport.dispatchEvent(new Event("scroll"));
    }, selector);
    await assertMask("both");
    await browser.execute((query) => {
      const viewport = document.querySelector<HTMLElement>(query)!;
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event("scroll"));
    }, selector);
    await assertMask("top");
    await browser.execute((query) => {
      const viewport = document.querySelector<HTMLElement>(query)!;
      viewport.style.height = `${viewport.scrollHeight + 20}px`;
    }, selector);
    await assertMask("none");
  } finally {
    await browser.execute(
      (query, style) => {
        const viewport = document.querySelector<HTMLElement>(query)!;
        if (style === null) viewport.removeAttribute("style");
        else viewport.setAttribute("style", style);
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      },
      selector,
      previousStyle,
    );
  }
}
