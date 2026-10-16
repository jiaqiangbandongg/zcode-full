import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  addLifecycleMarketplaceThroughUi,
  createPluginLifecycleFixture,
  getPluginOverview,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  pluginStoragePath,
  waitForPluginCard,
} from "../../../helpers/plugin-management-lifecycle.js";
import {
  E2E_REPLY_TOKEN,
  getToolCallBlockByToolName,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForUpstreamRequestContaining,
} from "../../../helpers/conversation-session.js";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "../../../helpers/conversation-session-tool-cross-product.js";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "../../../helpers/plugin-mcp-skill.js";

describe("WPL-006 Workspace Plugin missing package E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps the project declaration without auto-install, then runs after explicit install", async function () {
    this.timeout(300000);

    const { workspace } = getE2EAppDataPaths();
    const workspaceConfigPath = join(workspace, ".zcode", "config.json");
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await writeFile(
      workspaceConfigPath,
      `${JSON.stringify({ plugins: { enabledPlugins: { [PLUGIN_LIFECYCLE_ID]: true } } }, null, 2)}\n`,
      "utf8",
    );

    const fixture = await createPluginLifecycleFixture("1.0.0");
    const installedPluginsPath = pluginStoragePath("installed_plugins.json");
    expect(await readOptionalText(installedPluginsPath)).toBeNull();

    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickTestIdByDom("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID);

    const beforeInstall = await getPluginOverview();
    expect(beforeInstall.availablePlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: PLUGIN_LIFECYCLE_ID,
          installed: false,
          marketplace: PLUGIN_LIFECYCLE_MARKETPLACE_ID,
        }),
      ]),
    );
    expect(beforeInstall.installedPlugins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PLUGIN_LIFECYCLE_ID })]),
    );
    expect(await readOptionalText(installedPluginsPath)).toBeNull();

    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    const afterInstall = await getPluginOverview();
    expect(afterInstall.installedPlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: PLUGIN_LIFECYCLE_ID, scope: "user" }),
      ]),
    );
    expect(await readFile(workspaceConfigPath, "utf8")).toContain(PLUGIN_LIFECYCLE_ID);
    expect(await readFile(installedPluginsPath, "utf8")).toContain(PLUGIN_LIFECYCLE_ID);

    await startNewTask();
    await assertLifecycleRuntimeAfterExplicitInstall();
  });
});

async function assertLifecycleRuntimeAfterExplicitInstall(): Promise<void> {
  await prepareConversationE2E();
  await ensureToolCrossProductFullAccessMode();
  await startNewTask();
  const marker = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`;
  await sendPrompt(
    `${marker}: Call ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} exactly once, then reply with exactly ${E2E_REPLY_TOKEN}.`,
  );
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000, {
    advertisedToolName: PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  });
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_LIFECYCLE_MCP_TOOL_NAME)).toBe(true);
  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      return Boolean((await getToolCallBlockByToolName(PLUGIN_LIFECYCLE_MCP_TOOL_NAME))?.exists);
    },
    { timeout: 60000, timeoutMsg: "Missing-package Plugin MCP call did not render" },
  );
  await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
