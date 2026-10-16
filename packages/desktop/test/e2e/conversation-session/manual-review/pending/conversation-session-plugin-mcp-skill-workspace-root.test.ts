import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  PLUGIN_MCP_PLUGIN_ID,
  PLUGIN_MCP_PLUGIN_ROOT,
} from "../../../helpers/plugin-mcp-skill.js";
import {
  assertWorkspacePluginRuntime,
  readWorkspacePluginConfig,
} from "../../../helpers/workspace-plugin-runtime.js";

describe("WPL-014 Workspace Plugin root E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("activates a project Plugin root without a User package record", async function () {
    this.timeout(240000);

    const { storageRoot } = getE2EAppDataPaths();
    const workspaceConfig = await readWorkspacePluginConfig();
    expect(workspaceConfig.plugins).toMatchObject({
      dirs: [PLUGIN_MCP_PLUGIN_ROOT],
      enabledPlugins: { [PLUGIN_MCP_PLUGIN_ID]: true },
    });

    const installedRecordsPath = join(storageRoot, "cli", "plugins", "installed_plugins.json");
    expect(existsSync(installedRecordsPath)).toBe(false);

    // Workspace dirs 由新 App 的 runtime discovery 读取；当前 E2E 不把 Host 官方 cache
    // refresh 的 overview 列表当作 root discovery 的唯一证据。
    await assertWorkspacePluginRuntime("E2E_PLUGIN_MCP_PING_WORKSPACE_ROOT");
  });
});
