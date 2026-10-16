/* 官方 MCP 逐请求动态身份头注入与失败分类。
   用真实 loopback HTTP server 验证"实际发出的请求头"，而不是 mock fetch 的调用参数。 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Logger,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import {
  createOfficialMcpAuthFetch,
  mergeOfficialAuthHeaders,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "../src/mcp/official-auth.js";

const PLUGIN_ID = "zcode-tools@zcode-plugins-official";
const MCP_KEY = "image-search";
const JWT_HEADERS = {
  Authorization: "Bearer jwt-current",
  "Bigmodel-Target-Type": "PERSONAL",
  "X-Bigmodel-Authorization": "Bearer maas-jwt-current",
};

interface Received {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
}

let server: Server;
let origin: string;
let received: Received[];
let respond: (index: number) => { body?: string; headers?: Record<string, string>; status: number };

beforeEach(async () => {
  received = [];
  respond = () => ({ body: JSON.stringify({ ok: true }), status: 200 });
  server = createServer((request, response) => {
    received.push({
      headers: request.headers,
      method: request.method ?? "",
      url: request.url ?? "",
    });
    const reply = respond(received.length - 1);
    response.writeHead(reply.status, {
      "content-type": "application/json",
      ...reply.headers,
    });
    response.end(reply.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function trustedRegistry(trusted = true): OfficialMcpTrustedOriginRegistry {
  return { isTrusted: async () => ({ trusted }) };
}

function headersPort(
  results: Array<Awaited<ReturnType<OfficialMcpAuthHeadersPort["resolveHeaders"]>>>,
): OfficialMcpAuthHeadersPort & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    resolveHeaders: async () => {
      const result = results[Math.min(calls, results.length - 1)]!;
      calls += 1;
      return result;
    },
  };
}

function rpcRequest(method: string, headers?: HeadersInit): RequestInit {
  return {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method }),
    ...(headers ? { headers } : {}),
    method: "POST",
  };
}

function createFetch(overrides: {
  logger?: Logger;
  onServerResponse?: (response: OfficialMcpServerResponseInfo) => void;
  port?: OfficialMcpAuthHeadersPort;
  registry?: OfficialMcpTrustedOriginRegistry;
  url?: string;
}): typeof globalThis.fetch {
  return createOfficialMcpAuthFetch({
    authHeadersPort: overrides.port ?? headersPort([{ headers: JWT_HEADERS, ok: true }]),
    baseFetch: globalThis.fetch,
    official: { mcpKey: MCP_KEY, pluginId: PLUGIN_ID, source: "plugin" },
    serverName: `plugin:zcode-tools:${MCP_KEY}`,
    trustedOrigins: overrides.registry ?? trustedRegistry(),
    url: overrides.url ?? `${origin}/mcp`,
    ...(overrides.logger ? { logger: overrides.logger } : {}),
    ...(overrides.onServerResponse ? { onServerResponse: overrides.onServerResponse } : {}),
  });
}

interface RecordedLog {
  context: Record<string, unknown>;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

/** 只收集日志，不做级别过滤——过滤由真实 logger 负责，这里要能断言"记在了哪个级别"。 */
function recordingLogger(): { entries: RecordedLog[]; logger: Logger } {
  const entries: RecordedLog[] = [];
  const push =
    (level: RecordedLog["level"]) =>
    (message: string, context: Record<string, unknown> = {}) => {
      entries.push({ context, level, message });
    };
  return {
    entries,
    logger: {
      debug: push("debug"),
      error: push("error"),
      info: push("info"),
      warn: push("warn"),
    } as unknown as Logger,
  };
}

