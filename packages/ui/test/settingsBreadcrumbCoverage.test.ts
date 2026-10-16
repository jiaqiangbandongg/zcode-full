import { readSourceText } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

function readSettingsSection(name: string): string {
  return readSourceText(new URL(`../src/settings/${name}.tsx`, import.meta.url), "utf8");
}

describe("Settings breadcrumb coverage", () => {
  it.each([
    "PluginStorePage",
    "PluginsSection",
    "SubagentsSection",
    "McpSettingsSection",
    "CommandsSection",
    "HooksSection",
  ])("projects page-level navigation from %s", (section) => {
    const source = readSettingsSection(section);
    expect(source).toContain("SettingsBreadcrumbReporter");
    expect(source).toContain("onSectionSelect");
  });

  it("projects automation edit navigation from the views that own dirty-state back handling", () => {
    for (const section of ["AutomationEditView", "OffPeakEditView"]) {
      const source = readSettingsSection(section);
      expect(source).toContain("SettingsBreadcrumbReporter");
      expect(source).toContain("onSectionSelect");
    }
  });

  it("uses the localized plugin display name for plugin detail breadcrumbs", () => {
    const source = readSettingsSection("PluginStorePage");
    expect(source).toContain("resolveItemDisplayName(detailItem, locale)");
    expect(source).not.toContain("[{ label: detailItem.name }]");
  });

  it("owns the plugin marketplace page title after moving outside Settings", () => {
    const source = readSettingsSection("PluginStorePage");
    expect(source).toContain('data-testid="plugin-store-title"');
    expect(source).toContain('id: "workspace.openPluginsSettings"');
    expect(source).toContain("text-2xl font-semibold tracking-tight text-foreground lg:text-3xl");
  });

  it("uses the plugin settings title after navigating from the marketplace", () => {
    const source = readSettingsSection("PluginsSection");
    expect(source).toContain('id: "settings.plugins.title"');
    expect(source).not.toContain('id: "settings.plugins.store.manageInstalled"');
  });

  it("keeps the installed plugins level in marketplace plugin details", () => {
    const source = readSettingsSection("PluginsSection");
    expect(source).toMatch(
      /mode === "plugin" &&[\s\S]*?showMarketplaceBreadcrumb &&[\s\S]*?!pluginDetailOpen/,
    );
    expect(source).toContain("showMarketplaceBreadcrumb\n              ? [");
    expect(source).toContain("{ label: pluginsBreadcrumbLabel, onSelect: closeDetail }");
    expect(source).toContain(
      "onSectionSelect={showMarketplaceBreadcrumb ? onOpenPluginStore : closeDetail}",
    );
  });

  it("keeps the plugins level for marketplace MCP create and edit views", () => {
    const pluginsSource = readSettingsSection("PluginsSection");
    const mcpSource = readSettingsSection("McpSettingsSection");
    expect(pluginsSource).toMatch(/!pluginDetailOpen &&[\s\S]*?!mcpEditorOpen/);
    expect(mcpSource).toContain("showMarketplaceBreadcrumb");
    expect(mcpSource).toContain("{ label: pluginsBreadcrumbLabel, onSelect: closeFormView }");
  });

  it("keeps the plugins level for marketplace skill details", () => {
    const pluginsSource = readSettingsSection("PluginsSection");
    const skillsSource = readSettingsSection("SkillsSection");
    expect(pluginsSource).toContain("onDetailOpenChange={setSkillDetailOpen}");
    expect(pluginsSource).toContain('reportDetailBreadcrumb={mode === "plugin"}');
    expect(skillsSource).toContain("showMarketplaceBreadcrumb");
    expect(skillsSource).toContain("reportDetailBreadcrumb && detailSkill");
    expect(skillsSource).toContain("{ label: detailSkill.name }");
  });

  it.each([
    // Memory 分区在 workspace 作用域重构（08d53bd114）后不再承载页面级导航。
    "MemorySettingsSection",
    "BrowserSettingsSection",
    "ModelProviderSection",
    "UsageStatsSection",
  ])("does not promote dialog or flat state from %s", (section) => {
    expect(readSettingsSection(section)).not.toContain("SettingsBreadcrumbReporter");
  });
});
