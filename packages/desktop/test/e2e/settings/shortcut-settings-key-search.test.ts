import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { sel } from "../helpers/selectors.js";

/**
 * 快捷键「按组合键搜索」E2E（spec docs/desktop/shortcut-settings-spec.md §8/§10）：
 * 武装态捕获组合 → 物理等价口径过滤命令表 → 清除恢复全量 → 无命中空态 → Escape 退出武装态。
 */
describe("快捷键按组合键搜索 E2E", () => {
  before(async () => {
    await waitForDefaultWorkspaceReady(30_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await openShortcutSettings();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SC-11: 武装后按组合键，过滤出物理等价绑定的命令；清除后恢复全量", async function () {
    this.timeout(90_000);

    // 默认绑定 CmdOrCtrl+k（openCommandCenter）：武装后按下平台主修饰+K 即命中。
    // 录制器平台归一后捕获串与默认串同为 CmdOrCtrl+k —— 等价归一路径（win 显式
    // Ctrl 默认 vs CmdOrCtrl 产物的互检）在单测覆盖，这里验证端到端过滤行为。
    await clickTestIdByDom("settings-shortcut-key-search", {
      timeout: 15_000,
      timeoutMsg: "搜索框右端没有出现按组合键搜索按钮",
    });
    expect(await $(sel("settings-shortcut-key-search")).getAttribute("aria-pressed")).toBe("true");

    await dispatchShortcut("k", "KeyK");
    // 捕获徽标出现；列表过滤为绑定该组合的命令（openCommandCenter 在、toggleSidebar 不在）
    await $(sel("settings-shortcut-key-search-clear")).waitForDisplayed({ timeout: 10_000 });
    await $(sel("settings-shortcut-row-openCommandCenter")).waitForDisplayed({ timeout: 10_000 });
    expect(await $(sel("settings-shortcut-row-toggleSidebar")).isExisting()).toBe(false);

    // 清除按键过滤后恢复全量列表
    await clickTestIdByDom("settings-shortcut-key-search-clear", {
      timeout: 10_000,
      timeoutMsg: "捕获组合的清除按钮没有出现",
    });
    await $(sel("settings-shortcut-row-toggleSidebar")).waitForDisplayed({ timeout: 10_000 });
    expect(await $(sel("settings-shortcut-row-openCommandCenter")).isExisting()).toBe(true);
  });

  it("SC-12: 无命中组合展示空态；Escape 退出武装态不再吞键", async function () {
    this.timeout(60_000);

    await clickTestIdByDom("settings-shortcut-key-search", {
      timeout: 10_000,
      timeoutMsg: "搜索框右端没有出现按组合键搜索按钮",
    });
    // CmdOrCtrl+Shift+9 未被任何命令绑定 → 空态文案
    await dispatchShortcut("9", "Digit9", { shiftKey: true });
    await $(sel("settings-shortcut-search-empty")).waitForDisplayed({ timeout: 10_000 });
    expect(await $(sel("settings-shortcut-row-openCommandCenter")).isExisting()).toBe(false);

    // 清除空态过滤，重新武装后按 Escape 退出（aria-pressed 复位、列表仍在）
    await clickTestIdByDom("settings-shortcut-key-search-clear", {
      timeout: 10_000,
      timeoutMsg: "捕获组合的清除按钮没有出现",
    });
    await $(sel("settings-shortcut-row-openCommandCenter")).waitForDisplayed({ timeout: 10_000 });
    await clickTestIdByDom("settings-shortcut-key-search", { timeout: 10_000 });
    expect(await $(sel("settings-shortcut-key-search")).getAttribute("aria-pressed")).toBe("true");
    await dispatchKey("Escape", "Escape", {});
    await browser.pause(300);
    expect(await $(sel("settings-shortcut-key-search")).getAttribute("aria-pressed")).toBe("false");
    // 退出武装态后命令行仍完整（Escape 只退出捕获，不动过滤/列表）
    expect(await $(sel("settings-shortcut-row-openCommandCenter")).isDisplayed()).toBe(true);
  });
});

async function openShortcutSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "shortcuts"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现快捷键分区入口",
  });
}

/** 按平台主修饰键（mac=Meta，其他=Ctrl）派发合成 keydown 到 window（capture 监听可收到）。 */
async function dispatchShortcut(key: string, code: string, opts: { shiftKey?: boolean } = {}) {
  const isMac = await browser.execute(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await dispatchKey(key, code, {
    metaKey: isMac,
    ctrlKey: !isMac,
    shiftKey: opts.shiftKey ?? false,
  });
}

async function dispatchKey(
  key: string,
  code: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
) {
  await browser.execute(
    (eventKey, eventCode, metaKey, ctrlKey, shiftKey) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: eventKey,
          code: eventCode,
          metaKey,
          ctrlKey,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    code,
    modifiers.metaKey ?? false,
    modifiers.ctrlKey ?? false,
    modifiers.shiftKey ?? false,
  );
}
