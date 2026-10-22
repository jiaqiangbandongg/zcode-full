import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { expect, it } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createNodePluginAdapter } from "../src/plugins/index.js";
import { toAiSdkMessages } from "../src/model/transform.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { toolSearchHeaders } from "../src/model/tool-search.js";
import { registerMcpTools } from "../../core/src/mcp/index.js";
import { createToolRegistry } from "../../core/src/tool/registry.js";
import { toolSearchToolEntry } from "../../core/src/tool/handlers/tool-search.js";
import { prepareRuntimeProviderRequest } from "../../core/src/runtime/helpers/runtime-provider-request-messages.js";
import { createTestRuntimeModel } from "../../core/tests/test-runtime-model.js";

const PLUGIN_NAME = "schema-loading";
const INPUT_SCHEMA = {
  type: "object",
  properties: { query: { type: "string", description: "Lookup key" } },
  required: ["query"],
};

it.each(["file", "manifest"] as const)(
  "keeps plugin alwaysLoad tools in the first Anthropic request (%s)",
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-schema-wire-"));
    const mcp = createMcpAdapter({ workingDirectory: root });
    const rpcMethods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      rpcMethods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              capabilities: { tools: {} },
              protocolVersion: "2025-06-18",
              serverInfo: { name: "schema-loading", version: "1.0.0" },
            }
          : {
              tools: [{ name: "lookup", description: "Look up a key", inputSchema: INPUT_SCHEMA }],
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing MCP test endpoint");
      const endpoint = { type: "http", url: `http://127.0.0.1:${address.port}/mcp` };
      const servers = {
        resident: { ...endpoint, alwaysLoad: true },
        deferred: { ...endpoint, alwaysLoad: false },
        default: endpoint,
      };
      const pluginRoot = join(root, PLUGIN_NAME);
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
      for (const [name, config] of Object.entries(outcome.mcpServers)) {
        expect((await mcp.connectServer(name, config)).status).toBe("connected");
      }
      const registry = createToolRegistry();
      registry.register(toolSearchToolEntry);
      const descriptors = await mcp.listTools();
      expect(descriptors).toHaveLength(3);
      const names = registerMcpTools(registry, mcp, descriptors);
      const resident = names.find((name) => name.includes("resident"));
      expect(resident).toBeDefined();
      for (const enabled of [true, false]) {
        const model = {
          ...createTestRuntimeModel({
            generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
          }),
          requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: enabled } },
        };
        const prepared = prepareRuntimeProviderRequest(
          { config: { toolSearch: { mode: enabled ? "native" : "off" } } },
          {
            model,
            entries: [{ message: { role: "user", content: "Look up the key." } }],
            tools: registry.toContracts(),
            registry,
          },
        ).request;
        expect(prepared.toolSearchEnabled).toBe(enabled);
        let wire:
          | { tools: Array<{ name: string; input_schema: unknown; defer_loading?: boolean }> }
          | undefined;
        const provider = createAnthropic({
          apiKey: "test",
          fetch: async (_url, init) => {
            wire = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({ error: { type: "invalid_request_error", message: "capture" } }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          },
        });
        const options = {
          providerKind: "anthropic" as const,
          toolSearchEnabled: prepared.toolSearchEnabled,
        };
        await expect(
          generateText({
            model: provider("test"),
            maxRetries: 0,
            headers: toolSearchHeaders(undefined, prepared.toolSearchEnabled),
            tools: toAiSdkTools(prepared.tools, options),
            messages: toAiSdkMessages(prepared.messages, options),
          }),
        ).rejects.toBeDefined();
        expect(wire?.tools.map((tool) => tool.name).sort()).toEqual(
          (enabled ? ["ToolSearch", resident] : names).sort(),
        );
        expect(wire?.tools.find((tool) => tool.name === resident)).toMatchObject({
          input_schema: INPUT_SCHEMA,
        });
        expect(wire?.tools.every((tool) => tool.defer_loading === undefined)).toBe(true);
      }
      expect(rpcMethods).toContain("initialize");
      expect(rpcMethods).toContain("tools/list");
      expect(rpcMethods).not.toContain("tools/call");
    } finally {
      await mcp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  },
);
