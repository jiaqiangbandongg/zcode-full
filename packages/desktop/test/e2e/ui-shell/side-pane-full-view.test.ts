import { join } from "node:path";
import {
  TID_SIDE_PANE_FULL_VIEW_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB,
  TID_SIDE_PANE_FULL_VIEW_DRAWER,
  TID_SIDE_PANE_FULL_VIEW_EXPAND,
  TID_SIDE_PANE_FULL_VIEW_HANDLE,
  TID_SIDE_PANE_FULL_VIEW_HEADER,
  TID_SIDE_PANE_FULL_VIEW_HOST,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_RUNNING,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
  TID_SIDE_PANE_TOGGLE,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  TID_V4_TIMELINE,
  TID_WORKSPACE_HEADER,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

// spec：docs/ui/side-pane-full-view.md；用例：docs/testing/side-pane-tabs-e2e-case-catalog.md（SPFV）
const SIDE_FRAME = '[data-workspace-side-frame="true"]';
const SLOT = `${SIDE_FRAME} [data-side-pane-content-slot]`;
const HOST = `[data-testid="${TID_SIDE_PANE_FULL_VIEW_HOST}"]`;
const MAIN_PANE = `[data-testid="${testId(TID_V4_SESSION_PANE, "workspace-main")}"]`;
const COMPOSER_INPUT = `${HOST} [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
const COMPOSER_DOCK = `${HOST} [data-v4-composer-dock="true"]`;
const COMPOSER_SHELL = `${HOST} [data-composer-layout]`;
const COMPOSER_ACTION_MENU = `${HOST} [data-composer-action-menu] button`;
const COMPOSER_SEND = `${HOST} [data-testid="${TID_V4_COMPOSER_SEND}"]`;
const COMPOSER_PROJECT_TRIGGER = `${HOST} [data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`;
const EDITOR_MARKER = "spfv-editor-instance";
const DRAWER = `[data-testid="${TID_SIDE_PANE_FULL_VIEW_DRAWER}"]`;
const EXPAND = `[data-testid="${TID_SIDE_PANE_FULL_VIEW_EXPAND}"]`;
const TAB = "[data-side-pane-tab-id]";
const PANE_MARKER = "spfv-single-instance";
const DRAFT_TEXT = "E2E_SPFV_FLOATING_DRAFT";
const MARGIN = 16;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

describe("Side Pane 完整视图（SPFV）", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() =>
      window.localStorage.removeItem("zcode:side-pane-full-view:floating-anchor"),
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SPFV-E2E-001 进入、退出且不重新挂载对话", async () => {
    await ensureSidePaneExpanded();
    await ensureTerminalTab();
    const before = await readLayoutWidths();
    await markMainPane();

    await clickFullViewToggle();
    await waitForHostMode("floating");
    const entered = await readLayoutWidths();
    // 完整视图保留左侧任务列表与左上角按钮组。
    expect(Math.abs(entered.sidebar - before.sidebar)).toBeLessThanOrEqual(2);
    expect(await $('[data-testid="desktop-top-nav-back"]').isExisting()).toBe(true);
    // tab 栏是窗口拖拽区；对话 tab 不是 no-drag 时真实鼠标点击会被当成拖动窗口（CDP 点击测不出来）。
    expect(
      await browser.execute(
        (tabId) =>
          getComputedStyle(document.querySelector(`[data-testid="${tabId}"]`)!).getPropertyValue(
            "-webkit-app-region",
          ),
        TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB,
      ),
    ).toBe("no-drag");
    expect(await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`).isExisting()).toBe(false);
    expect(entered.content - entered.sideFrame).toBeLessThanOrEqual(16);
    expect(
      await browser.execute(
        (conversationTabId, tabSelector) => {
          const conversationTab = document.querySelector(`[data-testid="${conversationTabId}"]`);
          const firstPaneTab = document.querySelector(tabSelector);
          return Boolean(
            conversationTab &&
            firstPaneTab &&
            conversationTab.compareDocumentPosition(firstPaneTab) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        },
        TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB,
        TAB,
      ),
    ).toBe(true);

    // 侧栏收起时，tab 栏按 WorkspaceHeader 的规则给左上角按钮组让位，对话 tab 不被按钮盖住。
    await realKeys(["Control", "b"]);
    await browser.waitUntil(async () => (await readLayoutWidths()).sidebar <= 8, {
      timeout: 5_000,
      timeoutMsg: "Cmd/Ctrl+B 后侧栏没有收起",
    });
    await browser.waitUntil(
      async () =>
        (await readRect(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB}"]`)).left >
        (await readRect('[data-testid="desktop-top-nav-back"]')).right + 24,
      { timeout: 5_000, timeoutMsg: "侧栏收起后 tab 栏没有给左上角按钮组让位" },
    );
    await realKeys(["Control", "b"]);
    await browser.waitUntil(
      async () => Math.abs((await readLayoutWidths()).sidebar - before.sidebar) <= 2,
      { timeout: 5_000, timeoutMsg: "Cmd/Ctrl+B 后侧栏没有恢复" },
    );

    await realKeys(["Control", "Shift", "f"]);
    await waitForHostMode("normal");
    await browser.waitUntil(
      async () => Math.abs((await readLayoutWidths()).sidebar - before.sidebar) <= 2,
      { timeout: 5_000, timeoutMsg: "退出完整视图后左侧任务列表没有恢复原宽度" },
    );
    const exited = await readLayoutWidths();
    expect(Math.abs(exited.sidebar - before.sidebar)).toBeLessThanOrEqual(2);
    expect(Math.abs(exited.sideFrame - before.sideFrame)).toBeLessThanOrEqual(2);
    expect(await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`).isExisting()).toBe(true);

    await clickFullViewToggle();
    await waitForHostMode("floating");
    expect(await readMainPaneMarker()).toBe(PANE_MARKER);
  });

  it("SPFV-E2E-002 对话 tab 全宽，面板 tab 显示浮窗", async () => {
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB}"]`).click();
    await waitForHostMode("conversation");
    const slot = await readRect(SLOT);
    await browser.waitUntil(async () => rectsClose(await readRect(HOST), slot, 2), {
      timeout: 5_000,
      timeoutMsg: "对话 tab 激活后宿主没有铺满面板内容区",
    });
    expect(await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HEADER}"]`).isExisting()).toBe(false);
    // 对话 tab 保持普通两行布局，草稿顶部仍有「选择项目」栏。
    expect(await $(COMPOSER_SHELL).getAttribute("data-composer-layout")).toBe("stacked");
    expect(await $(COMPOSER_PROJECT_TRIGGER).isExisting()).toBe(true);
    await markComposerEditor();

    await $(TAB).click();
    await waitForHostMode("floating");
    await browser.waitUntil(
      async () => {
        const host = await readRect(HOST);
        const currentSlot = await readRect(SLOT);
        return (
          Math.abs(currentSlot.right - MARGIN - host.right) <= 2 &&
          Math.abs(currentSlot.bottom - MARGIN - host.bottom) <= 2 &&
          host.height < 320
        );
      },
      { timeout: 5_000, timeoutMsg: "浮窗没有收起在右下角" },
    );
    // 修复原因：对话 tab 切回浮窗时宿主几何有过渡，过渡中分两次读宿主和输入区会得到不同帧的坐标。
    await waitForHostTransitionsSettled();
    // 收起态没有外层：输入区与浮窗同宽、底边对齐，抽屉藏在输入框后面。
    const host = await readRect(HOST);
    const dock = await readRect(COMPOSER_DOCK);
    expect(Math.abs(dock.width - host.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(dock.bottom - host.bottom)).toBeLessThanOrEqual(1);
    expect(await $(DRAWER).getAttribute("data-open")).toBe("false");
    // 浮窗默认是一条：[+] 输入区 [控件][发送] 在同一行，没有草稿项目栏。
    expect(await $(COMPOSER_SHELL).getAttribute("data-composer-layout")).toBe("inline");
    expect(await $(COMPOSER_PROJECT_TRIGGER).isExisting()).toBe(false);
    await browser.waitUntil(async () => (await readRect(HOST)).height <= 64, {
      timeout: 5_000,
      timeoutMsg: "单行浮窗高度没有收到一行",
    });
    const plus = await readRect(COMPOSER_ACTION_MENU);
    const input = await readRect(COMPOSER_INPUT);
    const send = await readRect(COMPOSER_SEND);
    expect(plus.right).toBeLessThanOrEqual(input.left);
    expect(input.right).toBeLessThanOrEqual(send.left);
    expect(Math.abs(centerY(plus) - centerY(send))).toBeLessThanOrEqual(2);
    expect(Math.abs(centerY(input) - centerY(send))).toBeLessThanOrEqual(2);
    expect(input.width).toBeGreaterThanOrEqual((await readRect(COMPOSER_SHELL)).width / 2 - 16);
    // 布局切换只换样式，编辑器节点不重新挂载。
    expect(await readComposerEditorMarker()).toBe(EDITOR_MARKER);
  });

  it("SPFV-E2E-003 操作栏、最小化与恢复共享同一份草稿", async () => {
    await focusFloatingComposer();
    await waitForHeader(true);
    // 抽屉从输入框后面滑出：操作栏只有按钮，抽屉一直延伸到输入框底边，两侧没有凹口。
    expect(await $(DRAWER).getAttribute("data-open")).toBe("true");
    expect(await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HEADER}"] span`).isExisting()).toBe(
      false,
    );
    // 草稿空闲：操作栏不显示运行中的 loading。
    expect(await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_RUNNING}"]`).isExisting()).toBe(false);
    await browser.waitUntil(
      async () =>
        Math.abs((await readRect(DRAWER)).bottom - (await readRect(COMPOSER_DOCK)).bottom) <= 1.5,
      { timeout: 5_000, timeoutMsg: "抽屉没有延伸到输入框底边" },
    );
    await browser.keys(DRAFT_TEXT);
    await waitForComposerText(COMPOSER_INPUT, DRAFT_TEXT);

    // 面板 tab trigger 不抢焦点；点进面板内容区才会让焦点离开浮窗。
    await clickSlotTopLeft();
    await waitForHeader(false);

    await focusFloatingComposer();
    await waitForHeader(true);
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_MINIMIZE}"]`).click();
    const bubble = await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_BUBBLE}"]`);
    await bubble.waitForDisplayed({ timeout: 5_000 });
    await browser.waitUntil(async () => (await readRect(HOST)).width <= 52, {
      timeout: 5_000,
      timeoutMsg: "最小化后浮窗没有收成圆形按钮",
    });

    // 恢复动画逐帧采样：浮窗与输入区高度不能先变高再缩回（回归：宽度过渡时单行输入框折行）。
    await browser.execute(
      (hostSelector, dockSelector) => {
        const samples: Array<{ host: number; dock: number }> = [];
        (window as unknown as { __spfvRestoreSamples: typeof samples }).__spfvRestoreSamples =
          samples;
        const start = performance.now();
        const tick = () => {
          const host = document.querySelector(hostSelector)?.getBoundingClientRect();
          const dock = document.querySelector(dockSelector)?.getBoundingClientRect();
          samples.push({ host: host?.height ?? 0, dock: dock?.height ?? 0 });
          if (performance.now() - start < 500) requestAnimationFrame(tick);
        };
        document.addEventListener("pointerdown", () => requestAnimationFrame(tick), {
          capture: true,
          once: true,
        });
      },
      HOST,
      COMPOSER_DOCK,
    );
    await bubble.click();
    await bubble.waitForExist({ reverse: true, timeout: 5_000 });
    await waitForHeader(true);
    await browser.waitUntil(
      () =>
        browser.execute(
          (selector) => Boolean(document.activeElement?.closest(selector)),
          COMPOSER_INPUT,
        ),
      { timeout: 5_000, timeoutMsg: "恢复后输入框没有获得焦点" },
    );
    await waitForComposerText(COMPOSER_INPUT, DRAFT_TEXT);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            (window as unknown as { __spfvRestoreSamples: unknown[] }).__spfvRestoreSamples.length,
        )) > 20,
      { timeout: 5_000, timeoutMsg: "恢复动画采样不足" },
    );
    await waitForHostTransitionsSettled();
    const finalHost = await readRect(HOST);
    const finalDock = await readRect(COMPOSER_DOCK);
    const restoreSamples = await browser.execute(
      () =>
        (window as unknown as { __spfvRestoreSamples: Array<{ host: number; dock: number }> })
          .__spfvRestoreSamples,
    );
    expect(Math.max(...restoreSamples.map((sample) => sample.host))).toBeLessThanOrEqual(
      finalHost.height + 1,
    );
    expect(Math.max(...restoreSamples.map((sample) => sample.dock))).toBeLessThanOrEqual(
      finalDock.height + 1,
    );

    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB}"]`).click();
    await waitForHostMode("conversation");
    await waitForComposerText(COMPOSER_INPUT, DRAFT_TEXT);
    expect(await readMainPaneMarker()).toBe(PANE_MARKER);
    await $(TAB).click();
    await waitForHostMode("floating");
  });

  it("SPFV-E2E-004 拖动吸附到左上并通过菜单打开对话", async () => {
    await focusFloatingComposer();
    await waitForHeader(true);
    const handle = await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HANDLE}"]`);
    // 修复原因：上一个用例刚从对话 tab 切回浮窗，浮窗几何还在从铺满 slot 过渡到浮窗大小；
    // 过渡中读到的 ⠿ 坐标会让按下点落在浮窗外（面板内容上），拖动变成终端选区。
    // 两次读数比较不可靠（同一渲染帧内读数天然相同），改为等宿主没有正在运行的过渡。
    await waitForHostTransitionsSettled();
    const handleRect = await readRect(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HANDLE}"]`);
    const slot = await readRect(SLOT);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: Math.round(handleRect.left + 8), y: Math.round(handleRect.top + 8) })
      .down({ button: 0 })
      .move({
        x: Math.round(handleRect.left + 20),
        y: Math.round(handleRect.top + 8),
        duration: 50,
      })
      .move({ x: Math.round(slot.left + 300), y: Math.round(slot.top + 40), duration: 200 })
      .up({ button: 0 })
      .perform();
    await browser.waitUntil(
      async () => {
        const host = await readRect(HOST);
        const currentSlot = await readRect(SLOT);
        return (
          Math.abs(host.left - (currentSlot.left + MARGIN)) <= 2 &&
          Math.abs(host.top - (currentSlot.top + MARGIN)) <= 2
        );
      },
      { timeout: 5_000, timeoutMsg: "松手后浮窗没有吸附到左上角" },
    );
    expect(
      await browser.execute(() =>
        window.localStorage.getItem("zcode:side-pane-full-view:floating-anchor"),
      ),
    ).toBe("top-left");

    await focusFloatingComposer();
    await waitForHeader(true);
    await handle.click();
    const openConversation = await $(
      `[data-testid="${TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION}"]`,
    );
    await openConversation.waitForDisplayed({ timeout: 5_000 });
    await openConversation.click();
    await waitForHostMode("conversation");
    await $(TAB).click();
    await waitForHostMode("floating");
    // 回归：菜单 portal 的点击沿 React 树冒泡，曾顺带把浮窗切成展开态。
    expect(await $(HOST).getAttribute("data-floating")).toBe("collapsed");
  });

  it("SPFV-E2E-005 用上 / 下按钮展开与收起消息流", async () => {
    await focusFloatingComposer();
    await waitForHeader(true);
    expect(await $(EXPAND).getAttribute("aria-expanded")).toBe("false");
    await $(EXPAND).click();
    await browser.waitUntil(
      async () =>
        (await $(HOST).getAttribute("data-floating")) === "expanded" &&
        (await readRect(HOST)).height > 400,
      { timeout: 5_000, timeoutMsg: "点上按钮后浮窗没有展开" },
    );
    expect(await $(EXPAND).getAttribute("aria-expanded")).toBe("true");
    const timeline = await readRect(`${HOST} [data-testid="${TID_V4_TIMELINE}"]`);
    expect(timeline.height).toBeGreaterThan(100);
    // 滚动容器（含滚动条）止于输入框上方，不再延伸到输入框后面。
    expect(timeline.bottom).toBeLessThanOrEqual((await readRect(COMPOSER_DOCK)).top - 8);
    await saveThemeScreenshots("spfv-expanded");

    await $(EXPAND).click();
    await browser.waitUntil(
      async () =>
        (await $(HOST).getAttribute("data-floating")) === "collapsed" &&
        (await readRect(HOST)).height < 360,
      { timeout: 5_000, timeoutMsg: "点下按钮后浮窗没有收起" },
    );
    await saveThemeScreenshots("spfv-collapsed-with-header");
    await clickSlotTopLeft();
    await waitForHeader(false);
    await saveThemeScreenshots("spfv-collapsed");
    await focusFloatingComposer();
    await waitForHeader(true);
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_MINIMIZE}"]`).click();
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_BUBBLE}"]`).waitForDisplayed({
      timeout: 5_000,
    });
    await saveThemeScreenshots("spfv-minimized");
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_BUBBLE}"]`).click();
    await waitForHeader(true);
  });

  // 插件 UI 页面不在面板 DOM 里：它挂在 body 末尾的停靠层（position:fixed，无 z-index），
  // 按 tab 占位元素的坐标摆放。这里按 pluginUiPagePlane 的同一套样式复刻停靠层。
  it("SPFV-E2E-009 body 级插件页面层不被完整视图的面板外框遮挡", async () => {
    await waitForHostMode("floating");
    const slot = await readRect(SLOT);
    const hit = await browser.execute((rect) => {
      let parking = document.querySelector<HTMLElement>("[data-sandbox-page-parking]");
      if (!parking) {
        parking = document.createElement("div");
        parking.dataset.sandboxPageParking = "true";
        parking.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:visible";
        document.body.append(parking);
      }
      const page = document.createElement("div");
      page.dataset.e2eSpfvPluginPage = "true";
      Object.assign(page.style, {
        position: "fixed",
        inset: "auto",
        zIndex: "10",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        pointerEvents: "auto",
      });
      parking.append(page);
      // 取 slot 右下区域，避开吸附在左上的浮窗。
      const element = document.elementFromPoint(
        rect.left + rect.width * 0.85,
        rect.top + rect.height * 0.7,
      );
      const result = element?.closest("[data-e2e-spfv-plugin-page]")
        ? "plugin-page"
        : (element?.closest("[data-testid]")?.getAttribute("data-testid") ??
          element?.tagName ??
          null);
      page.remove();
      return result;
    }, slot);
    expect(hit).toBe("plugin-page");
  });

  it("SPFV-E2E-006 面板开关退出完整视图，重新打开不回到完整视图", async () => {
    await $(`${SIDE_FRAME} [data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await waitForHostMode("normal");
    // 收起有过渡动画，动画结束前再次切换会被吞掉；等面板真正收起再重新打开。
    await browser.waitUntil(
      () =>
        browser.execute((frameSelector) => {
          const panel = document.querySelector(frameSelector)?.parentElement;
          return !panel || panel.getBoundingClientRect().width < 10;
        }, SIDE_FRAME),
      { timeout: 5_000, timeoutMsg: "面板开关点击后面板没有收起" },
    );
    await ensureSidePaneExpanded();
    await browser.pause(300);
    expect(await $(HOST).getAttribute("data-side-pane-full-view-host")).toBe("normal");
    expect(await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`).isExisting()).toBe(true);
    expect(await readMainPaneMarker()).toBe(PANE_MARKER);
  });
});

