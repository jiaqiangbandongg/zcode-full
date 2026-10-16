import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("settings remote sync local workspace path", () => {
  it("passes the active tab local workspace path into the MCP settings sync entry", () => {
    const pluginSource = readSource(
      "packages/ui/src/settings/PluginsSection.tsx",
    );
    const mcpSettingsSectionSource = readSource(
      "packages/ui/src/settings/McpSettingsSection.tsx",
    );

    expect(pluginSource).toContain(
      "localWorkspacePath={mcpTarget.localWorkspacePath}",
    );
    expect(mcpSettingsSectionSource).toContain(
      "mcpLocalWorkspacePath={localWorkspacePath}",
    );
  });
});
