/* fake 官方 Plugin + fake Streamable HTTP MCP 的端到端验证。
 *
 * 覆盖真实链路：Plugin 解析 -> provenance -> 可信 Origin 校验 -> tools/call 动态身份头注入 ->
 * 匿名 initialize / tools/list 与受保护 tools/call 的实际请求头，并验证官方鉴权路径**不会**创建
 * OAuth session（spec §6.3.1）。
 *
 * fake fixture 只存在于测试目录，不进入 OFFICIAL_PLUGIN_DEFINITIONS / SEA asset /
 * desktop bundle / remote prebuild 清单。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  McpServerConfig,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "zcode-official-http-mcp";
const MCP_KEY = "fake-official-search";
const TOOL_NAME = "fake_search";

const IDENTITY_HEADERS = {
  Authorization: "Bearer fake-jwt",
  "Bigmodel-Organization": "org-1",
  "Bigmodel-Project": "project-1",
  "Bigmodel-Target-Type": "TEAM",
  "X-Bigmodel-Authorization": "Bearer fake-maas-jwt",
};

interface ReceivedRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  rpcMethod?: string;
}

let server: Server;
let origin: string;
let requests: ReceivedRequest[];
let tempDir: string;
/** 服务端每个响应回带的 x-request-id，按 rpc 方法记下来供断言比对。 */
let emittedRequestIds: Array<{ requestId: string; rpcMethod?: string }>;
/** 置为 true 时 tools/call 返回 in-band 失败（HTTP 200 + isError），模拟配额耗尽。 */
let toolCallReturnsInBandError: boolean;

/** 最小 Streamable HTTP MCP 服务端：只实现本测试需要的四个协议动作。 */
function createFakeMcpServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET") {
      // 官方 MCP 第一阶段不启用服务端推流：GET 返回 405，SDK 视为"不支持推流"正常继续。
      requests.push({ headers: request.headers, method: "GET" });
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const message = raw ? (JSON.parse(raw) as { id?: unknown; method?: string }) : {};
      requests.push({
        headers: request.headers,
        method: "POST",
        ...(message.method ? { rpcMethod: message.method } : {}),
      });

      if (message.method === "notifications/initialized") {
        // 返回 202 是 MCP 惯例，也正是 SDK 尝试开 GET 推流的触发点。
        response.writeHead(202).end();
        return;
      }

      const result =
        message.method === "initialize"
          ? {
              capabilities: { tools: {} },
              protocolVersion: "2025-06-18",
              serverInfo: { name: "fake-official-mcp", version: "0.0.1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    description: "fake official search",
                    inputSchema: { properties: {}, type: "object" },
                    name: TOOL_NAME,
                  },
                ],
              }
            : message.method === "tools/call"
              ? request.headers.authorization === undefined
                ? {
                    content: [
                      {
                        text: '{"error_code":"coding_plan_required","message":"coding plan required"}',
                        type: "text",
                      },
                    ],
                    isError: true,
                  }
                : toolCallReturnsInBandError
                  ? {
                      content: [
                        {
                          text: '{"error_code":"quota_exceeded","message":"daily quota exceeded"}',
                          type: "text",
                        },
                      ],
                      isError: true,
                    }
                  : { content: [{ text: "fake result", type: "text" }] }
              : {};

      // 真实服务端由 logx.RequestID() 生成并回带，客户端只能从响应头读。
      const requestId = `req-${emittedRequestIds.length + 1}`;
      emittedRequestIds.push({
        requestId,
        ...(message.method ? { rpcMethod: message.method } : {}),
      });
      response.writeHead(200, { "content-type": "application/json", "x-request-id": requestId });
      response.end(JSON.stringify({ id: message.id ?? null, jsonrpc: "2.0", result }));
    });
  });
}

beforeEach(async () => {
  requests = [];
  emittedRequestIds = [];
  toolCallReturnsInBandError = false;
  server = createFakeMcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tempDir = await mkdtemp(join(tmpdir(), "zcode-official-mcp-e2e-"));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tempDir, { force: true, recursive: true });
});

