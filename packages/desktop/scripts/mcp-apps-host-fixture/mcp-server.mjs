// 独立 MCP 进程：控制 socket 只用于可重复地安排完成顺序，不替代 MCP 数据链路。
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
const [port, htmlPath, source] = process.argv.slice(2);
const control = connect(Number(port), "127.0.0.1");
const sendEvent = (event) => control.write(JSON.stringify({ source, ...event }) + "\n");
const respond = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const pending = new Map();
const result = (key) => ({
  ...(key === "raw-error" ? { isError: true } : {}),
  content:
    key === "raw-error"
      ? [
          { type: "text", text: "fixture error" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          {
            type: "resource",
            resource: { uri: "fixture://error", mimeType: "text/plain", text: "details" },
          },
        ]
      : [{ type: "text", text: "x".repeat(40_000) }],
  structuredContent: { key, source },
  _meta: { fixture: true },
});
createInterface({ input: control }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "disconnect") process.exit(0);
  if (command.type === "notify") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: command.uri },
      }) + "\n",
    );
    sendEvent({ type: "notified", uri: command.uri });
  }
  if (command.type === "release") {
    const call = pending.get(command.key);
    if (call) {
      pending.delete(command.key);
      respond(call.id, call.result);
      sendEvent({ type: "released", key: command.key });
    }
  }
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/cancelled") {
    const call = [...pending.entries()].find(([, value]) => value.id === message.params.requestId);
    if (call) sendEvent({ type: "cancelled", key: call[0] });
    // 故意允许控制端晚回结果，验证 Agent 不接受取消后的写入，也不会重放。
    return;
  }
  if (message.id === undefined) return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: { subscribe: true } },
        serverInfo: { name: "host-e2e", version: "1" },
      });
      break;
    case "tools/list":
      respond(id, {
        tools: [
          {
            name: "edit",
            description: "Local E2E app-only tool",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string" }, delayed: { type: "boolean" } },
              required: ["key"],
            },
            annotations: { readOnlyHint: false },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      });
      break;
    case "resources/read": {
      sendEvent({ type: "read", uri: params.uri });
      const resources = {
        "fixture://document.pdf": {
          mimeType: "application/pdf",
          blob: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
        },
        "fixture://vector.svg": {
          mimeType: "image/svg+xml",
          text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        },
        "fixture://unsupported.bin": { mimeType: "application/x-msdownload", blob: "YQ==" },
      };
      if (resources[params.uri]) {
        respond(id, {
          contents: [
            { uri: params.uri, ...resources[params.uri], _meta: { private: "server-only" } },
          ],
        });
        break;
      }
      respond(id, {
        contents: [
          {
            uri: params.uri,
            mimeType: "text/html;profile=mcp-app",
            text: await readFile(htmlPath, "utf8"),
            _meta: {
              ui: source === "managed-permissions" ? { permissions: { geolocation: {} } } : {},
            },
          },
        ],
      });
      break;
    }
    case "resources/list":
      respond(id, { resources: [] });
      break;
    case "resources/templates/list":
      respond(id, { resourceTemplates: [] });
      break;
    case "resources/subscribe":
    case "resources/unsubscribe":
      sendEvent({ type: method, uri: params.uri });
      respond(id, {});
      break;
    case "tools/call": {
      const key = params.arguments.key;
      sendEvent({ type: "executed", key });
      if (params.arguments.delayed) pending.set(key, { id, result: result(key) });
      else respond(id, result(key));
      break;
    }
    default:
      respond(id, {});
  }
});
process.stdin.on("end", () => {
  control.end();
  process.exit(0);
});
