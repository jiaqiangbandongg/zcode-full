import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../src/auth/shared-credentials.js";
import { publishCanonicalCredentials } from "../src/mcp/oauth-credentials.js";
import { createCredentialKeyPrefix } from "../src/mcp/oauth.js";

/**
 * 跨进程端到端验证:线上事故的竞态发生在多个真实 CLI 进程之间,同进程测试无法复现
 * 「两个进程同时读到临期 token / 同时抢授权」这个现场形态。本文件用 tsx 拉起真实 OS
 * 子进程驱动 adapters 源码,主进程只托管假授权服务器/假 MCP 并做协议级断言。
 */

const MCP_SCOPE = "mcp:tools";
const OAUTH_ACCESS_TOKEN = "cross-process-access-token";
const ROTATED_ACCESS_TOKEN = "cross-process-rotated-token";
const CHILD_TIMEOUT_MS = 60_000;

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CHILD_DRIVER = fileURLToPath(
  new URL("./fixtures/mcp-oauth-child-driver.ts", import.meta.url),
);

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

interface StrictServerState {
  authorizationCodes: Map<
    string,
    { challenge: string; clientId: string; redirectUri: string }
  >;
  clients: Map<string, { redirectUris: string[] }>;
  /** 单次使用的 refresh token;二次使用即 invalid_grant(rotation reuse-detection)。 */
  consumedRefreshTokens: Set<string>;
  knownRefreshTokens: Set<string>;
  refreshRequestCount: number;
  refreshRequestBodies: Array<Record<string, string>>;
  registrations: Array<Record<string, unknown>>;
  authorizationRequests: Array<Record<string, string>>;
  tokenExchanges: Array<Record<string, string>>;
}

function createState(): StrictServerState {
  return {
    authorizationCodes: new Map(),
    clients: new Map(),
    consumedRefreshTokens: new Set(),
    knownRefreshTokens: new Set(),
    refreshRequestCount: 0,
    refreshRequestBodies: [],
    registrations: [],
    authorizationRequests: [],
    tokenExchanges: [],
  };
}

interface FakeStack {
  asBaseUrl: string;
  mcpUrl: string;
  state: StrictServerState;
}

/** 假授权服务器 + 假受保护 MCP。redirect_uri 精确匹配(含端口),模拟 auth.exa.ai 行为。 */
async function startFakeStack(): Promise<FakeStack> {
  const state = createState();
  const stack: FakeStack = { asBaseUrl: "", mcpUrl: "", state };

  const authServer = createServer((req, res) => {
    void handleAuthServer(req, res, stack).catch(() => res.destroy());
  });
  await listen(authServer);
  stack.asBaseUrl = serverBaseUrl(authServer);

  const mcpServer = createServer((req, res) => {
    void handleMcp(req, res, stack).catch(() => res.destroy());
  });
  await listen(mcpServer);
  stack.mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;
  return stack;
}

