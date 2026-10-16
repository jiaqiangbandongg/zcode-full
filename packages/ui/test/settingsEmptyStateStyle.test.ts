import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("settings empty state style", () => {
  it.each([
    "packages/ui/src/settings/PluginStoreListView.tsx",
    "packages/ui/src/settings/McpServerList.tsx",
  ])("uses a dashed transparent empty state in %s", (path) => {
    const source = readSource(path);

    expect(source).toContain("border-dashed");
  });

  it.each([
    "packages/ui/src/settings/CommandsSection.tsx",
    "packages/ui/src/settings/HooksList.tsx",
    "packages/ui/src/settings/SubagentsSection.tsx",
  ])("uses the shared dashed Plugin empty state in %s", (path) => {
    const source = readSource(path);
    expect(source).toContain("<PluginInstallEmptyState");
  });

  it("uses the shared dashed Plugin empty state for Skills", () => {
    const source = readSource("packages/ui/src/settings/SkillsSection.tsx");
    expect(source).toContain("<PluginInstallEmptyState");
  });

  it("keeps the automations empty state aligned with the Figma card surface", () => {
    const source = readSource(
      "packages/ui/src/settings/AutomationsSection.tsx",
    );

    expect(source).toContain("border-card-border bg-background");
    expect(source).not.toContain(
      'data-automations-empty-state\n                  className="flex h-[226px] w-full items-center justify-center rounded-2xl border border-dashed',
    );
  });

  it("keeps the shared usage empty state transparent", () => {
    const source = readSource(
      "packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx",
    );

    expect(source).toContain(
      'className="rounded-xl border border-dashed border-border px-4 py-10 text-center"',
    );
  });
});
