import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handlePlainHttpMcpRequest } from "./mcp-plain-http-fixture.js";

const ACCESS_TOKEN = "e2e-mcp-oauth-access-token";
const AUTHORIZATION_CODE = "e2e-mcp-oauth-code";
const CLIENT_ID = "e2e-mcp-oauth-client";
const CLIENT_SECRET = "e2e-mcp-oauth-secret";
const SCOPE = "mcp:tools";

export interface McpOAuthStatusIsolationSnapshot {
  authorizationRequestCount: number;
  authorizedInitializeCount: number;
  plainHttpInitializeCount: number;
  plainHttpToolCallMarkers: string[];
  registrationRequestCount: number;
  tokenRequestCount: number;
  unauthorizedMcpRequestCount: number;
}

export interface McpOAuthStatusIsolationServer {
  close: () => Promise<void>;
  completeAuthorization: (authorizationUrl: string) => Promise<void>;
  mcpUrl: string;
  plainHttpMcpUrl: string;
  snapshot: () => McpOAuthStatusIsolationSnapshot;
}

export async function startMcpOAuthStatusIsolationServer(): Promise<McpOAuthStatusIsolationServer> {
  const state = {
    authorizationRequestCount: 0,
    authorizedInitializeCount: 0,
    plainHttpInitializeCount: 0,
    plainHttpToolCallMarkers: [] as string[],
    registrationRequestCount: 0,
    tokenRequestCount: 0,
    unauthorizedMcpRequestCount: 0,
  };
  let baseUrl = "";
  let mcpUrl = "";
  let plainHttpMcpUrl = "";

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      baseUrl,
      mcpUrl,
      plainHttpMcpUrl,
      state,
    }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("MCP OAuth E2E server did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  mcpUrl = `${baseUrl}/mcp`;
  plainHttpMcpUrl = `${baseUrl}/plain-mcp`;

  return {
    close: () => closeServer(server),
    async completeAuthorization(authorizationUrl) {
      const authorizationResponse = await fetch(authorizationUrl, {
        redirect: "manual",
      });
      if (authorizationResponse.status !== 302) {
        throw new Error(
          `OAuth authorization fixture expected 302, received ${authorizationResponse.status}`,
        );
      }
      const callbackUrl = authorizationResponse.headers.get("location");
      if (!callbackUrl) {
        throw new Error("OAuth authorization fixture did not return a callback URL");
      }
      const callbackResponse = await fetch(callbackUrl);
      if (!callbackResponse.ok) {
        throw new Error(`OAuth callback fixture failed with ${callbackResponse.status}`);
      }
    },
    mcpUrl,
    plainHttpMcpUrl,
    snapshot: () => ({
      ...state,
      plainHttpToolCallMarkers: [...state.plainHttpToolCallMarkers],
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    baseUrl: string;
    mcpUrl: string;
    plainHttpMcpUrl: string;
    state: McpOAuthStatusIsolationSnapshot;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", context.baseUrl);

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/.well-known/oauth-authorization-server")
  ) {
    sendJson(response, 200, {
      authorization_endpoint: `${context.baseUrl}/authorize`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      issuer: context.baseUrl,
      registration_endpoint: `${context.baseUrl}/register`,
      response_types_supported: ["code"],
      scopes_supported: [SCOPE],
      token_endpoint: `${context.baseUrl}/token`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    sendJson(response, 200, {
      authorization_servers: [context.baseUrl],
      resource: context.mcpUrl,
      resource_name: "ZCode MCP OAuth status isolation E2E",
      scopes_supported: [SCOPE],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/register") {
    context.state.registrationRequestCount += 1;
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    sendJson(response, 201, {
      ...body,
      client_id: CLIENT_ID,
      client_id_issued_at: 1,
      client_secret: CLIENT_SECRET,
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_basic",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/authorize") {
    context.state.authorizationRequestCount += 1;
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!redirectUri) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", AUTHORIZATION_CODE);
    const state = url.searchParams.get("state");
    if (state) callbackUrl.searchParams.set("state", state);
    response.writeHead(302, { Location: callbackUrl.toString() });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/token") {
    const body = new URLSearchParams(await readRequestBody(request));
    if (!hasValidClientCredentials(request, body)) {
      sendJson(response, 401, { error: "invalid_client" });
      return;
    }
    context.state.tokenRequestCount += 1;
    sendJson(response, 200, {
      access_token: ACCESS_TOKEN,
      expires_in: 3600,
      refresh_token: "e2e-mcp-oauth-refresh-token",
      scope: SCOPE,
      token_type: "Bearer",
    });
    return;
  }

  if (url.pathname === "/mcp") {
    await handleMcpRequest(request, response, context);
    return;
  }

  if (url.pathname === "/plain-mcp") {
    await handlePlainHttpMcpRequest(request, response, context.state);
    return;
  }

  response.writeHead(404);
  response.end();
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    baseUrl: string;
    mcpUrl: string;
    state: McpOAuthStatusIsolationSnapshot;
  },
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

  if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
    context.state.unauthorizedMcpRequestCount += 1;
    const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", context.baseUrl);
    response.writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl.href}", scope="${SCOPE}"`,
    });
    response.end();
    return;
  }

  const message = JSON.parse(await readRequestBody(request)) as {
    id?: number | string;
    method?: string;
    params?: { protocolVersion?: string };
  };
  if (message.method === "initialize") {
    context.state.authorizedInitializeCount += 1;
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        serverInfo: {
          name: "mcp-oauth-status-isolation-e2e",
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
            description: "OAuth-protected Canva fixture ping",
            inputSchema: {
              properties: {},
              type: "object",
            },
            name: "oauth_ping",
          },
        ],
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
      message: `Unsupported E2E MCP method: ${message.method ?? "unknown"}`,
    },
    id: message.id,
    jsonrpc: "2.0",
  });
}

function hasValidClientCredentials(request: IncomingMessage, body: URLSearchParams): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    return decoded === `${CLIENT_ID}:${CLIENT_SECRET}`;
  }
  return body.get("client_id") === CLIENT_ID && body.get("client_secret") === CLIENT_SECRET;
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

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
