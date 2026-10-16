import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import { waitForUpstreamRequestContaining } from "../../../helpers/conversation-session.js";
import { findUpstreamRequestContaining } from "../../../helpers/plugin-mcp-skill.js";
import { prepareV4ConversationE2E, sendV4Prompt } from "../../../helpers/v4-conversation.js";
import {
  PLUGIN_INLINE_ID,
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  getPluginOverview,
  openManageView,
  openPluginCard,
  openPluginSettings,
  pluginDataPath,
  pluginPathExists,
  requirePluginManualReview,
  restartPluginLifecycleApp,
  seedInlineLifecyclePlugin,
  uninstallPluginThroughUi,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "../../../helpers/plugin-management-lifecycle.js";

const BUILTIN_ID = "skill-creator@zcode-plugins-official";
const BUILTIN_TIMEOUT_MS = 240000;

describe("PLM-LC-006/009 Builtin 抑制恢复与 inline smoke E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Builtin 卸载跨重启抑制并干净恢复，inline 在 Personal/Detail/Manage 可见", async function () {
    this.timeout(BUILTIN_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await waitForPluginCard(BUILTIN_ID, 60000);
    await openPluginCard(BUILTIN_ID);
    const builtinCachePath = (await getPluginList()).plugins.find(
      (plugin) => plugin.id === BUILTIN_ID,
    )?.rootPath;
    expect(builtinCachePath).toBeTruthy();
    expect(pluginPathExists(builtinCachePath!)).toBe(true);
    await seedBuiltinUserState();
    await uninstallPluginThroughUi(BUILTIN_ID, true);
    expect(
      (await getPluginOverview()).restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
    ).toBe(true);
    expect(pluginPathExists(pluginDataPath(BUILTIN_ID))).toBe(false);
    // 内置 cache 是详情与恢复所需的不可变 Catalog 资产，卸载只抑制 Runtime 并清理 data/config。
    expect(pluginPathExists(builtinCachePath!)).toBe(true);
    expect(await builtinOptionsExist()).toBe(false);

    await restartPluginLifecycleApp();
    await openPluginSettings();
    await waitUntilPluginOverview(
      (overview) => overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin suppression did not survive restart",
      60000,
    );
    await waitForPluginCard(BUILTIN_ID, 60000);
    await capturePluginManualReview("PLM-LC-006", "restorable-builtin");
    await openPluginCard(BUILTIN_ID);
    await clickPluginControl("plugin-store-install", { pluginId: BUILTIN_ID });
    await waitUntilPluginOverview(
      (overview) => !overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin did not restore cleanly",
      120000,
    );
    expect(await builtinOptionsExist()).toBe(false);
    expect(pluginPathExists(join(pluginDataPath(BUILTIN_ID), "state.json"))).toBe(false);

    await seedInlineLifecyclePlugin();
    await restartPluginLifecycleApp();
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_INLINE_ID, 60000);
    await openPluginCard(PLUGIN_INLINE_ID);
    await waitForPluginControl("plugin-store-component-section", { componentKind: "skill" });
    expect(
      (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_INLINE_ID)?.enabled,
    ).toBe(true);

    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await prepareV4ConversationE2E();
    const inlineRuntimeRequest = `E2E_PLUGIN_INLINE_REQUEST_${Date.now()}`;
    await sendV4Prompt(
      `${inlineRuntimeRequest}: invoke the Skill named inline-lifecycle, then reply with exactly upstream-e2e-ok.`,
    );
    await waitForUpstreamRequestContaining(inlineRuntimeRequest, 60000);
    const inlineRequest = await findUpstreamRequestContaining(
      "E2E_PLUGIN_INLINE_LIFECYCLE_RUNTIME",
      60000,
    );
    expect(JSON.stringify(inlineRequest?.requestJson)).toContain(inlineRuntimeRequest);

    await openPluginSettings();
    await openManageView();
    await waitForPluginControl("plugin-store-installed-row", { pluginId: PLUGIN_INLINE_ID });
    await capturePluginManualReview("PLM-LC-009", "inline-manage-smoke");
  });
});

async function seedBuiltinUserState(): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  await writeJson(configPath, {
    ...config,
    plugins: { ...plugins, options: { ...options, [BUILTIN_ID]: { e2e: "purge-me" } } },
  });
  await writeJson(join(pluginDataPath(BUILTIN_ID), "state.json"), { purge: true });
}

async function builtinOptionsExist(): Promise<boolean> {
  const configPath = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  return BUILTIN_ID in options;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