describe("official mcp auth fetch", () => {
  it.each([
    {
      body: JSON.stringify({ code: 3001, msg: "parameter error" }),
      failureKind: "server_not_found",
      status: 400,
    },
    {
      body: JSON.stringify({ code: 1000, msg: "something went wrong" }),
      failureKind: "server_unavailable",
      status: 200,
    },
    {
      body: JSON.stringify({
        error: { code: 1006, message: "no permission" },
        id: 1,
        jsonrpc: "2.0",
      }),
      failureKind: "not_authenticated",
      status: 200,
    },
    {
      body: JSON.stringify({
        error: { code: 3101, message: "coding plan is required" },
        id: 1,
        jsonrpc: "2.0",
      }),
      failureKind: "coding_plan_required",
      status: 200,
    },
    {
      body: JSON.stringify({ error: null, id: 1, jsonrpc: "2.0" }),
      failureKind: "protocol_error",
      status: 200,
    },
    {
      body: JSON.stringify({ error: [], id: 1, jsonrpc: "2.0" }),
      failureKind: "protocol_error",
      status: 200,
    },
    {
      body: JSON.stringify({ error: "message", id: 1, jsonrpc: "2.0" }),
      failureKind: "protocol_error",
      status: 200,
    },
    {
      body: JSON.stringify({
        error: { code: "1006", message: "no permission" },
        id: 1,
        jsonrpc: "2.0",
      }),
      failureKind: "protocol_error",
      status: 200,
    },
    {
      body: JSON.stringify({
        error: { code: 3101, message: "coding plan is required" },
        id: 1,
        jsonrpc: "2.0",
      }),
      failureKind: "coding_plan_required",
      status: 400,
    },
    { body: "", failureKind: "rate_limited", status: 429 },
    { body: "", failureKind: "server_internal_error", status: 500 },
    {
      body: JSON.stringify({
        error: { code: -32601, message: "method not found" },
        id: 1,
        jsonrpc: "2.0",
      }),
      failureKind: "protocol_error",
      status: 200,
    },
  ])(
    "classifies trusted ZCode response diagnostics as $failureKind",
    async ({ body, failureKind, status }) => {
      respond = () => ({
        body,
        headers: { "x-request-id": `req-${failureKind}` },
        status,
      });
      const onServerResponse = vi.fn();
      const authFetch = createFetch({ onServerResponse });

      await authFetch(`${origin}/mcp`, rpcRequest("initialize")).catch(() => undefined);

      expect(onServerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          failureKind,
          rpcMethod: "initialize",
          serverRequestId: `req-${failureKind}`,
        }),
      );
    },
  );

  it("OMCP-CALL-001: injects identity headers on every trusted HTTP request", async () => {
    const port = headersPort([{ headers: JWT_HEADERS, ok: true }]);
    const authFetch = createFetch({ port });
    for (const method of [
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "ping",
    ]) {
      await authFetch(`${origin}/mcp`, rpcRequest(method));
    }
    await authFetch(`${origin}/mcp`, rpcRequest("tools/call"));

    expect(port.calls).toBe(6);
    expect(received).toHaveLength(6);
    for (const entry of received) {
      expect(entry.headers["authorization"]).toBe("Bearer jwt-current");
      expect(entry.headers["x-bigmodel-authorization"]).toBe("Bearer maas-jwt-current");
      expect(entry.headers["bigmodel-target-type"]).toBe("PERSONAL");
      // 旧通道已废弃，客户端必须一个字节都不发（同时发会让服务端额外校验 API key 归属）
      expect(entry.headers["x-coding-plan-api-key"]).toBeUndefined();
    }
  });

  it("injects identity headers into GET probes and unparseable trusted requests", async () => {
    const port = headersPort([{ headers: JWT_HEADERS, ok: true }]);
    const authFetch = createFetch({ port });

    await authFetch(`${origin}/mcp`, { method: "GET" });
    await authFetch(`${origin}/mcp`, { body: "not-json", method: "POST" });

    expect(port.calls).toBe(2);
    expect(received).toHaveLength(2);
    expect(received.every((entry) => entry.headers["authorization"] === "Bearer jwt-current")).toBe(
      true,
    );
  });

  it("OMCP-022: overwrites a pre-existing Authorization instead of appending", async () => {
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, {
      ...rpcRequest("tools/call"),
      headers: { Authorization: "Bearer stale-oauth-token" },
    });
    // 单值且为当前 JWT：append 会得到逗号拼接，"缺失才补"会保留 stale token
    expect(received[0]?.headers["authorization"]).toBe("Bearer jwt-current");
  });

  it("preserves protocol and content headers set by the SDK", async () => {
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, {
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-session-id": "session-abc",
      },
      method: "POST",
    });
    expect(received[0]?.headers["mcp-session-id"]).toBe("session-abc");
    expect(received[0]?.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(received[0]?.headers["accept"]).toBe("application/json, text/event-stream");
    expect(received[0]?.headers["content-type"]).toBe("application/json");
  });

  it("OMCP-003: fails closed with zero network requests when the origin is untrusted", async () => {
    const port = headersPort([{ headers: JWT_HEADERS, ok: true }]);
    const authFetch = createFetch({ port, registry: trustedRegistry(false) });
    await expect(authFetch(`${origin}/mcp`, rpcRequest("initialize"))).rejects.toMatchObject({
      kind: "official_mcp_origin_untrusted",
    });
    expect(received).toHaveLength(0);
    // 凭证也不该被解析
    expect(port.calls).toBe(0);
  });

  it("rejects a request whose URL origin drifts from the configured endpoint", async () => {
    const authFetch = createFetch({ url: `${origin}/mcp` });
    await expect(authFetch("http://127.0.0.1:1/mcp", { method: "POST" })).rejects.toBeInstanceOf(
      OfficialMcpAuthError,
    );
    expect(received).toHaveLength(0);
  });

  it("OMCP-CALL-002: sends tools/call anonymously when auth is unavailable", async () => {
    const port = headersPort([{ ok: false, reason: "official_auth_unavailable" }]);
    const authFetch = createFetch({ port });
    const response = await authFetch(`${origin}/mcp`, rpcRequest("tools/call"));
    expect(response.status).toBe(200);
    expect(port.calls).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers["authorization"]).toBeUndefined();
    expect(received[0]?.headers["x-bigmodel-authorization"]).toBeUndefined();
  });

  it("OMCP-CALL-003: sends only the identity header when a plan is required", async () => {
    const port = headersPort([{ headers: { Authorization: "Bearer logged-in-jwt" }, ok: true }]);
    const { entries, logger } = recordingLogger();
    const authFetch = createFetch({ logger, port });
    const response = await authFetch(`${origin}/mcp`, rpcRequest("tools/call"));
    expect(response.status).toBe(200);
    expect(port.calls).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers["authorization"]).toBe("Bearer logged-in-jwt");
    expect(received[0]?.headers["x-bigmodel-authorization"]).toBeUndefined();
    expect(received[0]?.headers["x-coding-plan-api-key"]).toBeUndefined();
    expect(
      entries.find((entry) => entry.message === "Official MCP request sending")?.context,
    ).toMatchObject({ identityHeaderNames: ["authorization"] });
  });

  it("OMCP-016: retries once on 401 and succeeds with the re-resolved credential", async () => {
    respond = (index) => (index === 0 ? { status: 401 } : { body: "{}", status: 200 });
    const port = headersPort([
      { headers: JWT_HEADERS, ok: true },
      { headers: { ...JWT_HEADERS, Authorization: "Bearer jwt-refreshed" }, ok: true },
    ]);
    const authFetch = createFetch({ port });
    const response = await authFetch(`${origin}/mcp`, rpcRequest("tools/call"));
    expect(response.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[1]?.headers["authorization"]).toBe("Bearer jwt-refreshed");
  });

  it("OMCP-017: retries at most once on persistent 401, then classifies as rejected", async () => {
    respond = () => ({ status: 401 });
    const authFetch = createFetch({});
    await expect(authFetch(`${origin}/mcp`, rpcRequest("tools/call"))).rejects.toMatchObject({
      kind: "official_auth_rejected",
    });
    // 恰好 2 次：1 次原始 + 1 次重试，不自旋
    expect(received).toHaveLength(2);
  });

  it("does not retry a 401 when tools/call was sent without credentials", async () => {
    respond = () => ({ status: 401 });
    const authFetch = createFetch({
      port: headersPort([{ ok: false, reason: "official_auth_unavailable" }]),
    });

    await expect(authFetch(`${origin}/mcp`, rpcRequest("tools/call"))).rejects.toMatchObject({
      kind: "official_auth_rejected",
    });
    expect(received).toHaveLength(1);
  });

  it("releases both persistent 401 response bodies after preserving the request id", async () => {
    const cancelled: number[] = [];
    let attempt = 0;
    const authFetch = createOfficialMcpAuthFetch({
      authHeadersPort: headersPort([{ headers: JWT_HEADERS, ok: true }]),
      baseFetch: vi.fn(async () => {
        const current = attempt;
        attempt += 1;
        return new Response(
          new ReadableStream({
            cancel: () => {
              cancelled.push(current);
            },
          }),
          { headers: { "x-request-id": `req-401-${current}` }, status: 401 },
        );
      }),
      official: { mcpKey: MCP_KEY, pluginId: PLUGIN_ID, source: "plugin" },
      serverName: `plugin:zcode-tools:${MCP_KEY}`,
      trustedOrigins: trustedRegistry(),
      url: `${origin}/mcp`,
    });

    await expect(authFetch(`${origin}/mcp`, rpcRequest("tools/call"))).rejects.toMatchObject({
      kind: "official_auth_rejected",
      message: expect.stringContaining("req-401-1"),
    });
    expect(cancelled).toEqual([0, 1]);
  });

  it("OMCP-015: never retries a 403", async () => {
    respond = () => ({ status: 403 });
    const authFetch = createFetch({});
    await expect(authFetch(`${origin}/mcp`, rpcRequest("tools/call"))).rejects.toMatchObject({
      kind: "official_auth_forbidden",
    });
    expect(received).toHaveLength(1);
  });

  it("OMCP-008: blocks redirects without following them", async () => {
    for (const status of [301, 302, 307, 308]) {
      received = [];
      respond = () => ({ headers: { location: "https://attacker.example/mcp" }, status });
      const authFetch = createFetch({});
      await expect(authFetch(`${origin}/mcp`, rpcRequest("tools/call"))).rejects.toMatchObject({
        kind: "official_auth_redirect_blocked",
      });
      // 只发出到可信 Origin 的那一次；不会带着 Bearer 去 attacker.example
      expect(received).toHaveLength(1);
    }
  });

  it("logs the server request id at warn on any non-2xx response", async () => {
    // 生产 logger 的最低级别是 Info，成功路径那条 debug 记录在生产里根本不落盘。
    // 出错时能对上服务端日志的唯一线索就是这条 warn。
    respond = () => ({
      body: JSON.stringify({ code: 3001, msg: "parameter error" }),
      headers: { "x-request-id": "req-3001-abc" },
      status: 400,
    });
    const { entries, logger } = recordingLogger();
    const authFetch = createFetch({ logger });

    const response = await authFetch(`${origin}/mcp`, { method: "POST" });

    expect(response.status).toBe(400);
    const warned = entries.filter((entry) => entry.level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.context).toMatchObject({
      httpStatus: 400,
      mcpKey: MCP_KEY,
      serverRequestId: "req-3001-abc",
    });
  });

  it("omits serverRequestId instead of inventing one when the server sends no header", async () => {
    respond = () => ({ body: "{}", status: 500 });
    const { entries, logger } = recordingLogger();
    const authFetch = createFetch({ logger });

    await authFetch(`${origin}/mcp`, { method: "POST" });

    const warned = entries.filter((entry) => entry.level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.context).toMatchObject({ httpStatus: 500 });
    expect(warned[0]?.context).not.toHaveProperty("serverRequestId");
  });

  it("carries the server request id into the classified 401 / 403 / redirect errors", async () => {
    // 分类错误会成为 MCP record 的失败原因；request id 只进日志的话，用户报障时
    // 还得再去翻日志文件才能给出这个 id。
    const cases: Array<{
      kind: string;
      message: string;
      requestId: string;
      status: number;
    }> = [
      {
        kind: "official_auth_rejected",
        message: "official MCP rejected the current credential - req-401",
        requestId: "req-401",
        status: 401,
      },
      {
        kind: "official_auth_forbidden",
        message: "official MCP denied access for the current plan - req-403",
        requestId: "req-403",
        status: 403,
      },
      {
        kind: "official_auth_redirect_blocked",
        message: "official MCP responded with a blocked redirect (307) - req-307",
        requestId: "req-307",
        status: 307,
      },
    ];
    for (const testCase of cases) {
      received = [];
      respond = () => ({
        headers: {
          location: "https://attacker.example/mcp",
          "x-request-id": testCase.requestId,
        },
        status: testCase.status,
      });
      const authFetch = createFetch({});
      await expect(authFetch(`${origin}/mcp`, rpcRequest("tools/call"))).rejects.toMatchObject({
        kind: testCase.kind,
        message: testCase.message,
      });
    }
  });

  it("OMCP-012/027: resolves credentials per request, so a rotation is picked up immediately", async () => {
    const port = headersPort([
      { headers: JWT_HEADERS, ok: true },
      {
        headers: { ...JWT_HEADERS, "X-Bigmodel-Authorization": "Bearer maas-jwt-rotated" },
        ok: true,
      },
    ]);
    const authFetch = createFetch({ port });
    await authFetch(`${origin}/mcp`, rpcRequest("tools/call"));
    await authFetch(`${origin}/mcp`, rpcRequest("tools/call"));
    expect(received[0]?.headers["x-bigmodel-authorization"]).toBe("Bearer maas-jwt-current");
    expect(received[1]?.headers["x-bigmodel-authorization"]).toBe("Bearer maas-jwt-rotated");
  });

  it("passes the abort signal through to the auth port", async () => {
    const resolveHeaders = vi.fn(async () => ({ headers: JWT_HEADERS, ok: true as const }));
    const controller = new AbortController();
    const authFetch = createFetch({ port: { resolveHeaders } });
    await authFetch(`${origin}/mcp`, { ...rpcRequest("tools/call"), signal: controller.signal });
    expect(resolveHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ mcpKey: MCP_KEY, pluginId: PLUGIN_ID, signal: controller.signal }),
    );
  });
});

