import { describe, expect, it } from "vitest";
import { readSourceTextAsync } from "./readSourceText.js";

describe("plugin settings scope interaction", () => {
  it("explains workspace overrides and exposes a reset action", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/PluginsSection.tsx", import.meta.url),
    );

    expect(source).toContain('id: "settings.plugins.scope.inheritedUser"');
    expect(source).toContain('id: "settings.plugins.scope.userDefault"');
    expect(source).toContain('id: "settings.plugins.scope.workspaceOverride"');
    expect(source).toContain('id: "settings.plugins.scope.workspaceHint"');
    expect(source).toContain('id: "settings.plugins.scope.restoreUserDefault"');
    expect(source).toContain('data-testid="plugin-settings-workspace-scope-hint"');
    expect(source).toContain('data-testid="plugin-settings-enabled-pending"');
    expect(source).toContain("aria-busy={togglingPluginId === plugin.id}");
    expect(source).toContain("handleResetPluginConfig(plugin.id)");
  });

  it("allows a resource to override the compact default scope label", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/SettingsScopeBadge.tsx", import.meta.url),
    );

    expect(source).toContain("label?: string");
    expect(source).toContain("{label ?? intl.formatMessage({ id: `settings.scope.${scope}` })}");
  });
});
