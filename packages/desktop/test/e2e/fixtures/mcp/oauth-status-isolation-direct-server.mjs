#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const requireFromMcpAdapter = createRequire(
  new URL("../../../../../../apps/zcode-cli/packages/adapters/package.json", import.meta.url),
);
const { McpServer } = requireFromMcpAdapter("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = requireFromMcpAdapter("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = requireFromMcpAdapter("zod");

const RESULT_PREFIX = "E2E_MCP_DIRECT_PONG";
const callLogPath = process.env.E2E_MCP_DIRECT_CALL_LOG;

await recordEvent({ event: "started", pid: process.pid });

const server = new McpServer({
  name: "mcp-oauth-status-isolation-direct-e2e",
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    title: "Direct MCP Ping",
    description: "Return an E2E marker from the unrelated user-level MCP server.",
    inputSchema: {
      marker: z.string(),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      readOnlyHint: true,
    },
  },
  async ({ marker }) => {
    await recordEvent({ marker, tool: "ping" });
    return {
      content: [
        {
          type: "text",
          text: `${RESULT_PREFIX}:${marker}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());

async function recordEvent(event) {
  if (!callLogPath) return;
  await mkdir(dirname(callLogPath), { recursive: true });
  await appendFile(
    callLogPath,
    `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`,
    "utf-8",
  );
}