/** 视觉验收：深浅两套主题各存一张整窗截图到 artifact 目录。 */
async function saveThemeScreenshots(name: string) {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  for (const theme of ["zai-light", "zai-dark"]) {
    await browser.execute((value) => {
      const actions = (
        window as typeof window & { __testActions?: { setTheme(theme: string): void } }
      ).__testActions;
      actions?.setTheme(value);
    }, theme);
    await browser.pause(300);
    await browser.saveScreenshot(join(artifactDir, `${name}-${theme}.png`));
  }
}

async function realKeys(keys: string[]) {
  const isMac = await browser.execute(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  const mapped = keys.map((key) => (key === "Control" && isMac ? "Command" : key));
  await browser.keys(mapped as never);
}

async function clickSlotTopLeft() {
  const slot = await readRect(SLOT);
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ x: Math.round(slot.left + 60), y: Math.round(slot.top + 60) })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
}

async function clickFullViewToggle() {
  const toggle = await $(`${SIDE_FRAME} [data-testid="${TID_SIDE_PANE_FULL_VIEW_TOGGLE}"]`);
  await toggle.waitForClickable({ timeout: 10_000 });
  await toggle.click();
}

async function waitForHostMode(mode: "normal" | "conversation" | "floating") {
  await browser.waitUntil(
    async () => (await $(HOST).getAttribute("data-side-pane-full-view-host")) === mode,
    { timeout: 5_000, timeoutMsg: `完整视图宿主没有进入 ${mode}` },
  );
}

