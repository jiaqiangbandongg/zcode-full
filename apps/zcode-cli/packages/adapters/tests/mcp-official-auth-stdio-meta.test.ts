/* OMCP-S01~S06 —— stdio 官方 MCP 的身份头随所有出站请求与通知的 `_meta` 下发
   （phase-2 spec §6：docs/coding-plan/zcode-official-server-mcp-stdio-meta-phase-2-spec.md）。

   这里验证"注入点的行为"：命中/失败/不信任/无端口/非官方 server 五种形态下 `_meta` 的形状。
   凭证解析本身在 services 侧测试，配置解析在 plugin-official-mcp-auth.test.ts。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_MCP_AUTH_META_KEY } from "@zcode/shared";
import type { McpServerConfig } from "@zcode/contracts";

const {
  clientCallToolMock,
  clientConnectMock,
  clientListToolsMock,
  clientCloseMock,
  transportSendMock,
  transportCloseMock,
} = vi.hoisted(() => ({
  clientCallToolMock: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  clientConnectMock: vi.fn(async () => {}),
  clientListToolsMock: vi.fn(async () => ({ tools: [] })),
  clientCloseMock: vi.fn(async () => {}),
  transportSendMock: vi.fn(async () => {}),
  transportCloseMock: vi.fn(async () => {}),
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/client")>();
  return {
    ...actual,
    Client: class {
      private transport?: { send(message: unknown): Promise<void> };
      readonly close = clientCloseMock;
      readonly ping = vi.fn(async () => ({}));
      onclose?: () => void;

      async connect(transport: { send(message: unknown): Promise<void> }) {
        this.transport = transport;
        await clientConnectMock(transport);
        await transport.send({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} });
        await transport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { capabilities: {}, clientInfo: { name: "test", version: "1" } },
        });
        await transport.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      }

      async listTools() {
        await this.transport?.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return await clientListToolsMock();
      }

      async callTool(params: Record<string, unknown>) {
        await this.transport?.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params });
        return await clientCallToolMock(params);
      }

      getProtocolEra() {
        return "modern";
      }

      getNegotiatedProtocolVersion() {
        return "2026-07-28";
      }
    },
  };
});

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {
    readonly close = transportCloseMock;
    readonly pid = 4242;
    readonly stderr = { on: vi.fn() };

    async send(message: unknown) {
      await transportSendMock(message);
    }
  },
}));

import { createMcpAdapter } from "../src/mcp/index.js";

const ZCODE_ORIGIN = "https://zcode.example";
const PLUGIN_ID = "video-agent-kit@zcode-plugins-official";
const MCP_KEY = "video-edit";

const IDENTITY_HEADERS = {
  Authorization: "Bearer jwt-1",
  "Bigmodel-Organization": "org-1",
  "Bigmodel-Project": "project-1",
  "Bigmodel-Target-Type": "TEAM",
  "X-Bigmodel-Authorization": "Bearer maas-jwt-1",
};

function officialStdioConfig(): McpServerConfig {
  return {
    auth: { provider: "jwt_token", type: "zcode_official" },
    command: "python3",
    official: { mcpKey: MCP_KEY, pluginId: PLUGIN_ID, source: "plugin" },
    type: "stdio",
  };
}

/** 取指定协议方法最后一次实际写入 stdio 的 `_meta`（没有则 undefined）。 */
function lastWireMeta(method = "tools/call"): Record<string, unknown> | undefined {
  const sent = transportSendMock.mock.calls
    .map(
      ([message]) => message as { method?: string; params?: { _meta?: Record<string, unknown> } },
    )
    .filter((message) => message.method === method)
    .at(-1);
  return sent?.params?._meta;
}

