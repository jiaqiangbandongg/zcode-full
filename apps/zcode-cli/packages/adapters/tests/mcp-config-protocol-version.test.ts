import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFileConfig } from "../src/config/file-config.adapter.js";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../src/config/schema.js";

describe("MCP config protocolVersion", () => {
  describe.each(["stdio", "http", "sse"] as const)("%s", (type) => {
    const transport =
      type === "stdio"
        ? { type, command: "mcp-test-server" }
        : { type, url: "https://example.test/mcp" };

    it.each([undefined, "auto", "legacy", "2026-07-28"])(
      "preserves protocolVersion=%s through file loading",
      async (protocolVersion) => {
        const root = await mkdtemp(join(tmpdir(), "zcode-mcp-protocol-config-"));
        const path = join(root, "config.json");
        const server = {
          ...transport,
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
        };
        try {
          await writeFile(path, JSON.stringify({ mcp: { servers: { test: server } } }));
          const result = loadFileConfig(path);
          expect(result.loaded).toBe(true);
          expect(result.diagnostics).toEqual([]);
          expect(result.config.mcp?.servers).toEqual({ test: server });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );

    it.each([{ protocolVersion: "v2" }, { protocolVersion: null }, { unknownOption: true }])(
      "rejects invalid fields %j without discarding other config",
      (invalid) => {
        const valid = { ...transport, protocolVersion: "legacy" };
        const plugins = { enabledPlugins: { "example@marketplace": true } };
        const result = parseConfigFileToRuntimePatchWithDiagnostics({
          mcp: { servers: { valid, broken: { ...transport, ...invalid } } },
          plugins,
        });
        expect(result.config.mcp?.servers).toEqual({ valid });
        expect(result.config.plugins).toEqual(plugins);
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            code: "config_mcp_server_invalid",
            path: "mcp.servers.broken",
            severity: "warning",
          }),
        ]);
      },
    );
  });
});
