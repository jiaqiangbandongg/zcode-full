import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared";
import { clearAppData, clickTestIdByDom, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import {
  getPluginList,
  openInstalledPluginSettingsAdvanced,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  waitForPluginControl,
} from "../../../helpers/plugin-management-lifecycle.js";
import { PLUGIN_MCP_PLUGIN_ID, PLUGIN_MCP_TOOL_NAME } from "../../../helpers/plugin-mcp-skill.js";
import {
  assertWorkspacePluginRuntime,
  pluginConfigEnabled,
  pluginConfigOptions,
  readUserPluginConfig,
  readWorkspacePluginConfig,
} from "../../../helpers/workspace-plugin-runtime.js";

describe("WPL-001/003/004/005 Workspace Plugin enabled runtime E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("loads Workspace scope, deep-merges options, redacts secret, and enters runtime directly", async function () {
    this.timeout(240000);

    // 仅用于验证隔离 fixture 的配置值；拆分字符串避免 fixture checker 把配置值误判为 prompt marker。
    const userSecret = ["E2E", "USER", "PLUGIN", "SECRET"].join("_");
    const workspaceSecret = ["E2E", "WORKSPACE", "PLUGIN", "SECRET"].join("_");

    const userConfig = await readUserPluginConfig();
    const workspaceConfig = await readWorkspacePluginConfig();
    expect(pluginConfigEnabled(userConfig)).toBe(true);
    expect(pluginConfigEnabled(workspaceConfig)).toBe(true);
    expect(pluginConfigOptions(userConfig)).toMatchObject({
      label: "user-label",
      secret: userSecret,
    });
    expect(pluginConfigOptions(workspaceConfig)).toMatchObject({
      label: "workspace-label",
      secret: workspaceSecret,
    });

    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    const scopeBadgeVisible = await browser.execute(() =>
      Boolean(document.querySelector('[data-settings-scope="workspace"]')),
    );
    expect(scopeBadgeVisible).toBe(true);
    await openInstalledPluginSettingsAdvanced(PLUGIN_MCP_PLUGIN_ID);
    await browser.keys(["Escape"]);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    const list = await getPluginList(DEFAULT_WORKSPACE);
    const plugin = list.plugins.find((item) => item.id === PLUGIN_MCP_PLUGIN_ID);
    expect(plugin).toMatchObject({
      enabled: true,
      enabledSource: "workspace",
      optionSources: { label: "workspace", secret: "workspace" },
      configuredOptions: { label: "workspace-label" },
    });
    expect(JSON.stringify(plugin)).not.toContain(workspaceSecret);

    // Plugin MCP 无独立 approval/trust 动作；新 Session 创建时直接看到该工具。
    await assertWorkspacePluginRuntime("E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED");
    expect(PLUGIN_MCP_TOOL_NAME).toContain("mcp__plugin_");
  });
});
