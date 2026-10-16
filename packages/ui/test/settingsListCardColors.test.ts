import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHARED_LIST_FILES = ["SkillsSection", "CommandsSection", "McpSettingsSection"] as const;
const INLINE_LIST_FILES = ["SubagentsSection", "HooksList"] as const;

function readSettingsSource(name: string): string {
  return readFileSync(new URL(`../src/settings/${name}.tsx`, import.meta.url), "utf8");
}

describe("Settings list card colors", () => {
  it.each(SHARED_LIST_FILES)("uses the shared resource list in %s", (name) => {
    const source = readSettingsSource(name);
    expect(source).toContain("SettingsResourceList");
  });

  it("keeps the shared flat surface contract in SettingsResourceGroup", () => {
    const source = readSettingsSource("SettingsResourceGroup");
    expect(source).toContain("overflow-hidden rounded-xl bg-surface");
    expect(source).toContain("h-px bg-border/50");
  });

  it.each(INLINE_LIST_FILES)("uses the flat surface contract in %s", (name) => {
    const source = readSettingsSource(name);
    expect(source).toContain("overflow-hidden rounded-xl bg-surface");
  });

  it("uses the shared flat resource-list surface in MemorySettingsViewer", () => {
    const source = readSettingsSource("MemorySettingsViewer");
    expect(source).toContain("overflow-hidden rounded-xl bg-surface");
    expect(source).toContain("h-px bg-border/50");
  });
});
