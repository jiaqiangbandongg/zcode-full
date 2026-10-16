import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared";
import { clearAppData, clickTestIdByDom } from "../../../helpers/desktop-app.js";
import {
  getPluginList,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  waitForPluginControl,
} from "../../../helpers/plugin-management-lifecycle.js";
import { PLUGIN_MCP_PLUGIN_ID } from "../../../helpers/plugin-mcp-skill.js";
import {
  assertWorkspacePluginRuntime,
  pluginConfigEnabled,
  readWorkspacePluginConfig,
} from "../../../helpers/workspace-plugin-runtime.js";

describe("WPL-002 Workspace Plugin User inheritance and cold-start reload E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("inherits User enablement when Workspace omits the key", async function () {
    this.timeout(240000);

    expect(pluginConfigEnabled(await readWorkspacePluginConfig())).toBeUndefined();
    const plugin = (await getPluginList()).plugins.find((item) => item.id === PLUGIN_MCP_PLUGIN_ID);
    expect(plugin).toMatchObject({ enabled: true, enabledSource: "user" });

    // User/Workspace 是同一 Host inventory 的两个配置视图。切到 Workspace 后仍应看到
    // 继承的插件，且来源标签必须明确是 User，而不是把继承项当成 Workspace 资源归属。
    await openPluginManagementSettings();
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    expect(
      await browser.execute((pluginId) => {
        const row = document.querySelector<HTMLElement>(
          `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${pluginId}"]`,
        );
        return {
          checked:
            row?.querySelector<HTMLElement>('[data-testid="plugin-settings-enabled-switch"]')
              ?.dataset.state === "checked",
          source: row?.querySelector<HTMLElement>("[data-settings-scope]")?.dataset.settingsScope,
        };
      }, PLUGIN_MCP_PLUGIN_ID),
    ).toEqual({ checked: true, source: "user" });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    await assertWorkspacePluginRuntime("E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED");
  });
});
