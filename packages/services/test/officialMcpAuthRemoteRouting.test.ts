/* OMCP-011 —— desktop-attached remote 的官方 MCP 身份头反向请求路由（spec §7.2 / §7.4）。
 *
 * 验证目标：
 *   1. 远端 workspace（workspaceIdentity 非空）发起的请求能被 host 自动解析并响应；
 *   2. 响应只回到**发起请求的那个** Agent client，不按 workspacePath 串到同路径的其它 workspace；
 *   3. 该请求不产生 renderer event（无 UI 语义），也不写入任何 session/runtime 状态；
 *   4. 无 resolver 时（如 standalone CLI）返回 official_auth_unavailable，绝不降级为匿名请求。
 *
 * 说明：凭证本身是 host 全局状态，不按 workspace 隔离（§7.1），因此这里断言的是**路由**与
 * **响应通道**，不是 per-workspace 的不同凭证。
 */
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";

const LOCAL_WORKSPACE = {
  workspaceKey: "/workspace/app",
  workspacePath: "/workspace/app",
};
const REMOTE_WORKSPACE = {
  workspaceIdentity: "remote:wsl:ubuntu:/workspace/app",
  workspaceKey: "remote:wsl:ubuntu:/workspace/app",
  // 与 LOCAL 同路径：若实现按 workspacePath 路由就会串台，这正是本用例要挡住的
  workspacePath: "/workspace/app",
};

interface FakeClient {
  onRequestListener?: (request: unknown) => void;
  respond: ReturnType<typeof vi.fn>;
  respondError: ReturnType<typeof vi.fn>;
}

/** 按 workspaceKey 分池的假 client，模拟 local host 与 desktop-attached remote host 两条链路。 */
async function createServiceWithClients(options: {
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(
      request?: unknown,
    ): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /** 缺省为"全部可信"，以便既有路由用例聚焦响应通道。 */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** 真正省略 validator（模拟装配遗漏）；`undefined` 会落回"全部可信"缺省，无法表达该场景。 */
  omitTrustedOrigins?: boolean;
}): Promise<{
  clients: Map<string, FakeClient>;
  dispose: () => Promise<void>;
  initializeWorkspace: (workspace: {
    workspaceIdentity?: string;
    workspacePath: string;
  }) => Promise<void>;
}> {
  const clients = new Map<string, FakeClient>();

  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      async getClient(params: { workspaceIdentity?: string; workspacePath: string }) {
        const key = params.workspaceIdentity ?? params.workspacePath;
        const existing = clients.get(key);
        if (existing) return toProtocolClient(existing);
        const record: FakeClient = {
          respond: vi.fn(async () => {}),
          respondError: vi.fn(async () => {}),
        };
        clients.set(key, record);
        return toProtocolClient(record);
      }
      getExistingClient(params: { workspaceIdentity?: string; workspacePath: string }) {
        const record = clients.get(params.workspaceIdentity ?? params.workspacePath);
        return record ? toProtocolClient(record) : undefined;
      }
      getRuntimeIdentity() {
        return undefined;
      }
      markReady() {}
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      disposeWorkspace() {}
      disposeAll() {}
      async disposeAllAndWait() {}
    },
  }));

  function toProtocolClient(record: FakeClient) {
    return {
      onClose: () => ({ dispose() {} }),
      onNotification: () => ({ dispose() {} }),
      onRequest: (listener: (request: unknown) => void) => {
        record.onRequestListener = listener;
        return { dispose() {} };
      },
      request: async (method: string) => {
        if (method === zcodeProtocolMethods.initialize) {
          return {
            available: true,
            protocolName: "ZCode Protocol",
            protocolVersion: 1,
            workspaceKey: "/workspace/app",
          };
        }
        throw new Error(`Unexpected request method: ${method}`);
      },
      respond: record.respond,
      respondError: record.respondError,
      transportKind: "stdio",
    };
  }

  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    // initialize 会先确认当前模型选择 View 中存在可执行模型，否则以
    // provider_not_ready 提前返回、不建 client。
    modelSelectionReadinessSource: {
      async getView() {
        return {
          providers: [
            {
              providerId: "account:zai-start-plan",
              config: {
                kind: "account" as const,
                api: {
                  type: "anthropic-messages" as const,
                  baseUrl: "https://zcode.z.ai/api/v1/zcode-plan",
                },
                models: ["GLM-5.2"],
              },
              models: [{ modelId: "GLM-5.2", config: {} }],
            },
          ],
          revision: 1,
        };
      },
    },
    ...(options.officialMcpAuthHeadersResolver
      ? { officialMcpAuthHeadersResolver: options.officialMcpAuthHeadersResolver }
      : {}),
    ...(options.omitTrustedOrigins
      ? {}
      : {
          officialMcpTrustedOrigins: options.officialMcpTrustedOrigins ?? {
            isTrusted: async () => ({ trusted: true }),
          },
        }),
  });

  return {
    clients,
    dispose: () => service.disposeAllAndWait(),
    initializeWorkspace: async (workspace) => {
      const result = await service.initialize(workspace);
      if (!result.available) {
        throw new Error(`agent initialize failed: ${result.reason ?? "unknown"}`);
      }
    },
  };
}

function officialMcpAuthRequest(
  id: string,
  workspace: Record<string, string>,
): Record<string, unknown> {
  return {
    id,
    method: zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
    params: {
      mcpKey: "image-search",
      pluginId: "zcode-tools@zcode-plugins-official",
      requestId: `official-mcp-auth:${id}`,
      targetOrigin: "https://mcp.zcode.example",
      workspace,
    },
  };
}

