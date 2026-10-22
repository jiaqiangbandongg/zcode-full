import { join } from "node:path";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "../../../helpers/desktop-app.js";

const project = '[data-testid="project-section"]';
const tasks = '[data-testid="conversation-section"]';
const trigger = 'button[data-slot="collapsible-trigger"]';
const indicator = '[data-testid="purpose-section-drop-indicator"]';
const preferenceKey = "zcode-sidebar-purpose-section-preferences";

describe("CWP02 分区标题拖拽", () => {
  before(async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await browser.execute((key) => localStorage.removeItem(key), preferenceKey);
    await browser.refresh();
    await $(project).waitForDisplayed();
  });

  afterEach(async () => {
    await browser.keys("Escape");
    await browser.releaseActions();
  });

  it("标题直接向上拖动，蓝线、纵轴、折叠独立与重载持久化", async () => {
    expect(await $("[data-purpose-section-drag-handle]").isExisting()).toBe(false);
    await $(project).$(trigger).click();
    await expect($(project).$(trigger)).toHaveAttribute("aria-expanded", "false");
    await expect($(tasks).$(trigger)).toHaveAttribute("aria-expanded", "true");
    await beginDrag(tasks, project);
    await expect($(project).$(indicator)).toHaveAttribute("data-drop-position", "before");
    await assertDragLayout(tasks);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "section-drag-up.png"));
    await browser.performActions([
      {
        type: "pointer",
        id: "section-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerUp", button: 0 }],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => (await order())[0] === "conversations");
    expect(await $(indicator).isExisting()).toBe(false);
    await expect($(project).$(trigger)).toHaveAttribute("aria-expanded", "false");
    await expect($(tasks).$(trigger)).toHaveAttribute("aria-expanded", "true");
    await browser.refresh();
    await $(project).waitForDisplayed();
    expect(await order()).toEqual(["conversations", "projects"]);
    await expect($(project).$(trigger)).toHaveAttribute("aria-expanded", "false");
  });

  it("键盘从标题向下移动，Escape 不提交，Space 提交且不误折叠", async () => {
    const focusTasks = () =>
      browser.execute(
        (selector) => document.querySelector<HTMLButtonElement>(selector)!.focus(),
        `${tasks} ${trigger}`,
      );
    await focusTasks();
    await browser.keys("Space");
    await browser.keys("ArrowDown");
    await expect($(project).$(indicator)).toHaveAttribute("data-drop-position", "after");
    await browser.keys("Escape");
    expect(await $(indicator).isExisting()).toBe(false);
    expect(await order()).toEqual(["conversations", "projects"]);
    await expect($(tasks).$(trigger)).toHaveAttribute("aria-expanded", "true");
    await focusTasks();
    await browser.keys("Space");
    await browser.keys("ArrowDown");
    await expect($(project).$(indicator)).toHaveAttribute("data-drop-position", "after");
    await browser.keys("Space");
    await browser.waitUntil(async () => (await order())[0] === "projects");
    await expect($(tasks).$(trigger)).toHaveAttribute("aria-expanded", "true");
    expect(await $(indicator).isExisting()).toBe(false);
  });

  it("新建按钮保持独立，点击仍能打开向导而不折叠或拖拽", async () => {
    await $('[data-testid="virtual-project-add"]').click();
    await $('[role="dialog"]').waitForDisplayed();
    await expect($(project).$(trigger)).toHaveAttribute("aria-expanded", "false");
    expect(await $(indicator).isExisting()).toBe(false);
  });

  it("明暗主题与 390px 下向右拖动仍不横向溢出，取消清除蓝线", async () => {
    const originalTheme = await browser.execute(() =>
      (window as Window & { __testActions?: { getTheme(): string } }).__testActions!.getTheme(),
    );
    try {
      for (const width of [1200, 390]) {
        await emulate(width);
        if (width === 390) {
          // 窄屏按原策略自动收起，等待后再通过产品入口打开侧栏。
          await browser.waitUntil(
            async () => (await $("aside").getAttribute("aria-hidden")) === "true",
          );
          await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
        }
        for (const theme of ["zai-light", "zai-dark"]) {
          await browser.execute(
            (value) =>
              (
                window as Window & { __testActions?: { setTheme(value: string): void } }
              ).__testActions!.setTheme(value),
            theme,
          );
          await browser.waitUntil(() =>
            browser.execute(
              (value) => document.documentElement.classList.contains(`theme-${value}`),
              theme,
            ),
          );
          await beginDrag(project, tasks);
          await expect($(tasks).$(indicator)).toHaveAttribute("data-drop-position", "after");
          await assertDragLayout(project);
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `section-drag-${width}-${theme}.png`),
          );
          await browser.keys("Escape");
          await browser.releaseActions();
          expect(await $(indicator).isExisting()).toBe(false);
          expect(await order()).toEqual(["projects", "conversations"]);
        }
      }
    } finally {
      await emulate();
      await browser.execute(
        (value) =>
          (
            window as Window & { __testActions?: { setTheme(value: string): void } }
          ).__testActions!.setTheme(value),
        originalTheme,
      );
    }
  });
});

