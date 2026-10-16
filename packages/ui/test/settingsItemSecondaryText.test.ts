import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const itemSources = [
  "../src/settings/SubagentsSection.tsx",
  "../src/settings/CommandCard.tsx",
  "../src/settings/SkillsSection.tsx",
  "../src/settings/McpServerList.tsx",
  "../src/settings/McpSettingsSection.tsx",
  "../src/settings/HooksList.tsx",
  "../src/settings/MemorySettingsViewer.tsx",
  "../src/settings/PluginStoreCard.tsx",
];

describe("settings item secondary text", () => {
  it.each(itemSources)(
    "uses the secondary item typography in %s",
    async (path) => {
      const source = await readFile(new URL(path, import.meta.url), "utf8");

      expect(source).toContain("text-ui-sm text-foreground-subtle");
    },
  );
});
