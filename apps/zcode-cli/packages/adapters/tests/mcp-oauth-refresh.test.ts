import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../src/auth/shared-credentials.js";
import {
  loadCanonicalCredentials,
  publishCanonicalCredentials,
} from "../src/mcp/oauth-credentials.js";
import {
  MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE,
  MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE,
} from "../src/mcp/oauth-errors.js";
import { createMcpOAuthTokenProvider } from "../src/mcp/oauth-provider.js";
import { createCredentialKeyPrefix } from "../src/mcp/oauth.js";

const MCP_SCOPE = "mcp:tools";
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

interface TokenEndpointBehaviour {
  /** 卡住 token 响应，直到 release() 被调用。用于构造 barrier。 */
  gate?: Promise<void>;
  respond: (body: URLSearchParams) => { status: number; payload: unknown };
}

interface FakeAuthorizationServer {
  baseUrl: string;
  discoveryRequests: number;
  refreshRequests: Array<Record<string, string>>;
}

async function startFakeAuthorizationServer(
  behaviour: TokenEndpointBehaviour,
): Promise<FakeAuthorizationServer> {
  const state: FakeAuthorizationServer = {
    baseUrl: "",
    discoveryRequests: 0,
    refreshRequests: [],
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      state.discoveryRequests += 1;
      sendJson(res, 200, {
        authorization_servers: [state.baseUrl],
        resource: `${state.baseUrl}/mcp`,
        scopes_supported: [MCP_SCOPE],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      state.discoveryRequests += 1;
      sendJson(res, 200, {
        issuer: state.baseUrl,
        authorization_endpoint: `${state.baseUrl}/authorize`,
        token_endpoint: `${state.baseUrl}/token`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      state.refreshRequests.push(Object.fromEntries(body.entries()));
      if (behaviour.gate) await behaviour.gate;
      const { status, payload } = behaviour.respond(body);
      sendJson(res, status, payload);
      return;
    }
    res.writeHead(404).end();
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake AS is not listening");
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  return state;
}

interface SeededCredentials {
  credentialStore: SharedZCodeCredentialStore;
  keyPrefix: string;
  mcpUrl: string;
}

async function seedCredentials(input: {
  authBaseUrl: string;
  expiresInSeconds?: number;
  /** true 时写入不含 obtained_at/expires_at 的旧记录（v1/v2 迁移场景）。 */
  legacyWithoutTimestamps?: boolean;
  secret: string;
}): Promise<SeededCredentials> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-refresh-"));
  temporaryDirectories.push(directory);
  const credentialStore = createSharedZCodeCredentialStore({
    env: { ZCODE_CREDENTIAL_SECRET: input.secret },
    filePath: join(directory, "credentials.json"),
  });
  const mcpUrl = `${input.authBaseUrl}/mcp`;
  const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
  const keyPrefix = createCredentialKeyPrefix("refresh-test", mcpUrl, oauthConfig);
  const tokens = {
    access_token: "seeded-access-token",
    refresh_token: "seeded-refresh-token",
    token_type: "Bearer",
    ...(input.expiresInSeconds === undefined ? {} : { expires_in: input.expiresInSeconds }),
  };
  if (input.legacyWithoutTimestamps) {
    // 旧格式：既无 generation 也无 obtained_at/expires_at。
    await credentialStore.saveMany({
      [`${keyPrefix}:authorization_credentials`]: JSON.stringify({
        client_information: { client_id: "seeded-client" },
        published_by: "legacy-publisher",
        tokens,
        version: 2,
      }),
      [`${keyPrefix}:client_information`]: JSON.stringify({ client_id: "seeded-client" }),
      [`${keyPrefix}:tokens`]: JSON.stringify(tokens),
    });
  } else {
    await publishCanonicalCredentials(credentialStore, keyPrefix, {
      clientInformation: { client_id: "seeded-client" },
      // 故意让它已经临期，使 token() 走刷新路径。
      obtainedAt: Date.now() - 3_600_000,
      publishedBy: "seed",
      tokens,
    });
  }
  return { credentialStore, keyPrefix, mcpUrl };
}

function createProvider(seeded: SeededCredentials) {
  return createMcpOAuthTokenProvider({
    config: { type: "authorization_code", scope: MCP_SCOPE },
    credentialStore: seeded.credentialStore,
    keyPrefix: seeded.keyPrefix,
    serverName: "refresh-test",
    serverUrl: seeded.mcpUrl,
  });
}

describe("MCP OAuth refresh single-flight", () => {
  it("coalesces concurrent near-expiry refreshes into one token request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authServer = await startFakeAuthorizationServer({
      gate,
      respond: () => ({
        status: 200,
        payload: {
          access_token: "rotated-access-token",
          expires_in: 3600,
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
        },
      }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      expiresInSeconds: 10,
      secret: "refresh-coalesce-secret",
    });

    // 两个独立 provider（等价于两个连接/两个进程）同时看到临期 token。
    const first = createProvider(seeded);
    const second = createProvider(seeded);
    const firstToken = first.token();
    // 等第一个请求真的打到 token endpoint 后再放第二个，确保两者重叠。
    for (let attempt = 0; attempt < 100 && authServer.refreshRequests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondToken = second.token();
    release();

    await expect(firstToken).resolves.toBe("rotated-access-token");
    await expect(secondToken).resolves.toBe("rotated-access-token");
    // 修复根因 1：并发用同一个 rotation refresh token 刷新会撞服务端 reuse-detection，
    // 整个 token family 被撤销。锁内重读让等待者直接复用 winner 的结果，零二次请求。
    expect(authServer.refreshRequests).toHaveLength(1);
    expect(authServer.refreshRequests[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "seeded-refresh-token",
    });
    // resource 必须带上（RFC 8707）：绕开 SDK 的 auth() 后受众绑定要自己补。
    expect(authServer.refreshRequests[0]?.resource).toBe(seeded.mcpUrl);
  });

  it("attempts exactly one refresh for an old record without timestamps", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({
        status: 200,
        payload: {
          access_token: "migrated-access-token",
          expires_in: 3600,
          refresh_token: "seeded-refresh-token",
          token_type: "Bearer",
        },
      }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      legacyWithoutTimestamps: true,
      secret: "refresh-migration-secret",
    });
    const provider = createProvider(seeded);

    // 旧记录没有 obtained_at/expires_at，无法算真实过期点，视为临期刷新一次。
    await expect(provider.token()).resolves.toBe("migrated-access-token");
    expect(authServer.refreshRequests).toHaveLength(1);

    // 刷新后写入了 expires_at，后续读取必须直接命中缓存，不再反复刷新。
    await expect(provider.token()).resolves.toBe("migrated-access-token");
    await expect(provider.token()).resolves.toBe("migrated-access-token");
    expect(authServer.refreshRequests).toHaveLength(1);
  });

  it("invalidates tokens and demands interactive authorization on invalid_grant", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({ status: 400, payload: { error: "invalid_grant" } }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      expiresInSeconds: 10,
      secret: "refresh-invalid-grant-secret",
    });
    const provider = createProvider(seeded);

    await expect(provider.token()).rejects.toMatchObject({
      code: MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE,
      reason: "invalid_grant",
    });
    // tokens 按 canonical CAS 失效；client 保留作为重新授权的种子。
    await expect(loadCanonicalCredentials(seeded.credentialStore, seeded.keyPrefix)).resolves
      .toBeUndefined();
    await expect(
      seeded.credentialStore.load(`${seeded.keyPrefix}:tokens`),
    ).resolves.toBeNull();
    await expect(
      seeded.credentialStore.load(`${seeded.keyPrefix}:client_information`),
    ).resolves.toContain("seeded-client");
  });

  it("invalidates client and tokens together on invalid_client", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({ status: 401, payload: { error: "invalid_client" } }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      expiresInSeconds: 10,
      secret: "refresh-invalid-client-secret",
    });
    const provider = createProvider(seeded);

    await expect(provider.token()).rejects.toMatchObject({
      code: MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE,
      reason: "invalid_client",
    });
    // client 与 token 必须整对丢弃：单独保留任一半都会在下次授权拼出错配身份。
    await expect(loadCanonicalCredentials(seeded.credentialStore, seeded.keyPrefix)).resolves
      .toBeUndefined();
    await expect(seeded.credentialStore.load(`${seeded.keyPrefix}:tokens`)).resolves.toBeNull();
    await expect(
      seeded.credentialStore.load(`${seeded.keyPrefix}:client_information`),
    ).resolves.toBeNull();
  });

  it("reports a configuration error instead of re-authorizing when a static clientId is rejected", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({ status: 401, payload: { error: "invalid_client" } }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      expiresInSeconds: 10,
      secret: "refresh-static-client-secret",
    });
    const provider = createMcpOAuthTokenProvider({
      config: { type: "authorization_code", clientId: "configured-client", scope: MCP_SCOPE },
      credentialStore: seeded.credentialStore,
      keyPrefix: seeded.keyPrefix,
      serverName: "refresh-test",
      serverUrl: seeded.mcpUrl,
    });

    // 静态配置 client 的 invalid_client 无法靠交互授权自愈：Phase 2 会复用同一个 client，
    // 转授权只会形成循环。
    await expect(provider.token()).rejects.toMatchObject({
      message: expect.stringContaining("invalid_client"),
    });
    await expect(provider.token()).rejects.not.toMatchObject({
      code: MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE,
    });
  });

  it("keeps credentials and fails soft on a proactive refresh network error", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({ status: 503, payload: { error: "temporarily_unavailable" } }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      expiresInSeconds: 10,
      secret: "refresh-proactive-softfail-secret",
    });
    const provider = createProvider(seeded);

    // proactive：token 还没被资源服务器拒绝，返回现值让请求继续走，401 路径保留最终裁决权。
    await expect(provider.token()).resolves.toBe("seeded-access-token");
    await expect(loadCanonicalCredentials(seeded.credentialStore, seeded.keyPrefix)).resolves
      .toMatchObject({ tokens: { access_token: "seeded-access-token" } });
  });

  it("raises a temporary failure instead of interactive authorization on a reactive refresh network error", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({ status: 503, payload: { error: "temporarily_unavailable" } }),
    });
    const seeded = await seedCredentials({
      authBaseUrl: authServer.baseUrl,
      expiresInSeconds: 10,
      secret: "refresh-reactive-softfail-secret",
    });
    const provider = createProvider(seeded);

    // reactive：现值刚被资源服务器拒绝，返回它必然产生第二次 401；而临时 AS 故障也不能被
    // 误判成需要交互授权。必须是独立的临时错误类型，且凭据保留。
    await expect(provider.onUnauthorized?.({} as never)).rejects.toMatchObject({
      code: MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE,
    });
    await expect(loadCanonicalCredentials(seeded.credentialStore, seeded.keyPrefix)).resolves
      .toMatchObject({ tokens: { refresh_token: "seeded-refresh-token" } });
  });

  it("demands interactive authorization when no refresh token is available", async () => {
    const authServer = await startFakeAuthorizationServer({
      respond: () => ({ status: 200, payload: {} }),
    });
    const directory = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-no-refresh-"));
    temporaryDirectories.push(directory);
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "refresh-none-secret" },
      filePath: join(directory, "credentials.json"),
    });
    const mcpUrl = `${authServer.baseUrl}/mcp`;
    const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
    const keyPrefix = createCredentialKeyPrefix("refresh-test", mcpUrl, oauthConfig);
    await publishCanonicalCredentials(credentialStore, keyPrefix, {
      clientInformation: { client_id: "seeded-client" },
      publishedBy: "seed",
      tokens: { access_token: "only-access-token", token_type: "Bearer" },
    });
    const provider = createMcpOAuthTokenProvider({
      config: oauthConfig,
      credentialStore,
      keyPrefix,
      serverName: "refresh-test",
      serverUrl: mcpUrl,
    });

    // 无 refresh token：不虚构刷新，直接用 access token 撑到 401。
    await expect(provider.token()).resolves.toBe("only-access-token");
    expect(authServer.refreshRequests).toHaveLength(0);
    // 401 之后没有可用 refresh token，只能交互授权。
    await expect(provider.onUnauthorized?.({} as never)).rejects.toMatchObject({
      code: MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE,
      reason: "no_refresh_token",
    });
  });
});

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