async function order() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("[data-purpose-section-list] > *")).map((node) =>
      node
        .querySelector("[data-purpose-section-drag-trigger]")
        ?.getAttribute("data-purpose-section-drag-trigger"),
    ),
  );
}

async function beginDrag(source: string, target: string) {
  const coords = await browser.execute(
    (source, target, trigger) => {
      const from = document.querySelector(`${source} ${trigger}`)!.getBoundingClientRect();
      const to = document.querySelector(target)!.getBoundingClientRect();
      return {
        x: Math.round(from.left + 28),
        y: Math.round(from.top + from.height / 2),
        targetY: Math.round(to.top + to.height / 2),
        right: Math.min(innerWidth - 5, Math.round(from.right + 120)),
      };
    },
    source,
    target,
    trigger,
  );
  await browser.performActions([
    {
      type: "pointer",
      id: "section-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: coords.x, y: coords.y },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 100, x: coords.x + 8, y: coords.y },
        { type: "pointerMove", duration: 250, x: coords.right, y: coords.targetY },
      ],
    },
  ]);
}

async function assertDragLayout(source: string) {
  await $(indicator).waitForDisplayed();
  const state = await browser.execute(
    (source, indicator) => {
      const section = document.querySelector<HTMLElement>(source)!;
      const line = document.querySelector<HTMLElement>(indicator)!;
      const reference = document.createElement("span");
      reference.className = "bg-icon-blue";
      line.append(reference);
      const expectedColor = getComputedStyle(reference).backgroundColor;
      reference.remove();
      const scrolls: Array<{ width: number; scrollWidth: number; overflowX: string }> = [];
      for (let node = section.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowY === "auto")
          scrolls.push({
            width: node.clientWidth,
            scrollWidth: node.scrollWidth,
            overflowX: getComputedStyle(node).overflowX,
          });
      }
      return {
        count: document.querySelectorAll(indicator).length,
        x: new DOMMatrix(getComputedStyle(section).transform).m41,
        height: line.getBoundingClientRect().height,
        color: getComputedStyle(line).backgroundColor,
        expectedColor,
        pointerEvents: getComputedStyle(line).pointerEvents,
        circle: line.firstElementChild!.getBoundingClientRect().width,
        scrolls,
      };
    },
    source,
    indicator,
  );
  expect(state.count).toBe(1);
  expect(state.x).toBe(0);
  expect(state.height).toBe(2);
  expect(state.color).toBe(state.expectedColor);
  expect(state.pointerEvents).toBe("none");
  expect(state.circle).toBe(8);
  expect(state.scrolls.length).toBeGreaterThan(0);
  for (const scroll of state.scrolls) {
    expect(scroll.overflowX).toBe("hidden");
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.width + 1);
  }
}

async function emulate(width?: number) {
  await browser.electron.execute(async (electron, width) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (item) => !item.isDestroyed() && item.isVisible(),
    )!;
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand(
      width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
      width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
    );
  }, width);
}
