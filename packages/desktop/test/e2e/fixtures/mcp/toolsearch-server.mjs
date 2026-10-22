import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
const requireAdapter = createRequire(
  new URL("../../../../../../apps/zcode-cli/packages/adapters/package.json", import.meta.url),
);
const { McpServer } = requireAdapter("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = requireAdapter("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = requireAdapter("zod");
const server = new McpServer({ name: "toolsearch-e2e", version: "1.0.0" });
const names =
  process.env.E2E_TOOLSEARCH_SHORT_NAMES === "1"
    ? ["look.up", "TodoWrite", "KillShell", "blocked"]
    : ["lookup", "resident", "blocked"];
for (const name of names) {
  server.registerTool(
    name,
    {
      description: "Return a deterministic local fixture value.",
      inputSchema: {
        value: z.string(),
        ...(process.env.E2E_TOOLSEARCH_SCHEMA_REVISION === "2" ? { revision: z.string() } : {}),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta:
        name === "resident"
          ? { "anthropic/alwaysLoad": true }
          : name === "lookup"
            ? { "anthropic/searchHint": "quasar" }
            : {},
    },
    async ({ value }) => {
      if (process.env.E2E_TOOLSEARCH_MCP_LOG) {
        await appendFile(
          process.env.E2E_TOOLSEARCH_MCP_LOG,
          `${JSON.stringify({ name, value })}\n`,
        );
      }
      return { content: [{ type: "text", text: `E2E_TOOLSEARCH_MCP_RESULT:${value}` }] };
    },
  );
}
await server.connect(new StdioServerTransport());