describe("official stdio MCP auth via tools/call _meta", () => {
  beforeEach(() => {
    clientCallToolMock.mockClear();
    clientConnectMock.mockClear();
    clientListToolsMock.mockClear();
    transportSendMock.mockClear();
    clientCallToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    clientListToolsMock.mockResolvedValue({ tools: [] });
  });

  it("OMCP-S01: attaches the resolved identity headers for an official stdio server", async () => {
    const resolveHeaders = vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const }));
    const isTrusted = vi.fn(async () => ({ trusted: true }));
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: { resolveHeaders },
        resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
        trustedOrigins: { isTrusted },
      },
      workingDirectory: "/repo",
    });
    await adapter.connectServer("plugin:video-agent-kit:video-edit", officialStdioConfig());

    await adapter.callTool({
      arguments: { text: "你好" },
      serverName: "plugin:video-agent-kit:video-edit",
      toolName: "tts_generate",
    });

    for (const method of ["server/discover", "initialize", "notifications/initialized"]) {
      expect(lastWireMeta(method)?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
        headers: IDENTITY_HEADERS,
        ok: true,
      });
    }
    expect(lastWireMeta("tools/list")?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      headers: IDENTITY_HEADERS,
      ok: true,
    });
    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      headers: IDENTITY_HEADERS,
      ok: true,
    });
    // targetOrigin 由宿主给出，不来自任何插件配置（phase-2 spec §5）
    expect(resolveHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpKey: MCP_KEY,
        pluginId: PLUGIN_ID,
        targetOrigin: ZCODE_ORIGIN,
        workspacePath: "/repo",
      }),
    );
  });

  it("OMCP-S02: keeps trace context and identity headers side by side", async () => {
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: {
          resolveHeaders: vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const })),
        },
        resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
        trustedOrigins: { isTrusted: vi.fn(async () => ({ trusted: true })) },
      },
    });
    await adapter.connectServer("official-stdio", officialStdioConfig());

    await adapter.callTool({
      arguments: {},
      serverName: "official-stdio",
      toolName: "transcribe",
      trace: { sessionId: "session-1" as never, traceId: "trace-1" as never },
    });

    const meta = lastWireMeta();
    expect(meta?.[OFFICIAL_MCP_AUTH_META_KEY]).toMatchObject({ ok: true });
    expect(meta?.["com.zcode/request-context"]).toEqual({
      session_id: "session-1",
      trace_id: "trace-1",
    });
  });

  it("OMCP-S03: forwards the port failure reason instead of failing closed", async () => {
    // http 路径会 fail closed；stdio 下发 reason，因为插件拿不到头也不会去打官方端点，
    // 而 reason 是它区分"未登录"与"无套餐"的唯一依据（phase-2 spec §6.3）。
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: {
          resolveHeaders: vi.fn(async () => ({
            ok: false as const,
            reason: "official_auth_plan_required" as const,
          })),
        },
        resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
        trustedOrigins: { isTrusted: vi.fn(async () => ({ trusted: true })) },
      },
    });
    await adapter.connectServer("official-stdio", officialStdioConfig());

    const result = await adapter.callTool({
      arguments: {},
      serverName: "official-stdio",
      toolName: "transcribe",
    });

    // 调用本身仍然发出：该 server 上还挂着大量与官方 MCP 无关的工具
    expect(result).toBeDefined();
    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      ok: false,
      reason: "official_auth_plan_required",
    });
  });

  it("OMCP-S04: refuses to resolve credentials when the origin is not trusted", async () => {
    const resolveHeaders = vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const }));
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: { resolveHeaders },
        resolveZCodeApiOrigin: () => "http://zcode.example",
        trustedOrigins: {
          isTrusted: vi.fn(async () => ({ detail: "origin must be https", trusted: false })),
        },
      },
    });
    await adapter.connectServer("official-stdio", officialStdioConfig());

    await adapter.callTool({ arguments: {}, serverName: "official-stdio", toolName: "transcribe" });

    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      ok: false,
      reason: "official_mcp_origin_untrusted",
    });
    // fail closed 的含义在这里是"凭据零读取"，而不是"不下发键"
    expect(resolveHeaders).not.toHaveBeenCalled();
  });

  it("CR-02: maps a throwing origin resolver to official_auth_unavailable", async () => {
    // 失败分类是跨 adapter / host / UI 的契约（决定提示文案与是否重试）。origin 解析依赖
    // settings 与运行时环境，抛异常时若裸冒泡，插件收不到任何 reason，整条契约就断了。
    const resolveHeaders = vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const }));
    const isTrusted = vi.fn(async () => ({ trusted: true }));
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: { resolveHeaders },
        resolveZCodeApiOrigin: () => {
          throw new Error("settings unavailable");
        },
        trustedOrigins: { isTrusted },
      },
    });
    await adapter.connectServer("official-stdio", officialStdioConfig());

    await adapter.callTool({ arguments: {}, serverName: "official-stdio", toolName: "transcribe" });

    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    // 解析不出可信 origin 时凭据零读取，也不会去问信任注册表
    expect(isTrusted).not.toHaveBeenCalled();
    expect(resolveHeaders).not.toHaveBeenCalled();
  });

  it("CR-02: maps a throwing trust registry to official_auth_unavailable", async () => {
    const resolveHeaders = vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const }));
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: { resolveHeaders },
        resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
        trustedOrigins: {
          isTrusted: vi.fn(async () => {
            throw new Error("registry exploded");
          }),
        },
      },
    });
    await adapter.connectServer("official-stdio", officialStdioConfig());

    await adapter.callTool({ arguments: {}, serverName: "official-stdio", toolName: "transcribe" });

    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    expect(resolveHeaders).not.toHaveBeenCalled();
  });

  it("OMCP-S05: reports official_auth_unavailable when the runtime has no auth port", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("official-stdio", officialStdioConfig());

    await adapter.callTool({ arguments: {}, serverName: "official-stdio", toolName: "transcribe" });

    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
  });

  it("SG-02: does not mark stdio official tools as display-trusted", async () => {
    // 该标记的用途是"信任结果里的结构化标识"（额度耗尽 / 无套餐）。stdio 的结果由插件进程
    // 自己产出，可以任意伪造 {"error_code":"quota_exceeded"}，从而在输入框上方弹出误导提示。
    // 因此 stdio 即使声明了官方鉴权也不置位——凭证注入照旧（上面几条用例），只是不给结果背书。
    clientListToolsMock.mockResolvedValueOnce({
      tools: [{ name: "transcribe", inputSchema: { properties: {}, type: "object" } }],
    });
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: {
          resolveHeaders: vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const })),
        },
        resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
        trustedOrigins: { isTrusted: vi.fn(async () => ({ trusted: true })) },
      },
    });
    await adapter.connectServer("official-stdio", officialStdioConfig());

    const tools = await adapter.listTools();
    expect(tools.map((tool) => tool.toolName)).toContain("transcribe");
    expect(tools[0]?.official).toBeUndefined();
  });

  it("OMCP-S06: never attaches the key for a server without official provenance", async () => {
    const resolveHeaders = vi.fn(async () => ({ headers: IDENTITY_HEADERS, ok: true as const }));
    const adapter = createMcpAdapter({
      officialMcpAuth: {
        authHeadersPort: { resolveHeaders },
        resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
        trustedOrigins: { isTrusted: vi.fn(async () => ({ trusted: true })) },
      },
    });
    // 只有 auth 字段、没有宿主生成的 provenance：不是 Plugin loader 的产出，一律不注入
    await adapter.connectServer("forged", {
      auth: { provider: "jwt_token", type: "zcode_official" },
      command: "python3",
      type: "stdio",
    });
    await adapter.connectServer("plain", { command: "node", type: "stdio" });

    await adapter.callTool({ arguments: {}, serverName: "forged", toolName: "x" });
    expect(lastWireMeta()?.[OFFICIAL_MCP_AUTH_META_KEY]).toBeUndefined();

    await adapter.callTool({ arguments: {}, serverName: "plain", toolName: "x" });
    expect(lastWireMeta()).toBeUndefined();
    expect(resolveHeaders).not.toHaveBeenCalled();
  });
});
