#!/usr/bin/env node
// E2E fixture: minimal stdio MCP server that exposes a single `ping` tool.
// v1 范围内不需要真正跑起来（upstream replay 已伪造模型 tool_use）；
// 但 agent 在 enabled 状态下会 spawn 它来 listTools，所以必须能成功启动
// 并响应 initialize / tools/list，否则 plugin-enable 状态会变成 "error"。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "e2e-plugin-mcp-ping", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.tool(
  "ping",
  "Echo back a pong message. Used by plugin-MCP-skill lifecycle e2e tests.",
  { message: z.string().optional() },
  async ({ message }) => ({
    content: [
      {
        type: "text",
        text:
          process.env.E2E_PLUGIN_RUNTIME_SECRET === "E2E_WORKSPACE_PLUGIN_SECRET"
            ? "E2E_PLUGIN_RUNTIME_SECRET_RESOLVED"
            : `pong: ${typeof message === "string" ? message : ""}`,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
