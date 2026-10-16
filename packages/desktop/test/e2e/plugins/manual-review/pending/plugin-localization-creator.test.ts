import { clearAppData, setInputValueByTestIdDom } from "../../../helpers/desktop-app.js";
import { resolveE2EToolPath } from "../../../helpers/e2e-runtime-paths.js";
import {
  getV4ComposerText,
  isV4ComposerFocused,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import {
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  addLifecycleMarketplaceThroughUi,
  assertPluginStoreFitsViewport,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginControlText,
  installPluginThroughUi,
  openPluginManagementSettings,
  openPluginSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginControl,
} from "../../../helpers/plugin-management-lifecycle.js";

describe("PLM-LC-018/019/020 本地化与插件创建入口", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("两处添加菜单分别创建真实 skill 草稿并保留来源添加与中文管理搜索", async function () {
    this.timeout(300000);
    requirePluginManualReview();
    const fixture = await createPluginLifecycleFixture();
    await openPluginSettings();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1440, height: 1000 });
    await addLifecycleMarketplaceThroughUi(fixture);
    const countMarketCards = () =>
      browser.execute(
        (marketplace) =>
          [...document.querySelectorAll<HTMLElement>('[data-testid="plugin-store-card"]')].filter(
            (card) => card.dataset.pluginId?.endsWith(`@${marketplace}`),
          ).length,
        PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      );
    expect(await countMarketCards()).toBe(8);
    await capturePluginManualReview("PLM-LC-001", "all-plugins-expanded");
    const groupKey = `marketplace:${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`;
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countMarketCards()).toBe(6);
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countMarketCards()).toBe(8);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    for (const query of ["shengmingzhouqi", "SMZQ"]) {
      await setInputValueByTestIdDom("plugin-store-search", query);
      await waitForPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
    }
    await setInputValueByTestIdDom("plugin-store-search", "");
    await openAddMenu("plugin-store-create");
    expect(await getPluginControlText("plugin-add-menu")).toContain("创建插件");
    expect(await getPluginControlText("plugin-add-menu")).not.toContain("录制");
    await clickPluginControl("plugin-create-menu-item");
    await expectCreatorDraft();
    await capturePluginManualReview("PLM-LC-019", "store-creator-draft");
    await openPluginManagementSettings();
    await clickPluginControl("settings-back-button");
    await expectCreatorDraft(false);
    await openPluginManagementSettings();
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    expect(
      await getPluginControlText("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID }),
    ).toContain("生命周期测试插件");
    for (const query of ["生命周期测试插件", "shengmingzhouqi", "smzq"]) {
      await setInputValueByTestIdDom("plugin-settings-search", query);
      await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    }
    await setInputValueByTestIdDom("plugin-settings-search", "");
    await openAddMenu("plugin-settings-add");
    await clickPluginControl("plugin-create-menu-item");
    await expectCreatorDraft();
    await openPluginManagementSettings();
    await openAddMenu("plugin-settings-add");
    await clickPluginControl("plugin-store-add-source-menu-item");
    await waitForPluginControl("plugin-store-add-source-dialog");
    expect(
      await browser.execute(() => document.querySelector('[data-testid="settings-page"]') === null),
    ).toBe(true);
    const invalidSource = resolveE2EToolPath("plugin-creator", "missing-marketplace");
    await setInputValueByTestIdDom("plugin-store-add-source-input", invalidSource);
    await clickPluginControl("plugin-store-add-source-submit");
    await waitForPluginControl("plugin-store-add-source-error");
    expect(
      await browser.execute(
        () =>
          document.querySelector<HTMLInputElement>('[data-testid="plugin-store-add-source-input"]')
            ?.value,
      ),
    ).toBe(invalidSource);
    await browser.keys("Escape");
    // Electron 窗口最小宽度为 480；该宽度仍进入共享 UI 的手机断点。
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 480, height: 844 });
    await setInputValueByTestIdDom("plugin-store-search", "smzq");
    await waitForPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
    await openAddMenu("plugin-store-create");
    const text = await getPluginControlText("plugin-add-menu");
    expect(text).toContain("Create plugin");
    expect(text).toContain("Add plugin marketplace");
    await capturePluginManualReview("PLM-LC-020", "en-dark-narrow-add-menu");
    await assertPluginStoreFitsViewport();
  });
});
async function openAddMenu(testId: string) {
  await waitForPluginControl(testId);
  await browser.execute((id) => {
    document
      .querySelector<HTMLElement>(`[data-testid="${id}"]`)
      ?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
  }, testId);
  await waitForPluginControl("plugin-add-menu");
  expect(
    await browser.execute(
      () => document.querySelectorAll('[data-testid="plugin-add-menu"] [role="menuitem"]').length,
    ),
  ).toBe(2);
}
async function expectCreatorDraft(checkFocus = true) {
  // 旧草稿仍挂载在设置页背后，必须先等创建请求真正关闭设置，避免读到上次草稿。
  await browser.waitUntil(
    async () => browser.execute(() => !document.querySelector('[data-testid="settings-page"]')),
    { timeout: 30000 },
  );
  await waitForV4Pane((s) => s.sessionId === "draft", "创建插件未进入新草稿");
  await browser.waitUntil(
    async () => (await getV4ComposerText())?.includes("$plugin-creator") === true,
    { timeout: 30000 },
  );
  const text = await getV4ComposerText();
  expect(text).toContain("/SKILL.md)");
  expect(text?.endsWith(" ")).toBe(true);
  if (checkFocus)
    await browser.waitUntil(isV4ComposerFocused, {
      timeout: 15000,
      timeoutMsg: "创建插件后输入框未获得焦点",
    });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft" && snapshot.rowCount === 0 && !snapshot.canStop,
    "创建入口自动发送了任务",
  );
}
