import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "always-load-plugin";
const OFFICIAL_AUTH = { type: "zcode_official", provider: "jwt_token" };
const TRANSPORTS = {
  stdio: { type: "stdio", command: "node" },
  http: { type: "http", url: "https://mcp.example.test/mcp" },
  sse: { type: "sse", url: "https://mcp.example.test/sse" },
  officialStdio: { type: "stdio", command: "node", auth: OFFICIAL_AUTH },
  officialHttp: { type: "http", url: "https://mcp.example.test/mcp", auth: OFFICIAL_AUTH },
};

describe.each(["file", "manifest"] as const)("plugin MCP alwaysLoad from %s", (source) => {
  it.each([
    { label: "true", input: true, expected: true },
    { label: "false", input: false, expected: false },
    { label: "omitted", input: undefined, expected: undefined },
    { label: "string", input: "true", expected: undefined },
    { label: "number", input: 1, expected: undefined },
  ])("preserves boolean semantics ($label) for every transport", async ({ input, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-always-load-"));
    const pluginRoot = join(root, PLUGIN_NAME);
    const servers = Object.fromEntries(
      Object.entries(TRANSPORTS).map(([name, transport]) => [
        name,
        { ...transport, alwaysLoad: input, enabled: false, timeoutMs: 1234 },
      ]),
    );
    try {
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: PLUGIN_NAME,
          ...(source === "manifest" ? { mcpServers: servers } : {}),
        }),
      );
      if (source === "file") {
        await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
      }
      const storageRoot = join(root, "storage");
      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: { dirs: [pluginRoot], enabled: true, enabledPlugins: {}, options: {} },
        env: {},
        storageRoot,
        workingDirectory: root,
      });
      expect(outcome.diagnostics).toEqual([]);
      expect(Object.keys(outcome.mcpServers)).toHaveLength(Object.keys(TRANSPORTS).length);
      for (const [name, transport] of Object.entries(TRANSPORTS)) {
        const config = outcome.mcpServers[`plugin:${PLUGIN_NAME}:${name}`];
        expect(config?.alwaysLoad, name).toBe(expected);
        expect(config, name).toMatchObject({
          type: transport.type,
          enabled: false,
          timeoutMs: 1234,
          source: { kind: "plugin" },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
