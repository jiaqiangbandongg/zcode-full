#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const requireFromMcpAdapter = createRequire(
  new URL(
    "../../../../../../apps/zcode-cli/packages/adapters/package.json",
    import.meta.url,
  ),
);
const { McpServer } = requireFromMcpAdapter(
  "@modelcontextprotocol/sdk/server/mcp.js",
);
const { StdioServerTransport } = requireFromMcpAdapter(
  "@modelcontextprotocol/sdk/server/stdio.js",
);
const { z } = requireFromMcpAdapter("zod");

const LOOKUP_RESULT_PREFIX = "E2E_PLAN_MCP_LOOKUP_RESULT";
const RESET_RESULT = "E2E_PLAN_MCP_RESET_SHOULD_NOT_RUN";
const callLogPath = process.env.E2E_PLAN_MCP_CALL_LOG;

const server = new McpServer({
  name: "plan-mode-mcp-permission-e2e",
  version: "0.1.0",
});

server.registerTool(
  "lookup",
  {
    title: "Plan Mode MCP Lookup",
    description:
      "Return an E2E marker for Plan mode MCP permission coverage. This intentionally omits readOnlyHint.",
    inputSchema: {
      query: z.string().optional(),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ query }) => {
    await recordCall("lookup", { query });
    return {
      content: [
        {
          type: "text",
          text: `${LOOKUP_RESULT_PREFIX}:${query ?? ""}`,
        },
      ],
    };
  },
);

server.registerTool(
  "reset",
  {
    title: "Plan Mode MCP Reset",
    description:
      "Destructive E2E marker tool. Plan mode must reject this before the server handler runs.",
    inputSchema: {
      marker: z.string().optional(),
    },
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async ({ marker }) => {
    await recordCall("reset", { marker });
    return {
      content: [
        {
          type: "text",
          text: `${RESET_RESULT}:${marker ?? ""}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());

async function recordCall(tool, input) {
  if (!callLogPath) return;
  await mkdir(dirname(callLogPath), { recursive: true });
  await appendFile(
    callLogPath,
    `${JSON.stringify({ input, tool, ts: new Date().toISOString() })}\n`,
    "utf-8",
  );
}
