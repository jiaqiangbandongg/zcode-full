import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "telemetry-source-fixture";
const MCP_RUNTIME_NAME = `plugin:${PLUGIN_NAME}:browser`;

describe("MCP telemetry source provenance", () => {
  it("marks MCP servers discovered from the built-in plugin channel as builtin", async () => {
    const fixture = await discoverPluginMcp("builtin");
    try {
      expect(fixture.outcome.mcpServers[MCP_RUNTIME_NAME]).toMatchObject({
        source: { kind: "builtin" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("marks installed MCP servers from the ZCode official marketplace as builtin", async () => {
    const fixture = await discoverPluginMcp("official-cdn");
    try {
      expect(fixture.outcome.plugins[0]).toMatchObject({
        marketplace: "zcode-plugins-official",
        source: "cache",
      });
      expect(fixture.outcome.mcpServers[MCP_RUNTIME_NAME]).toMatchObject({
        source: { kind: "builtin" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps MCP servers discovered from non-built-in plugin channels as plugin", async () => {
    const fixture = await discoverPluginMcp("inline");
    try {
      expect(fixture.outcome.mcpServers[MCP_RUNTIME_NAME]).toMatchObject({
        source: { kind: "plugin" },
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

async function discoverPluginMcp(channel: "builtin" | "official-cdn" | "inline") {
  const root = await mkdtemp(join(tmpdir(), `zcode-${channel}-plugin-mcp-source-`));
  const pluginRoot = join(root, PLUGIN_NAME);
  const storageRoot = join(root, "storage");
  const marketplace = channel === "inline" ? "inline" : "zcode-plugins-official";
  const pluginId = `${PLUGIN_NAME}@${marketplace}`;
  await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN_NAME }),
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        browser: { command: "node", type: "stdio" },
      },
    }),
  );
  if (channel === "official-cdn") {
    await writeFile(
      join(storageRoot, "installed_plugins.json"),
      JSON.stringify({
        plugins: [
          {
            id: pluginId,
            installPath: pluginRoot,
            installedAt: "2026-08-26T00:00:00.000Z",
            marketplace,
            name: PLUGIN_NAME,
            scope: "user",
            version: "1.0.0",
          },
        ],
        version: 1,
      }),
    );
  }

  const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
    config: {
      dirs: channel === "inline" ? [pluginRoot] : [],
      enabled: true,
      enabledPlugins: { [pluginId]: true },
      options: {},
      suppressedBuiltins: [],
    },
    env: {},
    ...(channel === "builtin" ? { officialPluginRoots: [pluginRoot] } : {}),
    storageRoot,
    workingDirectory: root,
  });

  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    outcome,
  };
}
