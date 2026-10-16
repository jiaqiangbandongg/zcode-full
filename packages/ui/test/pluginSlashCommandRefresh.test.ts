import { describe, expect, it } from "vitest";
import type { ZCodeCommand, ZCodeSlashCommand } from "@zcode/shared";
import { mergeSlashCommandsAfterCommandRefresh } from "../src/settings/pluginSlashCommandRefresh.js";

function makePluginCommand(
  overrides: Partial<Extract<ZCodeCommand, { source: "plugin" }>>,
): Extract<ZCodeCommand, { source: "plugin" }> {
  return {
    id: "plugin:team-market:hello-world:hello:/remote/commands/hello.md",
    name: "hello",
    prompt: "Say hello",
    content: "# hello",
    filePath: "/remote/commands/hello.md",
    source: "plugin",
    enabled: true,
    pluginName: "hello-world",
    pluginMarketplace: "team-market",
    pluginEnabled: true,
    scope: "global",
    ...overrides,
  };
}

describe("plugin slash command refresh", () => {
  it("keeps builtin slash commands while replacing refreshed custom commands", () => {
    const current: ZCodeSlashCommand[] = [
      {
        name: "compact",
        description: "Compact",
        inputHint: "/compact [instructions]",
        source: "builtin",
      },
      {
        name: "old-plugin",
        description: "Old plugin command",
        inputHint: "/old-plugin",
        source: "custom",
      },
    ];

    const next = mergeSlashCommandsAfterCommandRefresh(current, [
      makePluginCommand({
        name: "hello",
        description: "Hello plugin command",
        argumentHint: "[name]",
      }),
      makePluginCommand({
        name: "disabled",
        enabled: false,
      }),
      makePluginCommand({
        name: "compact",
        description: "Should not replace builtin",
      }),
    ]);

    expect(next).toEqual([
      {
        name: "compact",
        description: "Compact",
        inputHint: "/compact [instructions]",
        source: "builtin",
      },
      {
        name: "hello",
        description: "Hello plugin command",
        inputHint: "/hello [name]",
        source: "custom",
      },
    ]);
  });
});