describe("mergeOfficialAuthHeaders", () => {
  it("drops reserved identity headers coming from any upstream source", () => {
    const merged = mergeOfficialAuthHeaders(
      {
        Authorization: "Bearer stale",
        "Bigmodel-Organization": "spoofed-org",
        // 现在这是真身份头，静态值必须被 resolved 值**覆盖**（而不是丢弃）
        "x-bigmodel-authorization": "Bearer spoofed",
        // 旧通道客户端不再发送，但服务端仍然认它，因此静态注入必须被**丢弃**
        "x-coding-plan-api-key": "spoofed-plan-key",
        "x-trace-hint": "keep-me",
      },
      JWT_HEADERS,
    );
    expect(merged.get("authorization")).toBe("Bearer jwt-current");
    expect(merged.get("bigmodel-organization")).toBeNull();
    expect(merged.get("x-bigmodel-authorization")).toBe("Bearer maas-jwt-current");
    expect(merged.get("x-coding-plan-api-key")).toBeNull();
    expect(merged.get("x-trace-hint")).toBe("keep-me");
  });

  it("keeps protocol headers untouched", () => {
    const merged = mergeOfficialAuthHeaders(
      { "mcp-protocol-version": "2026-07-28", "mcp-session-id": "s1" },
      JWT_HEADERS,
    );
    expect(merged.get("mcp-session-id")).toBe("s1");
    expect(merged.get("mcp-protocol-version")).toBe("2026-07-28");
  });
});