async function waitForHeader(visible: boolean) {
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HEADER}"]`).isExisting()) === visible,
    { timeout: 5_000, timeoutMsg: `浮窗操作栏可见性应为 ${visible}` },
  );
}

async function focusFloatingComposer() {
  const input = await $(COMPOSER_INPUT);
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.click();
}

async function waitForComposerText(selector: string, expected: string) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (inputSelector) => document.querySelector(inputSelector)?.textContent ?? "",
        selector,
      )) === expected,
    { timeout: 5_000, timeoutMsg: `输入框文字应为 ${expected}` },
  );
}

async function markMainPane() {
  await browser.execute(
    (selector, marker) => {
      const pane = document.querySelector<HTMLElement>(selector);
      if (!pane) throw new Error("缺少主 SessionPane");
      pane.dataset.e2eSpfvMarker = marker;
    },
    MAIN_PANE,
    PANE_MARKER,
  );
}

function readMainPaneMarker() {
  return browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)?.dataset.e2eSpfvMarker ?? null,
    MAIN_PANE,
  );
}

async function markComposerEditor() {
  await browser.execute(
    (selector, marker) => {
      const editor = document.querySelector<HTMLElement>(selector);
      if (!editor) throw new Error("缺少输入框");
      editor.dataset.e2eSpfvMarker = marker;
    },
    COMPOSER_INPUT,
    EDITOR_MARKER,
  );
}

