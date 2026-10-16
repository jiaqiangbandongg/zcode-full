import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";

describe("ToolRegistry aliases", () => {
  it("does not let a newly registered alias shadow an existing canonical tool", () => {
    const registry = createToolRegistry();
    const existingCanonical = createEntry("mcp__computer_use__open_application");
    const officialTool = createEntry("mcp__computer-use__open_application", [
      "mcp__computer_use__open_application",
    ]);

    registry.register(existingCanonical);
    registry.register(officialTool);

    expect(registry.get("mcp__computer_use__open_application")).toBe(existingCanonical);
    expect(registry.get("mcp__computer-use__open_application")).toBe(officialTool);
  });

  it("lets a later canonical registration displace an older alias with the same name", () => {
    const registry = createToolRegistry();
    const officialTool = createEntry("mcp__computer-use__open_application", [
      "mcp__computer_use__open_application",
    ]);
    const laterCanonical = createEntry("mcp__computer_use__open_application");

    registry.register(officialTool);
    registry.register(laterCanonical);

    expect(registry.get("mcp__computer_use__open_application")).toBe(laterCanonical);
    expect(registry.get("mcp__computer-use__open_application")).toBe(officialTool);
  });
});

function createEntry(name: string, aliases?: readonly string[]): ToolEntry {
  return {
    aliases,
    capability: `test capability for ${name}`,
    handler: async () => ({ ok: true }),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
  };
}
