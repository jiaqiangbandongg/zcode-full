import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(name: string): string {
  return readFileSync(new URL(`../src/settings/${name}.tsx`, import.meta.url), "utf8");
}

describe("Settings breadcrumb replaces detail back navigation", () => {
  it.each([
    "MemorySettingsViewer",
    "PluginStoreDetailView",
    "SubagentsSection",
    "McpSettingsSection",
    "CommandsSection",
    "HookForm",
  ])("removes SettingsBackButton from %s", (name) => {
    expect(readSource(name)).not.toContain("SettingsBackButton");
  });

  it.each(["AutomationEditView", "OffPeakEditView"])(
    "moves %s back navigation into the breadcrumb",
    (name) => {
      const source = readSource(name);
      expect(source).toContain("SettingsBreadcrumbReporter");
      expect(source).not.toContain("AUTOMATION_BACK_TRIGGER_CLASSNAME");
    },
  );

  it.each([
    "CommandsSection",
    "SubagentsSection",
    "McpSettingsSection",
    "HookForm",
  ])("uses the xl UI token for the current form title in %s", (name) => {
    const source = readSource(name);
    expect(source).toContain("text-ui-xl font-semibold text-foreground");
    expect(source).not.toContain("text-xl");
  });
});