async function handleAuthServer(
  req: IncomingMessage,
  res: ServerResponse,
  stack: FakeStack,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const state = stack.state;
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: stack.asBaseUrl,
      authorization_endpoint: `${stack.asBaseUrl}/authorize`,
      token_endpoint: `${stack.asBaseUrl}/token`,
      registration_endpoint: `${stack.asBaseUrl}/register`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [MCP_SCOPE, "admin:tools"],
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/register") {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    state.registrations.push(body);
    const clientId = `cross-process-client-${state.registrations.length}`;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    state.clients.set(clientId, { redirectUris });
    // RFC 7591:注册响应必须回显已注册元数据;SDK 会对响应做 schema 校验
    // (redirect_uris 必须是数组),只回 client_id 会在解析阶段失败。
    sendJson(res, 201, {
      ...body,
      client_id: clientId,
      client_id_issued_at: 1,
      token_endpoint_auth_method: "none",
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/authorize") {
    const params = Object.fromEntries(url.searchParams.entries());
    state.authorizationRequests.push(params);
    const clientId = params.client_id ?? "";
    const redirectUri = params.redirect_uri ?? "";
    const challenge = params.code_challenge ?? "";
    const registered = state.clients.get(clientId);
    // 精确匹配(含端口):对 loopback 不做 RFC 8252 端口豁免,模拟 auth.exa.ai。
    if (
      !registered ||
      !redirectUri ||
      params.code_challenge_method !== "S256" ||
      !registered.redirectUris.includes(redirectUri)
    ) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    const code = `auth-code-${state.authorizationRequests.length}`;
    state.authorizationCodes.set(code, { challenge, clientId, redirectUri });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    if (params.state) callback.searchParams.set("state", params.state);
    res.writeHead(302, { Location: callback.toString() });
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/token") {
    const body = new URLSearchParams(await readBody(req));
    const entries = Object.fromEntries(body.entries());
    if (body.get("grant_type") === "refresh_token") {
      const refreshToken = body.get("refresh_token") ?? "";
      state.refreshRequestCount += 1;
      state.refreshRequestBodies.push(entries);
      if (
        state.consumedRefreshTokens.has(refreshToken) ||
        !state.knownRefreshTokens.has(refreshToken)
      ) {
        // 严格 rotation:同一 refresh token 二次使用即整族作废。
        sendJson(res, 400, { error: "invalid_grant" });
        return;
      }
      state.consumedRefreshTokens.add(refreshToken);
      const nextRefreshToken = `rotated-rt-${state.refreshRequestCount}`;
      state.knownRefreshTokens.add(nextRefreshToken);
      sendJson(res, 200, {
        access_token: ROTATED_ACCESS_TOKEN,
        expires_in: 3600,
        refresh_token: nextRefreshToken,
        token_type: "Bearer",
      });
      return;
    }
    const code = body.get("code") ?? "";
    const verifier = body.get("code_verifier") ?? "";
    const redirectUri = body.get("redirect_uri") ?? "";
    const issued = state.authorizationCodes.get(code);
    const actualChallenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      !issued ||
      redirectUri !== issued.redirectUri ||
      actualChallenge !== issued.challenge
    ) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    state.authorizationCodes.delete(code);
    state.tokenExchanges.push(entries);
    const refreshToken = `issued-rt-${state.tokenExchanges.length}`;
    state.knownRefreshTokens.add(refreshToken);
    sendJson(res, 200, {
      access_token: OAUTH_ACCESS_TOKEN,
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: MCP_SCOPE,
      token_type: "Bearer",
    });
    return;
  }
  res.writeHead(404).end();
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  stack: FakeStack,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    sendJson(res, 200, {
      authorization_servers: [stack.asBaseUrl],
      resource: stack.mcpUrl,
      scopes_supported: [MCP_SCOPE],
    });
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${OAUTH_ACCESS_TOKEN}`) {
    res.writeHead(401, {
      "WWW-Authenticate": [
        `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", stack.mcpUrl).href}", scope="${MCP_SCOPE}"`,
      ],
    });
    res.end();
    return;
  }
  const message = JSON.parse(await readBody(req)) as { id?: number | string; method?: string };
  if (message.method === "initialize") {
    sendJson(res, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: "2025-11-25",
        serverInfo: { name: "cross-process-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    // tools/list 必须真实返回工具:客户端建连的最后一跳就是它,回错误会让整次连接失败。
    sendJson(res, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        tools: [
          {
            description: "cross-process ping",
            inputSchema: { properties: {}, type: "object" },
            name: "oauth_ping",
          },
        ],
      },
    });
    return;
  }
  // server/discover 回 -32601:让 modern 版本协商回退到 legacy initialize 握手。
  if (message.method === "server/discover") {
    sendJson(res, 200, {
      error: { code: -32601, message: "Method not found" },
      id: message.id,
      jsonrpc: "2.0",
    });
    return;
  }
  sendJson(res, 202, {});
}

interface ChildResult {
  authorizationUrls?: string[];
  error?: string;
  status?: { authorization?: { authorizationUrl?: string }; status?: string; toolCount?: number };
  token?: string;
}

interface ChildHandle {
  kill(): void;
  result: Promise<ChildResult>;
}

function runChild(config: Record<string, unknown>): ChildHandle {
  // 用 `node --import tsx` 让驱动直接运行在本进程:tsx CLI 包装器会把自己的真正工作放进
  // 子进程,SIGKILL 包装器只会留下孤儿——孤儿持有 lease 且 PID 存活,owner-dead 回收就
  // 无法验证。--import 在进程内注册 loader,child.pid 即驱动进程本身。
  const child = spawn(process.execPath, ["--import", "tsx", CHILD_DRIVER, JSON.stringify(config)], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const result = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child timed out after ${CHILD_TIMEOUT_MS}ms; stderr: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const jsonLine = stdout.trim().split("\n").at(-1);
      if (code !== 0 || !jsonLine) {
        reject(new Error(`child exited with ${code}; stderr: ${stderr}; stdout: ${stdout}`));
        return;
      }
      resolve(JSON.parse(jsonLine) as ChildResult);
    });
  });
  return { kill: () => child.kill("SIGKILL"), result };
}

async function createCredentials(secret: string): Promise<{
  credentialStore: SharedZCodeCredentialStore;
  credentialsPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-cross-process-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  return {
    credentialStore: createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: secret },
      filePath: credentialsPath,
    }),
    credentialsPath,
  };
}

describe("MCP OAuth cross-process end-to-end", () => {
  it("two real processes refresh one near-expiry token with exactly one network request", async () => {
    const stack = await startFakeStack();
    const { credentialStore, credentialsPath } = await createCredentials("cross-process-refresh");
    const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
    const keyPrefix = createCredentialKeyPrefix("cross", stack.mcpUrl, oauthConfig);
    stack.state.knownRefreshTokens.add("seed-rt-0");
    await publishCanonicalCredentials(credentialStore, keyPrefix, {
      clientInformation: { client_id: "seed-client" },
      // 已经过期一小时:两个子进程的 token() 都会判定临期并进锁。
      obtainedAt: Date.now() - 7_200_000,
      publishedBy: "cross-process-seed",
      tokens: {
        access_token: "stale-access-token",
        expires_in: 3600,
        refresh_token: "seed-rt-0",
        token_type: "Bearer",
      },
    });

    const config = {
      credentialsPath,
      keyPrefix,
      mcpUrl: stack.mcpUrl,
      mode: "refresh-race" as const,
      secret: "cross-process-refresh",
    };
    const racers = [runChild(config), runChild(config)];
    const [first, second] = await Promise.all(racers.map((child) => child.result));

    // 根因 1 的现场形态:两个真实进程并发用同一 rotation refresh token 刷新。修复后,
    // 跨进程文件锁 + 锁内 generation 合并保证只有一个请求到达 token endpoint;
    // 若有两个,严格服务器会 invalid_grant、token family 被撤销,子进程会失败。
    expect(first.token).toBe(ROTATED_ACCESS_TOKEN);
    expect(second.token).toBe(ROTATED_ACCESS_TOKEN);
    expect(stack.state.refreshRequestCount).toBe(1);
    expect(stack.state.refreshRequestBodies[0]?.grant_type).toBe("refresh_token");
    expect(stack.state.refreshRequestBodies[0]?.refresh_token).toBe("seed-rt-0");
    // RFC 8707 resource 受众参数必须带上。
    expect(stack.state.refreshRequestBodies[0]?.resource).toBe(stack.mcpUrl);
  }, 90_000);

  it("two real processes elect one authorization leader with one DCR and one authorization URL", async () => {
    const stack = await startFakeStack();
    const { credentialsPath } = await createCredentials("cross-process-authorize");
    const config = {
      autoDrive: true,
      credentialsPath,
      mcpUrl: stack.mcpUrl,
      mode: "authorize" as const,
      secret: "cross-process-authorize",
    };

    const racers = [runChild(config), runChild(config)];
    const [first, second] = await Promise.all(racers.map((child) => child.result));

    // 根因 2 的现场形态:过去两个连接各开一个 listener、各注册一个 client、各生成一个
    // 授权 URL,且 client 的 redirect_uris 锁死各自的随机端口。修复后跨进程授权 lease
    // 单飞:恰好一次 DCR、一个授权 URL;follower 观察 canonical 换代后用新凭据重连。
    expect(first.status?.status).toBe("connected");
    expect(second.status?.status).toBe("connected");
    expect(first.status?.toolCount).toBe(1);
    expect(second.status?.toolCount).toBe(1);
    const drivenUrls = [...(first.authorizationUrls ?? []), ...(second.authorizationUrls ?? [])];
    expect(drivenUrls).toHaveLength(1);
    expect(stack.state.registrations).toHaveLength(1);
    expect(stack.state.authorizationRequests).toHaveLength(1);
    expect(stack.state.tokenExchanges).toHaveLength(1);
    // fresh DCR 注册的 redirect_uri 就是授权请求实际使用的地址(精确匹配服务器下必须一致)。
    expect(stack.state.registrations[0]?.redirect_uris).toEqual([
      stack.state.authorizationRequests[0]?.redirect_uri,
    ]);
  }, 90_000);

  it("reclaims the authorization lease and completes after the leader process is killed", async () => {
    const stack = await startFakeStack();
    const { credentialStore, credentialsPath } = await createCredentials("cross-process-kill");
    const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
    const keyPrefix = createCredentialKeyPrefix("cross", stack.mcpUrl, oauthConfig);
    const secret = "cross-process-kill";
    const leaderConfig = {
      // 不 autoDrive:leader 会停在等回调,模拟用户还没在浏览器完成授权。
      autoDrive: false,
      credentialsPath,
      mcpUrl: stack.mcpUrl,
      mode: "authorize" as const,
      secret,
      // 必须与主进程计算 keyPrefix 用的 serverName 一致,否则轮询不到 pending 键。
      serverName: "cross",
    };

    const leader = runChild(leaderConfig);
    // 等 leader 发布 pending_authorization 共享键(证明它已进入授权等待)。
    const pendingKey = `${keyPrefix}:pending_authorization`;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await credentialStore.load(pendingKey)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await credentialStore.load(pendingKey)).toBeTruthy();

    // SIGKILL leader:不留任何清理机会,lease 目录里是死 PID 的 owner 文件。
    // runChild 无法定向杀,所以这里绕过封装直接拿 child 进程。
    leader.kill();
    await leader.result.catch(() => undefined);
    const successor = await runChild({ ...leaderConfig, autoDrive: true }).result;
    // 接管者必须先回收死 owner 的锁,再以 fresh DCR 重新领导授权;被杀 leader 的 code
    // 永远不会被交换(它从未收到回调),token endpoint 只应见到一次 exchange。
    expect(successor.status?.status).toBe("connected");
    expect(successor.authorizationUrls).toHaveLength(1);
    expect(stack.state.tokenExchanges).toHaveLength(1);
    const canonicalRaw = await credentialStore.load(`${keyPrefix}:authorization_credentials`);
    expect(canonicalRaw).toBeTruthy();
    const canonical = JSON.parse(canonicalRaw ?? "{}") as {
      client_information?: { client_id?: string };
    };
    // 最终发布的必须是接管者这次授权的 client,不是死 leader 留下的注册。
    expect(canonical.client_information?.client_id).toBe("cross-process-client-2");
    expect(stack.state.registrations).toHaveLength(2);
  }, 90_000);

  it("completes authorization that outlasts the caller budget (incident timeline replay)", async () => {
    // 现场:2026-08-11 真人授权耗时约 74 秒,而 session 预算只有 15 秒。旧实现 15 秒后
    // 关闭 listener,授权必败;新实现预算只约束 caller 等待,事务继续存活。
    // 按比例缩放:caller 预算 100ms,「用户」1500ms 后才完成授权。
    const stack = await startFakeStack();
    const { credentialStore, credentialsPath } = await createCredentials("cross-process-budget");
    const secret = "cross-process-budget";
    const { createMcpAdapter } = await import("../src/mcp/index.js");
    const adapter = createMcpAdapter({
      mcpOAuth: {
        credentialStore,
        openAuthorizationUrl: async ({ authorizationUrl }) => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const response = await fetch(authorizationUrl, { redirect: "manual" });
          const location = response.headers.get("location");
          if (location) await fetch(location);
        },
      },
    });

    try {
      const budgeted = await adapter.connectServer(
        "budget",
        { type: "http", url: stack.mcpUrl, oauth: { type: "authorization_code", scope: MCP_SCOPE } },
        { oauthAuthorizationTimeoutMs: 100 },
      );
      // 预算到点只返回快照:connecting + 授权 URL,事务没有被杀。
      expect(budgeted.status).toBe("connecting");
      expect(budgeted.authorization?.authorizationUrl).toContain(stack.asBaseUrl);

      let final = budgeted;
      for (let attempt = 0; attempt < 100 && final.status !== "connected"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        final = (await adapter.status()).budget ?? final;
      }
      expect(final.status).toBe("connected");
      expect(final.toolCount).toBe(1);
      expect(stack.state.registrations).toHaveLength(1);
      expect(stack.state.authorizationRequests).toHaveLength(1);
      expect(stack.state.tokenExchanges).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  }, 90_000);
});

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<Server> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

function serverBaseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening on TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
