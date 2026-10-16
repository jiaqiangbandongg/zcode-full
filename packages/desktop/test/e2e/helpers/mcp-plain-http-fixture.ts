import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface PlainHttpMcpFixtureState {
  plainHttpInitializeCount: number;
  plainHttpToolCallMarkers: string[];
}

export async function handlePlainHttpMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: PlainHttpMcpFixtureState,
): Promise<void> {
  if (request.method === "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404);
    response.end();
    return;
  }

  const message = JSON.parse(await readRequestBody(request)) as {
    id?: number | string;
    method?: string;
    params?: {
      arguments?: { marker?: unknown };
      name?: string;
      protocolVersion?: string;
    };
  };
  if (message.method === "initialize") {
    state.plainHttpInitializeCount += 1;
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        serverInfo: {
          name: "mcp-plain-http-status-isolation-e2e",
          version: "0.1.0",
        },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        tools: [
          {
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              readOnlyHint: true,
            },
            description: "Unauthenticated HTTP fixture ping",
            inputSchema: {
              properties: {
                marker: { type: "string" },
              },
              required: ["marker"],
              type: "object",
            },
            name: "ping",
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call" && message.params?.name === "ping") {
    const marker = message.params.arguments?.marker;
    if (typeof marker !== "string") {
      sendJson(response, 200, {
        error: {
          code: -32602,
          message: "plain HTTP ping requires a string marker",
        },
        id: message.id,
        jsonrpc: "2.0",
      });
      return;
    }
    state.plainHttpToolCallMarkers.push(marker);
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        content: [{ text: `E2E_MCP_HTTP_PONG:${marker}`, type: "text" }],
      },
    });
    return;
  }

  if (message.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }

  sendJson(response, 200, {
    error: {
      code: -32601,
      message: `Unsupported plain HTTP E2E MCP method: ${message.method ?? "unknown"}`,
    },
    id: message.id,
    jsonrpc: "2.0",
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}
