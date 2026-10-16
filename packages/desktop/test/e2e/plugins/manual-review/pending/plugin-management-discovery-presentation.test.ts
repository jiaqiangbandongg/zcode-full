import { setInputValueByTestIdDom, clearAppData } from "../../../helpers/desktop-app.js";
import {
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  addLifecycleMarketplaceThroughUi,
  assertPluginStoreFitsViewport,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginControlText,
  hasPluginControl,
  installPluginThroughUi,
  openManageView,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginControl,
} from "../../../helpers/plugin-management-lifecycle.js";

const DISCOVERY_TIMEOUT_MS = 180000;

describe("PLM-LC-001/002 插件商店发现、入口与展示 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("覆盖默认分段、搜索、折叠、Card/Installed/Manage 入口与 pairwise 展示", async function () {
    this.timeout(DISCOVERY_TIMEOUT_MS);
    requirePluginManualReview();

    const fixture = await createPluginLifecycleFixture();
    await openPluginSettings();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1440, height: 1000 });

    expect(await isPressed("plugin-store-segment-public")).toBe(true);
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");
    expect(await isPressed("plugin-store-segment-personal")).toBe(true);

    await setInputValueByTestIdDom("plugin-store-search", "生命周期测试插件");
    await waitForPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
    expect(await getPluginControlText("plugin-store-list")).toContain("生命周期测试插件");
    await setInputValueByTestIdDom("plugin-store-search", "");

    const groupKey = `marketplace:${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`;
    await waitForPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countPluginCards()).toBeGreaterThanOrEqual(8);
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countPluginCards()).toBe(6);
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countPluginCards()).toBeGreaterThanOrEqual(8);

    await setInputValueByTestIdDom("plugin-store-search", "生命周期测试插件");
    await setMainScrollTop(180);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await capturePluginManualReview("PLM-LC-001", "detail-from-card");
    await clickPluginControl("plugin-store-detail-back");
    expect(await inputValue("plugin-store-search")).toBe("生命周期测试插件");
    expect(await isPressed("plugin-store-segment-personal")).toBe(true);
    expect(await mainScrollTop()).toBeGreaterThanOrEqual(0);

    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    await setInputValueByTestIdDom("plugin-store-search", "");
    await waitForPluginControl("plugin-store-installed-strip");
    await clickPluginControl("plugin-store-installed-item", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-detail", { pluginId: PLUGIN_LIFECYCLE_ID });
    await clickPluginControl("plugin-store-detail-back");
    await openManageView();
    await waitForPluginControl("plugin-store-installed-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    await capturePluginManualReview("PLM-LC-001", "manage-installed");
    await clickPluginControl("plugin-store-manage-back");

    await assertPluginStoreFitsViewport();
    await capturePluginManualReview("PLM-LC-002", "zh-zai-light-wide");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 720, height: 900 });
    await assertPluginStoreFitsViewport();
    expect(await hasPluginControl("plugin-store-create")).toBe(true);
    expect(await hasPluginControl("plugin-store-sources-open")).toBe(true);
    await capturePluginManualReview("PLM-LC-002", "en-zai-dark-narrow");
  });
});

async function isPressed(testIdValue: string): Promise<boolean> {
  return browser.execute(
    (id) =>
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getAttribute("aria-pressed") ===
      "true",
    testIdValue,
  );
}

async function countPluginCards(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid="plugin-store-card"]').length,
  );
}

async function inputValue(testIdValue: string): Promise<string> {
  return browser.execute(
    (id) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)?.value ?? "",
    testIdValue,
  );
}

async function setMainScrollTop(value: number): Promise<void> {
  await browser.execute((next) => {
    const root = document.querySelector<HTMLElement>('[data-testid="plugin-store-root"]');
    const main = root?.closest("main");
    if (main) main.scrollTop = next;
  }, value);
}

async function mainScrollTop(): Promise<number> {
  return browser.execute(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="plugin-store-root"]');
    return root?.closest("main")?.scrollTop ?? 0;
  });
}