function readComposerEditorMarker() {
  return browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)?.dataset.e2eSpfvMarker ?? null,
    COMPOSER_INPUT,
  );
}

async function waitForHostTransitionsSettled() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) =>
          (document.querySelector(selector)?.getAnimations() ?? []).every(
            (animation) => animation.playState !== "running",
          ),
        HOST,
      ),
    { timeout: 5_000, timeoutMsg: "完整视图宿主的几何过渡没有结束" },
  );
}

function centerY(rect: Rect) {
  return rect.top + rect.height / 2;
}

function readRect(selector: string): Promise<Rect> {
  return browser.execute((target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`缺少元素 ${target}`);
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }, selector);
}

function rectsClose(a: Rect, b: Rect, tolerance: number) {
  return (
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function readLayoutWidths() {
  return browser.execute((sideFrameSelector) => {
    const width = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
    return {
      sidebar: width("#sidebar"),
      content: width("#content"),
      sideFrame: width(sideFrameSelector),
    };
  }, SIDE_FRAME);
}

async function ensureSidePaneExpanded() {
  const isExpanded = () =>
    browser.execute((frameSelector) => {
      const panel = document.querySelector(frameSelector)?.parentElement;
      return Boolean(
        panel &&
        panel.getBoundingClientRect().width > 100 &&
        getComputedStyle(panel).opacity === "1",
      );
    }, SIDE_FRAME);
  if (await isExpanded()) return;
  const toggle = await $(
    `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
  );
  await toggle.waitForClickable({ timeout: 10_000 });
  await toggle.click();
  await browser.waitUntil(isExpanded, { timeout: 10_000, timeoutMsg: "Side Pane 未实际展开" });
}

async function ensureTerminalTab() {
  if ((await $$(TAB).length) > 0) return;
  const launcher = await $('[data-side-pane-open-tab-item="terminal"]');
  await launcher.waitForClickable({ timeout: 10_000 });
  await launcher.click();
  await browser.waitUntil(async () => (await $$(TAB).length) === 1, {
    timeout: 10_000,
    timeoutMsg: "Terminal tab 没有打开",
  });
}
