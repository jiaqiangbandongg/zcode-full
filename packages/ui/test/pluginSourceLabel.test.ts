import { describe, expect, it } from "vitest";
import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";
import {
  resolveMarketplaceDisplayName,
  resolvePluginSourceLabel,
} from "../src/settings/pluginSourceLabel.js";

const CLAUDE_CODE_PLUGINS = "Claude Code Plugins";

function makeMarketplace(
  overrides: Partial<ZCodePluginMarketplaceSummary> = {},
): ZCodePluginMarketplaceSummary {
  return {
    id: "acme",
    name: "Acme Marketplace",
    source: { source: "github", repo: "acme/plugins" },
    pluginCount: 3,
    ...overrides,
  };
}

describe("resolveMarketplaceDisplayName", () => {
  it("maps the official marketplace id to the Claude Code Plugins label", () => {
    expect(
      resolveMarketplaceDisplayName("claude-plugins-official", [], CLAUDE_CODE_PLUGINS),
    ).toBe(CLAUDE_CODE_PLUGINS);
  });

  it("uses the overview name for known marketplaces", () => {
    expect(
      resolveMarketplaceDisplayName("acme", [makeMarketplace()], CLAUDE_CODE_PLUGINS),
    ).toBe("Acme Marketplace");
  });

  it("falls back to the raw id for unknown marketplaces", () => {
    expect(resolveMarketplaceDisplayName("mystery", [], CLAUDE_CODE_PLUGINS)).toBe("mystery");
  });
});

describe("resolvePluginSourceLabel", () => {
  const common = {
    marketplaces: [makeMarketplace()],
    builtinLabel: "Built-in",
    claudeCodePluginsLabel: CLAUDE_CODE_PLUGINS,
    formatFromMarketplace: (name: string) => `From ${name}`,
  };

  it("labels official plugins as built-in", () => {
    expect(
      resolvePluginSourceLabel({
        ...common,
        source: "official",
        marketplace: "zcode-plugins-official",
      }),
    ).toBe("Built-in");
  });

  it("labels inline plugins as built-in", () => {
    expect(
      resolvePluginSourceLabel({ ...common, source: "inline", marketplace: "inline" }),
    ).toBe("Built-in");
  });

  it("labels cache plugins as installed from their marketplace", () => {
    expect(
      resolvePluginSourceLabel({ ...common, source: "cache", marketplace: "acme" }),
    ).toBe("From Acme Marketplace");
  });

  it("uses the Claude Code Plugins label for official-marketplace installs", () => {
    expect(
      resolvePluginSourceLabel({
        ...common,
        source: "cache",
        marketplace: "claude-plugins-official",
      }),
    ).toBe(`From ${CLAUDE_CODE_PLUGINS}`);
  });
});
