import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Hook create button", () => {
  it("routes the compact create button through the shared header actions", async () => {
    const hooks = await readFile(
      new URL("../src/settings/HooksSection.tsx", import.meta.url),
      "utf8",
    );
    const shared = await readFile(
      new URL("../src/settings/SettingsResourceHeaderActions.tsx", import.meta.url),
      "utf8",
    );

    expect(hooks).toContain("<SettingsResourceHeaderActions");
    expect(hooks).toContain('newActionId="settings.hooks.add"');
    expect(shared).toMatch(
      /size="default"\s+className="rounded-lg"\s+data-settings-create-action=\{newActionId\}/,
    );
  });
});
