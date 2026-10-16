import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Plugin detail resource icons", () => {
  it("matches the resource icons used by settings lists", () => {
    const pluginDetail = readFileSync(
      "packages/ui/src/settings/PluginStoreDetailView.tsx",
      "utf8",
    );

    expect(pluginDetail).toContain("mcp: Server");
    expect(pluginDetail).toContain("skill: WandSparkles");
    expect(pluginDetail).toContain("command: Terminal");
    expect(pluginDetail).toContain("agent: Bot");
    expect(pluginDetail).toContain("hook: Anchor");
  });
});