/** 写出 fake 官方 Plugin fixture，URL 经模板变量注入 loopback endpoint。 */
async function discoverFakeOfficialPlugin(): Promise<{
  config: McpServerConfig;
  runtimeName: string;
}> {
  const pluginRoot = join(tempDir, PLUGIN_NAME);
  await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN_NAME }),
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        [MCP_KEY]: {
          auth: { provider: "jwt_token", type: "zcode_official" },
          timeoutMs: 30_000,
          type: "http",
          url: "${ZCODE_FAKE_OFFICIAL_MCP_URL}",
        },
      },
    }),
  );

  const outcome = await createNodePluginAdapter({
    storageRoot: join(tempDir, "plugins"),
  }).discoverPlugins({
    config: { dirs: [pluginRoot], enabled: true, enabledPlugins: {}, options: {} },
    env: { ZCODE_FAKE_OFFICIAL_MCP_URL: `${origin}/mcp` },
    storageRoot: join(tempDir, "plugins"),
    workingDirectory: tempDir,
  });

  const runtimeName = `plugin:${PLUGIN_NAME}:${MCP_KEY}`;
  const config = outcome.mcpServers[runtimeName];
  if (!config) {
    throw new Error(
      `fixture plugin did not produce an MCP config; diagnostics: ${JSON.stringify(outcome.diagnostics)}`,
    );
  }
  return { config, runtimeName };
}

function authPort(): OfficialMcpAuthHeadersPort & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    resolveHeaders: async () => {
      calls += 1;
      return { headers: IDENTITY_HEADERS, ok: true };
    },
  };
}

function loopbackRegistry(pluginId: string): OfficialMcpTrustedOriginRegistry {
  // loopback 例外只在测试通过依赖注入提供，不写入正式清单。
  return {
    isTrusted: async (input) => ({
      trusted: input.pluginId === pluginId && input.mcpKey === MCP_KEY && input.origin === origin,
    }),
  };
}

