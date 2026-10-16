import { describe, expect, it } from "vitest";
import { matchesRequiredMcpServer } from "../src/subagent/mcp-config.js";

describe("subagent MCP config", () => {
  it("matches connected plugin MCP servers against their model-visible tool name prefix", () => {
    expect(
      matchesRequiredMcpServer("plugin_android-emulator_android-emulator", {
        "plugin:android-emulator:android-emulator": {
          status: "connected",
          toolCount: 1,
          transport: "stdio",
          updatedAt: new Date(0).toISOString(),
        },
      }),
    ).toBe(true);
  });
});
