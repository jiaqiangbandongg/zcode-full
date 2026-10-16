import { readSourceText } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

describe("Hook resource icons", () => {
  it("uses Anchor across Hook settings surfaces", () => {
    const settingsConfig = readSourceText(
      "packages/ui/src/settings/settingsPageConfig.ts",
      "utf8",
    );
    const hooksList = readSourceText(
      "packages/ui/src/settings/HooksList.tsx",
      "utf8",
    );
    const pluginDetail = readSourceText(
      "packages/ui/src/settings/PluginStoreDetailView.tsx",
      "utf8",
    );

    expect(settingsConfig).toContain('id: "hooks",\n    icon: Anchor');
    expect(hooksList).toContain('<Anchor className="size-4" />');
    expect(pluginDetail).toContain("hook: Anchor");
  });
});
