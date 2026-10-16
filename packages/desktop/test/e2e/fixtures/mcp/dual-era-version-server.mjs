#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const requireFromBrowserUse = createRequire(
  new URL(
    "../../../../../../apps/zcode-cli/packages/browser-use-plugin/package.json",
    import.meta.url,
  ),
);
const { McpServer } = requireFromBrowserUse("@modelcontextprotocol/server");
const { serveStdio, StdioServerTransport } = requireFromBrowserUse(
  "@modelcontextprotocol/server/stdio",
);

const mode = process.env.E2E_MCP_VERSION_MODE;
const wireLogPath = process.env.E2E_MCP_VERSION_WIRE_LOG;
if ((mode !== "modern" && mode !== "legacy") || !wireLogPath) {
  throw new Error(
    "E2E MCP version fixture requires a valid mode and wire log path",
  );
}

let writeQueue = Promise.resolve();
function recordEvent(event) {
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(wireLogPath), { recursive: true });
      await appendFile(
        wireLogPath,
        `${JSON.stringify({ ...event, mode, pid: process.pid, ts: new Date().toISOString() })}\n`,
        "utf8",
      );
    })
    .catch(() => undefined);
  return writeQueue;
}

await recordEvent({ event: "started" });

let inputBuffer = "";
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk.toString("utf8");
  let newlineIndex = inputBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (typeof message?.method === "string") {
          void recordEvent({ event: "request", method: message.method });
        }
      } catch {
        void recordEvent({ event: "invalid-request-line" });
      }
    }
    newlineIndex = inputBuffer.indexOf("\n");
  }
});

function createServer() {
  const server = new McpServer({
    name: `desktop-e2e-${mode}`,
    version: "1.0.0",
  });
  server.registerTool(
    "ping",
    {
      description: "Return a real MCP E2E pong marker",
      inputSchema: {},
    },
    async () => ({ content: [{ text: `pong-${mode}`, type: "text" }] }),
  );
  return server;
}

if (mode === "modern") {
  serveStdio(createServer, { legacy: "reject" });
} else {
  await createServer().connect(new StdioServerTransport());
}