/* 关联 id：服务端已明确否决"采用客户端传入的 request id"（logx.RequestID 始终自行生成、
   不读入站 header）。因此客户端不发送这两个头，只做两件事：剥离插件注入的值、从响应头
   读回服务端生成的 id 用于对账。 */
describe("official mcp correlation ids", () => {
  it("does not send x-request-id or x-trace-id", async () => {
    // 发了不会被任何人读取，属死代码；这条用例锁住"不发"这一决策。
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, { method: "POST" });

    expect(received[0]!.headers["x-request-id"]).toBeUndefined();
    expect(received[0]!.headers["x-trace-id"]).toBeUndefined();
  });

  it("strips correlation headers injected by static plugin config", async () => {
    // 插件设的值会原样出现在服务端与中间层日志里，属可观测通道污染，必须剥掉。
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, {
      headers: { "x-request-id": "attacker-supplied", "x-trace-id": "attacker-trace" },
      method: "POST",
    });

    expect(received[0]!.headers["x-request-id"]).toBeUndefined();
    expect(received[0]!.headers["x-trace-id"]).toBeUndefined();
  });

  it("strips them on the 401 retry as well", async () => {
    // 重试走的是同一个 send()，但仍要确认第二次请求没有把它们漏出去。
    respond = (index) => (index === 0 ? { status: 401 } : { body: "{}", status: 200 });
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, {
      ...rpcRequest("tools/call"),
      headers: { "x-trace-id": "leaked" },
    });

    expect(received).toHaveLength(2);
    for (const entry of received) {
      expect(entry.headers["x-request-id"]).toBeUndefined();
      expect(entry.headers["x-trace-id"]).toBeUndefined();
    }
  });

  it("does not forward trace_id from the tools/call _meta", async () => {
    // _meta 里的 trace 只进客户端日志（mcpTraceId），不落到 HTTP 头上。
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, {
      body: JSON.stringify({
        id: 7,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { query: "should not leak anywhere" },
          _meta: { session_id: "sess-1", trace_id: "trace-xyz-789" },
          name: "search_image",
        },
      }),
      method: "POST",
    });

    expect(received[0]!.headers["x-trace-id"]).toBeUndefined();
  });

  it("keeps the identity headers intact while stripping correlation ones", async () => {
    // 回归护栏：delete 的实现不得误伤身份头。
    const authFetch = createFetch({});
    await authFetch(`${origin}/mcp`, {
      ...rpcRequest("tools/call"),
      headers: { "x-request-id": "drop-me" },
    });

    expect(received[0]!.headers["authorization"]).toBe("Bearer jwt-current");
    expect(received[0]!.headers["x-bigmodel-authorization"]).toBe("Bearer maas-jwt-current");
    expect(received[0]!.headers["bigmodel-target-type"]).toBe("PERSONAL");
  });
});
