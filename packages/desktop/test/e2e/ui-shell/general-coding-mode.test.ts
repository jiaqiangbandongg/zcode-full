import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_LOGIN_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_SETTINGS_BUTTON,
  TID_TERMINAL_TOGGLE,
  testId,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom } from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

// MODE-01/02/03：只操作应用 UI 和本地 PTY，不发送模型请求。
describe("通用与编程模式 M1", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MODE-01 设置页与头像菜单共用偏好，刷新后保留", async () => {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "appearance"));
    const select = '[role="combobox"][aria-label="界面模式"]';
    await $(select).waitForDisplayed();
    await $(select).click();
    await clickText('[role="option"]', "通用模式");
    await waitForMode("general");
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await switchMode("coding");
    await browser.refresh();
    await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).waitForDisplayed({ timeout: 30000 });
    await waitForMode("coding");
    expect(await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).isExisting()).toBe(true);
  });

  it("MODE-02/03 隐藏新建入口，保留已打开审查、终端和 PTY", async () => {
    await switchMode("general");
    await clickTestIdByDom(TID_SIDE_PANE_TOGGLE);
    await $('[data-side-pane-open-tab-item="browser"]').waitForDisplayed();
    expect(await $('[data-side-pane-open-tab-item="review"]').isExisting()).toBe(false);
    expect(await $('[data-side-pane-open-tab-item="terminal"]').isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).isExisting()).toBe(false);

    await switchMode("coding");
    await $('[data-side-pane-open-tab-item="review"]').click();
    await $('[data-side-pane-tab-id="git"]').waitForDisplayed();
    await $("[data-side-pane-add-tab-trigger]").click();
    await $('[data-side-pane-add-item="terminal"]').click();
    await $('[data-side-pane-tab-id^="terminal:"]').waitForDisplayed();
    await clickTestIdByDom(TID_TERMINAL_TOGGLE);
    await browser.waitUntil(async () => (await terminalHeight()) > 50);
    const before = await readTabs();
    const terminalId = before.find((tab) => tab.id.startsWith("terminal:"))!.id;

    await switchMode("general");
    expect(await readTabs()).toEqual(before);
    expect(await terminalHeight()).toBeGreaterThan(50);
    expect(await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).isExisting()).toBe(false);
    expect(await $('button[aria-label="新建终端"]').isExisting()).toBe(false);
    await $("[data-side-pane-add-tab-trigger]").click();
    expect(await $('[data-side-pane-add-item="terminal"]').isExisting()).toBe(false);
    expect(await visibleTexts('[role="menuitem"]')).not.toContain("审查");
    await browser.keys("Escape");
    // 等待 Radix 菜单退出，避免终端点击落到仍在退场的“浏览器”菜单项上。
    await browser.waitUntil(
      async () => !(await $('[data-slot="dropdown-menu-content"]').isExisting()),
    );

    const terminalInput = $("[data-workspace-side-frame] .xterm-helper-textarea");
    await terminalInput.waitForExist();
    // xterm 的输入 textarea 位于负 z-index，不能作为真实点击目标；点击可见终端后校验焦点。
    await $("[data-workspace-side-frame] .xterm-screen").click();
    await browser.waitUntil(async () => terminalInput.isFocused());
    await browser.keys("printf 'MODE_%s\\n' PTY_ALIVE");
    await browser.keys("Enter");
    try {
      await browser.waitUntil(async () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-workspace-side-frame] .xterm-rows > div")].some(
            (row) => row.textContent?.trim() === "MODE_PTY_ALIVE",
          ),
        ),
      );
    } finally {
      const artifactDir = join(process.cwd(), ".e2e-artifacts", "general-coding-mode");
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(join(artifactDir, "general-mode-pty.png"));
    }

    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-side-pane-tab-id="git"]')!.click(),
    );
    await browser.waitUntil(
      async () => (await readTabs()).find((tab) => tab.id === "git")?.active === true,
    );
    await switchMode("coding");
    await switchMode("general");
    expect((await readTabs()).find((tab) => tab.id === "git")?.active).toBe(true);
    expect((await readTabs()).map((tab) => tab.id)).toContain(terminalId);

    await browser.execute((id) => {
      const tab = [...document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")].find(
        (item) => item.dataset.sidePaneTabId === id,
      );
      tab?.querySelector<HTMLButtonElement>("button")?.click();
    }, terminalId);
    await browser.waitUntil(async () => !(await readTabs()).some((tab) => tab.id === terminalId));
    expect((await readTabs()).find((tab) => tab.id === "git")?.active).toBe(true);
  });
});

async function switchMode(mode: "general" | "coding") {
  // Radix 的退出动画期间仍有旧菜单层；等待它卸载，避免下一次点击被当作关闭旧层。
  await browser.waitUntil(
    async () => !(await $('[data-slot="dropdown-menu-content"]').isExisting()),
  );
  await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).waitForDisplayed();
  await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
  await clickText('[role="menuitem"]', "界面模式");
  await clickText('[role="menuitemradio"]', mode === "general" ? "通用模式" : "编程模式");
  await browser.keys("Escape");
  await waitForMode(mode);
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).getAttribute("aria-expanded")) === "false",
  );
}

async function clickText(selector: string, text: string) {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (query, label) => {
            const element = [...document.querySelectorAll<HTMLElement>(query)].find(
              (item) =>
                item.getBoundingClientRect().width > 0 && item.textContent?.trim() === label,
            );
            if (!element) return false;
            element.click();
            return true;
          },
          selector,
          text,
        ),
      { timeout: 10000, timeoutMsg: `未找到 ${text}` },
    );
  } catch (error) {
    const diagnostic = await browser.execute(() => ({
      trigger: document.querySelector('[data-testid="login-trigger"]')?.outerHTML,
      menus: [...document.querySelectorAll('[role*="menu"]')].map((item) => ({
        role: item.getAttribute("role"),
        text: item.textContent,
        state: item.getAttribute("data-state"),
        rect: item.getBoundingClientRect().toJSON(),
      })),
      bodyPointerEvents: document.body.style.pointerEvents,
    }));
    throw new Error(`${String(error)}; UI=${JSON.stringify(diagnostic)}`);
  }
}

async function waitForMode(mode: string) {
  await browser.waitUntil(async () =>
    browser.execute((expected) => localStorage.getItem("zcode-interface-mode") === expected, mode),
  );
}

async function readTabs() {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")].map((tab) => ({
      id: tab.dataset.sidePaneTabId!,
      active: tab.dataset.state === "active",
    })),
  );
}

async function terminalHeight() {
  return browser.execute(
    () =>
      document.querySelector("[data-workspace-terminal-frame]")?.getBoundingClientRect().height ??
      0,
  );
}

async function visibleTexts(selector: string) {
  return browser.execute(
    (query) =>
      [...document.querySelectorAll<HTMLElement>(query)]
        .filter((item) => item.getBoundingClientRect().width > 0)
        .map((item) => item.textContent?.trim()),
    selector,
  );
}