describe("official mcp auth headers over desktop-attached remote", () => {
  it("OMCP-011: answers a remote agent on its own client, not the same-path local one", async () => {
    const headers = {
      Authorization: "Bearer remote-jwt",
      "Bigmodel-Target-Type": "PERSONAL",
      "X-Bigmodel-Authorization": "Bearer remote-maas-jwt",
    };
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ headers, ok: true }),
      },
    });

    try {
      await harness.initializeWorkspace(LOCAL_WORKSPACE);
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      // 同 workspacePath、不同 workspaceIdentity 必须是两个独立 client
      expect(harness.clients.size).toBe(2);

      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const local = harness.clients.get(LOCAL_WORKSPACE.workspacePath);
      expect(remote).toBeDefined();
      expect(local).toBeDefined();

      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", { headers, ok: true });
      // 关键：同路径的 local client 不能收到任何东西
      expect(local?.respond).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("keeps local and remote responses on separate channels under interleaved requests", async () => {
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({
          headers: { Authorization: "Bearer shared-jwt" },
          ok: true,
        }),
      },
    });

    try {
      await harness.initializeWorkspace(LOCAL_WORKSPACE);
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const local = harness.clients.get(LOCAL_WORKSPACE.workspacePath);

      local?.onRequestListener?.(officialMcpAuthRequest("local-1", LOCAL_WORKSPACE));
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      local?.onRequestListener?.(officialMcpAuthRequest("local-2", LOCAL_WORKSPACE));

      await vi.waitFor(() => {
        expect(local?.respond).toHaveBeenCalledTimes(2);
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // 每个响应都必须回到自己的 request id，不能交叉
      expect(local?.respond.mock.calls.map((call) => call[0])).toEqual(["local-1", "local-2"]);
      expect(remote?.respond.mock.calls.map((call) => call[0])).toEqual(["remote-1"]);
    } finally {
      await harness.dispose();
    }
  });

  it("propagates a plan-required refusal to the remote agent unchanged", async () => {
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ ok: false, reason: "official_auth_plan_required" }),
      },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_auth_plan_required",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("OMCP-009: reports official_auth_unavailable when no resolver is wired", async () => {
    const harness = await createServiceWithClients({});
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // 绝不降级为匿名：没有 resolver 就明确不可用
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_auth_unavailable",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: rejects an untrusted origin without invoking the resolver at all", async () => {
    // host 是身份权威边界：Origin 不匹配时必须在**读取凭据之前**拒绝，
    // 否则 agent adapter 的 fetch wrapper 就成了唯一防线（远端 runtime 可绕过）。
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpTrustedOrigins: { isTrusted: async () => ({ trusted: false }) },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_mcp_origin_untrusted",
      });
      // 响应里不得出现任何 headers 字段
      const payload = remote?.respond.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload["headers"]).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("must-not-leak");
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: fails closed when no trusted-origin validator is injected", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      omitTrustedOrigins: true,
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: validates all three dimensions, not just one", async () => {
    // 逐维度只错一项，其余正确——防止实现只比较其中某一项。
    const seen: Array<{ mcpKey: string; origin: string; pluginId: string }> = [];
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ headers: { Authorization: "Bearer ok" }, ok: true }),
      },
      officialMcpTrustedOrigins: {
        isTrusted: async (input) => {
          seen.push(input);
          return {
            trusted:
              input.pluginId === "zcode-tools@zcode-plugins-official" &&
              input.mcpKey === "image-search" &&
              input.origin === "https://mcp.zcode.example",
          };
        },
      },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const variants: Array<{ id: string; overrides: Record<string, string> }> = [
        { id: "bad-plugin", overrides: { pluginId: "evil@third-party" } },
        { id: "bad-key", overrides: { mcpKey: "unregistered" } },
        { id: "bad-origin", overrides: { targetOrigin: "https://attacker.example" } },
      ];
      for (const variant of variants) {
        const base = officialMcpAuthRequest(variant.id, REMOTE_WORKSPACE);
        const params = base["params"] as Record<string, unknown>;
        remote?.onRequestListener?.({
          ...base,
          params: { ...params, ...variant.overrides },
        });
      }
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(3);
      });
      for (const call of remote?.respond.mock.calls ?? []) {
        expect(call[1]).toEqual({ ok: false, reason: "official_mcp_origin_untrusted" });
      }
      // validator 三个字段都收全了。origin 是唯一的判定依据，pluginId / mcpKey 只用于日志
      // 与凭证解析归属，但仍必须完整传到 host——否则日志答不出"是哪个插件在要凭证"。
      expect(seen).toHaveLength(3);
      expect(seen.every((input) => input.pluginId && input.mcpKey && input.origin)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: forwards the request context to the resolver once trusted", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer ok" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(resolveHeaders).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpKey: "image-search",
          pluginId: "zcode-tools@zcode-plugins-official",
          targetOrigin: "https://mcp.zcode.example",
          workspace: expect.objectContaining({
            workspaceIdentity: REMOTE_WORKSPACE.workspaceIdentity,
          }),
        }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it("rejects malformed params without invoking the resolver", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer jwt" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.({
        id: "remote-bad",
        method: zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
        // 走私凭证字段 + 缺 targetOrigin：strict schema 必须拒绝
        params: {
          jwt: "leaked",
          mcpKey: "image-search",
          pluginId: "zcode-tools@zcode-plugins-official",
          requestId: "official-mcp-auth:bad",
          workspace: REMOTE_WORKSPACE,
        },
      });

      await vi.waitFor(() => {
        expect(remote?.respondError).toHaveBeenCalledTimes(1);
      });
      // schema 失败走 respondError 而非 respond，且凭证解析不得被触发
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).not.toHaveBeenCalled();
      expect(remote?.respondError).toHaveBeenCalledWith(
        "remote-bad",
        expect.objectContaining({ code: -32602 }),
      );
    } finally {
      await harness.dispose();
    }
  });
});
