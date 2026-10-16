import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pluginStorePageSource = readFileSync(
  fileURLToPath(new URL("../src/settings/PluginStorePage.tsx", import.meta.url)),
  "utf8",
);
const workspaceShellSource = readFileSync(
  fileURLToPath(
    new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url),
  ),
  "utf8",
);

describe("Workspace Sidebar terminology", () => {
  it("names the plugin entry as the plugin marketplace", () => {
    expect(enUS["workspace.openPluginsSettings"]).toBe("Plugin Marketplace");
    expect(zhCN["workspace.openPluginsSettings"]).toBe("插件市场");
  });

  it("uses the plugin marketplace terminology for the marketplace page title", () => {
    expect(pluginStorePageSource).toContain(
      'intl.formatMessage({ id: "workspace.openPluginsSettings" })',
    );
  });

  it("uses the plugin marketplace terminology for desktop and mobile detail breadcrumbs", () => {
    expect(
      workspaceShellSource.match(
        /sectionLabel=\{intl\.formatMessage\(\{\s*id: "workspace\.openPluginsSettings",\s*\}\)\}/g,
      ),
    ).toHaveLength(2);
  });
});
