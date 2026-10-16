import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("settings command row content", () => {
  it("does not expose backing paths or repeat plugin-management guidance", async () => {
    const cardSource = await readFile(
      new URL("../src/settings/CommandCard.tsx", import.meta.url),
      "utf8",
    );
    const sectionSource = await readFile(
      new URL("../src/settings/CommandsSection.tsx", import.meta.url),
      "utf8",
    );

    expect(cardSource).not.toContain("command.location.directoryPath");
    expect(cardSource).not.toContain("pluginManagedHint");
    expect(sectionSource).not.toContain("settings.pluginManaged.modifyInPlugin");
    expect(sectionSource).not.toContain("pluginManagedHint");
    expect(cardSource).not.toContain("DirectoryBadges");
    expect(cardSource).not.toContain('"settings.scope.user"');
    expect(cardSource).not.toContain("command.pluginName}");
    expect(cardSource).toContain("<PluginStoreAvatar");
    expect(cardSource).toContain('className="size-9 bg-background"');
    expect(cardSource).toContain('fallbackIcon={<Terminal className="size-4" />}');
    expect(cardSource).not.toContain("rounded-md bg-surface");
  });
});