describe("official mcp end-to-end over a fake plugin and fake HTTP MCP", () => {
  it("OMCP-CALL-001: carries identity on discovery, listing, probes, and tools/call", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    const port = authPort();
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: port,
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      const status = await adapter.connectServer(runtimeName, config);
      expect(status.status).toBe("connected");

      const tools = await adapter.listTools();
      expect(tools.map((tool) => tool.toolName)).toContain(TOOL_NAME);
      // SG-02：http 官方 MCP 的结果来自已校验 origin 的 ZCode 后端，因此可以给结果背书
      // （UI 据此显示额度耗尽 / 无套餐提示）。stdio 不置位，见 stdio-meta 用例。
      expect(tools[0]?.official).toBe(true);

      const result = await adapter.callTool({ serverName: runtimeName, toolName: TOOL_NAME });
      expect(result.isError).not.toBe(true);

      const posts = requests.filter((entry) => entry.method === "POST");
      expect(posts.length).toBeGreaterThanOrEqual(3);
      const rpcMethods = posts.map((entry) => entry.rpcMethod);
      expect(rpcMethods).toContain("initialize");
      expect(rpcMethods).toContain("tools/call");

      expect(requests.filter((entry) => entry.rpcMethod === "tools/call")).toHaveLength(1);
      for (const entry of requests) {
        expect(entry.headers["authorization"]).toBe("Bearer fake-jwt");
        expect(entry.headers["x-bigmodel-authorization"]).toBe("Bearer fake-maas-jwt");
        expect(entry.headers["x-coding-plan-api-key"]).toBeUndefined();
        expect(entry.headers["bigmodel-target-type"]).toBe("TEAM");
        expect(entry.headers["bigmodel-organization"]).toBe("org-1");
        expect(entry.headers["bigmodel-project"]).toBe("project-1");
      }
      expect(port.calls).toBe(requests.length);

      // §6.3.4 的事实核对：SDK 在 initialized 收到 202 后确实会尝试 GET 推流，
      // 服务端 405 让它安全放弃且不影响连接（上面已断言 connected）。
      // §6.3.4 的事实固化：SDK 在 initialized 收到 202 后会尝试开 GET 推流，恰好一次。
      // 服务端 405 让它安全放弃且不重试（上面已断言 connected），这就是"不启用推流"的落地方式。
      expect(requests.filter((entry) => entry.method === "GET").length).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it("OMCP-013: creates no OAuth session and reports no authorization prompt", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    let authorizationRequired = 0;
    let openedAuthorizationUrl = 0;
    const adapter = createMcpAdapter({
      mcpOAuth: {
        onAuthorizationRequired: () => {
          authorizationRequired += 1;
        },
        openAuthorizationUrl: async () => {
          openedAuthorizationUrl += 1;
        },
      },
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      const status = await adapter.connectServer(runtimeName, config);
      expect(status.status).toBe("connected");
      // 官方鉴权路径必须完全绕开 OAuth：无授权回调、无 authorizationUrl
      expect(status.authorization).toBeUndefined();
      expect(authorizationRequired).toBe(0);
      expect(openedAuthorizationUrl).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it("OMCP-014: fails closed on 401 without falling back to an OAuth prompt", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    // 让 fake server 对所有 POST 返回 401
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((request, response) => {
      requests.push({ headers: request.headers, method: request.method ?? "" });
      response.writeHead(401, { "x-request-id": "req-auth-rejected" }).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(Number(new URL(origin).port), "127.0.0.1", resolve),
    );

    let authorizationRequired = 0;
    const adapter = createMcpAdapter({
      mcpOAuth: {
        onAuthorizationRequired: () => {
          authorizationRequired += 1;
        },
      },
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      const status = await adapter.connectServer(runtimeName, config);
      expect(status.status).toBe("failed");
      expect(status.error).toBe(
        "Version negotiation probe failed: official MCP rejected the current credential - req-auth-rejected",
      );
      expect(status.authorization).toBeUndefined();
      expect(authorizationRequired).toBe(0);
      // 401 至多重试一次：不自旋
      expect(requests.filter((entry) => entry.method === "POST").length).toBeLessThanOrEqual(2);
    } finally {
      await adapter.close();
    }
  });

  it("OMCP-003: fails closed when the endpoint origin is not in the trusted registry", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: { isTrusted: async () => ({ trusted: false }) },
      },
      workingDirectory: tempDir,
    });

    try {
      const status = await adapter.connectServer(runtimeName, config);
      expect(status.status).toBe("failed");
      expect(requests).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it("projects connection-stage server diagnostics into the failed status", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((request, response) => {
      requests.push({ headers: request.headers, method: request.method ?? "" });
      response
        .writeHead(400, {
          "content-type": "application/json",
          "x-request-id": "req-settings-3001",
        })
        .end(JSON.stringify({ code: 3001, msg: "parameter error" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(Number(new URL(origin).port), "127.0.0.1", resolve),
    );
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      await expect(adapter.connectServer(runtimeName, config)).resolves.toMatchObject({
        failureKind: "server_not_found",
        serverRequestId: "req-settings-3001",
        status: "failed",
      });
    } finally {
      await adapter.close();
    }
  });

  it("records the stable failure kind in the failure log, not only the message", async () => {
    // spec §6.3.3 的分类必须可 grep：message 文本里多数分类并不出现。
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const logs: Array<{ context?: Record<string, unknown>; message: string }> = [];
    const logger = {
      child: () => logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) => {
        logs.push({ ...(context ? { context } : {}), message });
      },
    };
    const adapter = createMcpAdapter({
      logger: logger as unknown as Parameters<typeof createMcpAdapter>[0]["logger"],
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: { isTrusted: async () => ({ trusted: false }) },
      },
      workingDirectory: tempDir,
    });
    try {
      await adapter.connectServer(runtimeName, config);
      const failure = logs.find((entry) => entry.context?.["event"] === "mcp.server.failed");
      // message 被 SDK 包装成 "Version negotiation probe failed: ..."，分类仍须可 grep
      expect(failure?.context?.["officialAuthKind"]).toBe("official_mcp_origin_untrusted");
    } finally {
      await adapter.close();
    }
  });

  it("records official_auth_rejected when the backend keeps returning 401", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((request, response) => {
      requests.push({ headers: request.headers, method: request.method ?? "" });
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(Number(new URL(origin).port), "127.0.0.1", resolve),
    );

    const logs: Array<{ context?: Record<string, unknown>; message: string }> = [];
    const logger = {
      child: () => logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) => {
        logs.push({ ...(context ? { context } : {}), message });
      },
    };
    const adapter = createMcpAdapter({
      logger: logger as unknown as Parameters<typeof createMcpAdapter>[0]["logger"],
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });
    try {
      await adapter.connectServer(runtimeName, config);
      const failure = logs.find((entry) => entry.context?.["event"] === "mcp.server.failed");
      expect(failure?.context?.["officialAuthKind"]).toBe("official_auth_rejected");
    } finally {
      await adapter.close();
    }
  });

  it("carries the server request id into an in-band tool failure result and log", async () => {
    // in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError：wrapper 的非 2xx warn 覆盖不到，
    // 而 request id 只有 wrapper 能看到，因此必须按 span 关联回 tool result。
    toolCallReturnsInBandError = true;
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    const logs: Array<{ context?: Record<string, unknown>; message: string }> = [];
    const logger = {
      child: () => logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) => {
        logs.push({ ...(context ? { context } : {}), message });
      },
    };
    const adapter = createMcpAdapter({
      logger: logger as unknown as Parameters<typeof createMcpAdapter>[0]["logger"],
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      expect((await adapter.connectServer(runtimeName, config)).status).toBe("connected");
      const result = await adapter.callTool({
        serverName: runtimeName,
        toolName: TOOL_NAME,
        trace: { spanId: "span-quota-1", traceId: "trace-session-1" },
      });

      expect(result.isError).toBe(true);
      const expected = emittedRequestIds.find((entry) => entry.rpcMethod === "tools/call");
      expect(expected?.requestId).toBeTruthy();
      expect(result._meta?.["zcode/officialMcpServerRequestId"]).toBe(expected?.requestId);

      // 生产日志级别是 Info，所以这条必须是 warn，不能只有 debug。
      const failure = logs.find((entry) => entry.context?.["event"] === "mcp.tool.call");
      expect(failure?.context).toMatchObject({
        isError: true,
        serverRequestId: expected?.requestId,
        status: "failed",
      });
    } finally {
      await adapter.close();
    }
  });

  it("omits the request id when the call succeeds or cannot be correlated", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: authPort(),
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      await adapter.connectServer(runtimeName, config);

      // 成功路径：id 不进结果，避免每次调用都往 _meta 里塞排障字段。
      const ok = await adapter.callTool({
        serverName: runtimeName,
        toolName: TOOL_NAME,
        trace: { spanId: "span-ok", traceId: "trace-session-1" },
      });
      expect(ok._meta?.["zcode/officialMcpServerRequestId"]).toBeUndefined();

      // 无 span 可关联时宁缺不猜：绝不把"最近一次响应"的 id 贴上来。
      toolCallReturnsInBandError = true;
      const failed = await adapter.callTool({ serverName: runtimeName, toolName: TOOL_NAME });
      expect(failed.isError).toBe(true);
      expect(failed._meta?.["zcode/officialMcpServerRequestId"]).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it("OMCP-CALL-002: connects and lists tools when no official auth port is injected", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });
    try {
      const status = await adapter.connectServer(runtimeName, config);
      expect(status.status).toBe("connected");
      expect((await adapter.listTools()).map((tool) => tool.toolName)).toContain(TOOL_NAME);

      const result = await adapter.callTool({ serverName: runtimeName, toolName: TOOL_NAME });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("coding_plan_required") }),
      ]);
      expect((await adapter.status())[runtimeName]?.status).toBe("connected");
    } finally {
      await adapter.close();
    }
  });

  it("re-resolves credentials after login without reconnecting", async () => {
    const { config, runtimeName } = await discoverFakeOfficialPlugin();
    const official = (config as { official: { pluginId: string } }).official;
    let loggedIn = false;
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: {
          resolveHeaders: async () =>
            loggedIn
              ? { headers: IDENTITY_HEADERS, ok: true as const }
              : { ok: false as const, reason: "official_auth_unavailable" as const },
        },
        trustedOrigins: loopbackRegistry(official.pluginId),
      },
      workingDirectory: tempDir,
    });

    try {
      expect((await adapter.connectServer(runtimeName, config)).status).toBe("connected");
      const denied = await adapter.callTool({ serverName: runtimeName, toolName: TOOL_NAME });
      expect(denied.isError).toBe(true);

      loggedIn = true;
      const allowed = await adapter.callTool({ serverName: runtimeName, toolName: TOOL_NAME });
      expect(allowed.isError).not.toBe(true);
      expect((await adapter.status())[runtimeName]?.status).toBe("connected");
    } finally {
      await adapter.close();
    }
  });
});
