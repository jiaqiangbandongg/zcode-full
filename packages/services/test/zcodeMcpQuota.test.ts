import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  MCP_USAGE_QUOTA_LIMIT_TYPE,
  type ApiClient,
} from "@zcode/shared";
import { BigModelUsageQuotaProvider } from "../src/usage-stats/providers/bigmodelUsageQuotaProvider.js";
import {
  buildMcpQuotaAggregateLimit,
  fetchMcpQuotaSnapshot,
  matchesMcpQuotaScope,
  type OfficialMcpCredentialSource,
} from "../src/usage-stats/providers/zcodeMcpQuotaProvider.js";

const MCP_USAGE_PATH = "/api/v1/mcp/usage";
const QUOTA_LIMIT_PATH = "/api/monitor/usage/quota/limit";

function createJsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createPersonalBigModelCredentialSource(): OfficialMcpCredentialSource {
  return {
    resolve: vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        codingPlanAuthorization: "bigmodel-maas-jwt",
        jwt: "zcode-jwt",
        planScope: { targetType: "PERSONAL" as const },
        providerFamily: "bigmodel" as const,
        wireScope: { targetType: "PERSONAL" as const },
      },
    })),
  };
}

function createSuccessfulQuotaResponse(): unknown {
  return {
    code: 200,
    data: {
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 10,
          remaining: 90,
          nextResetTime: Date.UTC(2026, 7, 19, 8),
        },
      ],
    },
  };
}

function createMcpUsageResponse(): unknown {
  return {
    code: 0,
    msg: "",
    data: {
      server_time: 1_755_571_234,
      next_refresh_at: 1_755_609_600,
      level: "pro",
      total_usage: { used: 71, limit: 2000, remaining: 1929 },
    },
  };
}

/** 服务端 2026-08 之前的形状。留着它是为了锁住"接口再换形状时必须可查"这条。 */
function createLegacyBucketUsageResponse(): unknown {
  return {
    code: 0,
    msg: "",
    data: {
      server_time: 1_755_571_234,
      next_refresh_at: 1_755_609_600,
      level: "pro",
      buckets: [
        { bucket: "search_image", used: 5, limit: 230, remaining: 225 },
        { bucket: "video_edit", used: 0, limit: 200, remaining: 200 },
        { bucket: "finance", used: 33, limit: 800, remaining: 767 },
      ],
    },
  };
}

function createProvider(options: {
  apiClient: ApiClient;
  credentialSource?: OfficialMcpCredentialSource;
}): BigModelUsageQuotaProvider {
  const provider = new BigModelUsageQuotaProvider({
    apiClient: options.apiClient,
    accountRequestAuthService: {
      resolveAccessCurrent: vi.fn(async () => null),
      resolveCurrent: vi.fn(async () => ({ apiKey: "bigmodel-api-key" })),
      assertCurrent: vi.fn(async () => undefined),
    },
    ...(options.credentialSource ? { officialMcpCredentialSource: options.credentialSource } : {}),
  });
  const getSnapshotForRequest = provider.getSnapshotForRequest.bind(provider);
  provider.getSnapshotForRequest = (request = {}) =>
    getSnapshotForRequest({
      ...request,
      accountAccess: request.accountAccess ?? {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "individual-coding-plan",
      },
    });
  return provider;
}

describe("官方 Server MCP 额度汇总", () => {
  it("total_usage 直接映射成额度条，percentage 保持已使用占比口径", () => {
    const aggregate = buildMcpQuotaAggregateLimit({
      totalUsage: { used: 198, limit: 1230, remaining: 1032 },
      nextResetTime: 1_755_609_600_000,
    });

    // 剩余 1032 / 额度 1230 ≈ 83.9% 剩余 → 已使用 16.1%
    expect(aggregate).toMatchObject({
      type: MCP_USAGE_QUOTA_LIMIT_TYPE,
      remaining: 1032,
      usage: 198,
      currentValue: 198,
      nextResetTime: 1_755_609_600_000,
      usageDetails: [],
    });
    expect(aggregate?.percentage).toBeCloseTo(100 - (1032 / 1230) * 100, 6);
  });

  it("总额度为 0 时不产出额度条", () => {
    expect(
      buildMcpQuotaAggregateLimit({ totalUsage: { used: 0, limit: 0, remaining: 0 } }),
    ).toBeNull();
    expect(
      buildMcpQuotaAggregateLimit({ totalUsage: { used: 5, limit: -1, remaining: 0 } }),
    ).toBeNull();
  });

  it("异常的 remaining 被夹在 [0, limit] 内，不产生负的已使用占比", () => {
    const aggregate = buildMcpQuotaAggregateLimit({
      totalUsage: { used: 0, limit: 100, remaining: 150 },
    });

    expect(aggregate?.remaining).toBe(100);
    expect(aggregate?.percentage).toBe(0);
  });

  it("归属校验要求 family 与个人 / 团队 scope 完全一致", () => {
    const teamScope = {
      providerFamily: "bigmodel" as const,
      targetType: "TEAM" as const,
      organizationId: "org-1",
      projectId: "proj-1",
    };

    expect(
      matchesMcpQuotaScope(teamScope, {
        providerFamily: "bigmodel",
        organizationId: "org-1",
        projectId: "proj-1",
      }),
    ).toBe(true);
    // 同 family 但个人 / 团队不一致
    expect(matchesMcpQuotaScope(teamScope, { providerFamily: "bigmodel" })).toBe(false);
    // 团队不同项目
    expect(
      matchesMcpQuotaScope(teamScope, {
        providerFamily: "bigmodel",
        organizationId: "org-1",
        projectId: "proj-2",
      }),
    ).toBe(false);
    // 跨 family
    expect(
      matchesMcpQuotaScope(
        { providerFamily: "zai", targetType: "PERSONAL" },
        { providerFamily: "bigmodel" },
      ),
    ).toBe(false);
  });

  it("ZAI Team 使用产品 Team scope 匹配额度，不依赖 wire Target-Type", async () => {
    const requests: Array<{ url: string; headers: unknown }> = [];
    const result = await fetchMcpQuotaSnapshot({
      apiClient: {
        request: vi.fn(async (input, init) => {
          requests.push({ url: input.toString(), headers: init?.headers });
          return createJsonResponse(createMcpUsageResponse());
        }),
      },
      credentialSource: {
        resolve: vi.fn(async () => ({
          ok: true as const,
          snapshot: {
            codingPlanAuthorization: "zai-maas-jwt",
            jwt: "zcode-jwt",
            planScope: {
              organizationId: "org-z",
              projectId: "project-z",
              targetType: "TEAM" as const,
            },
            providerFamily: "zai" as const,
            // 与 Off-Peak 保持一致：wire 不发送 Team identity。
            wireScope: null,
          },
        })),
      },
      env: {} as NodeJS.ProcessEnv,
      requestScope: {
        organizationId: "org-z",
        projectId: "project-z",
        providerFamily: "zai",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).toEqual({
      Authorization: "Bearer zcode-jwt",
      "X-Bigmodel-Authorization": "Bearer zai-maas-jwt",
    });
    expect(result?.scope).toEqual({
      organizationId: "org-z",
      projectId: "project-z",
      providerFamily: "zai",
      targetType: "TEAM",
    });
  });
});

describe("entitlement 快照携带官方 Server MCP 额度", () => {
  it("成功时用 server MCP 的 5 个身份头请求，并把 total_usage 写进 mcpQuota", async () => {
    const mcpRequests: Array<{ url: string; headers: unknown }> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        if (url.includes(MCP_USAGE_PATH)) {
          mcpRequests.push({ url, headers: init?.headers });
          return createJsonResponse(createMcpUsageResponse());
        }
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({
      apiClient,
      credentialSource: createPersonalBigModelCredentialSource(),
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(mcpRequests).toHaveLength(1);
    // 身份头必须与 server MCP 调用完全一致：不改名、不补头、不换通道。
    expect(mcpRequests[0]?.headers).toEqual({
      Authorization: "Bearer zcode-jwt",
      "X-Bigmodel-Authorization": "Bearer bigmodel-maas-jwt",
      "Bigmodel-Target-Type": "PERSONAL",
    });
    expect(snapshot.mcpQuota).toMatchObject({
      level: "pro",
      scope: { providerFamily: "bigmodel", targetType: "PERSONAL" },
      // 接口是 Unix 秒，快照统一毫秒
      serverTime: 1_755_571_234_000,
    });
    expect(snapshot.mcpQuota?.aggregate).toMatchObject({
      nextResetTime: 1_755_609_600_000,
      remaining: 1929,
      usage: 71,
    });
    // 现有额度不受影响
    expect(snapshot.quota?.limits).toHaveLength(1);
  });

  it("只返回老的 buckets 形状时降级为 mcpQuota 为空，不抛错", async () => {
    // 这就是 2026-08 那次故障：服务端把 buckets 换成 total_usage，客户端 schema 校验失败，
    // 而 mcpQuota 是可选数据面（失败即静默降级），表现为额度条无声消失、其余额度照常。
    // 这条用例锁住"接口再换形状时只丢一行、不崩、且有日志可查"这个行为。
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes(MCP_USAGE_PATH)) {
          return createJsonResponse(createLegacyBucketUsageResponse(), {
            "x-request-id": "req-legacy",
          });
        }
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({
      apiClient,
      credentialSource: createPersonalBigModelCredentialSource(),
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.mcpQuota).toBeNull();
    // 其余 entitlement 一切照常——可选数据面绝不影响主快照
    expect(snapshot.quota?.level).toBe("pro");
    expect(snapshot.unavailableReason).toBeUndefined();
  });

  it("业务失败（code=1000 无 data）只清空 MCP 额度，其余 entitlement 字段照常", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes(MCP_USAGE_PATH)) {
          return createJsonResponse(
            { code: 1000, msg: "something went wrong" },
            { "x-request-id": "req-1" },
          );
        }
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({
      apiClient,
      credentialSource: createPersonalBigModelCredentialSource(),
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.mcpQuota).toBeNull();
    expect(snapshot.quota?.level).toBe("pro");
    expect(snapshot.unavailableReason).toBeUndefined();
  });

  it("HTTP 失败与请求异常都降级为 mcpQuota 为空，不影响 entitlement", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes(MCP_USAGE_PATH)) {
          return new Response("nope", { status: 500 });
        }
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({
      apiClient,
      credentialSource: createPersonalBigModelCredentialSource(),
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.mcpQuota).toBeNull();
    expect(snapshot.quota?.level).toBe("pro");
  });

  it("凭证解析判定无 Coding Plan 时零请求", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({
      apiClient,
      credentialSource: {
        resolve: vi.fn(async () => ({
          ok: false as const,
          reason: "official_auth_plan_required" as const,
        })),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.mcpQuota).toBeNull();
    expect(requestUrls.some((url) => url.includes(MCP_USAGE_PATH))).toBe(false);
  });

  it("凭证归属与本次查询的连接不一致时零请求", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({
      apiClient,
      credentialSource: {
        // 当前选中的是 Z.ai 连接，本次查询的是 BigModel 个人 Coding Plan。
        resolve: vi.fn(async () => ({
          ok: true as const,
          snapshot: {
            codingPlanAuthorization: "zai-maas-jwt",
            jwt: "zcode-jwt",
            planScope: { targetType: "PERSONAL" as const },
            providerFamily: "zai" as const,
            wireScope: { targetType: "PERSONAL" as const },
          },
        })),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.mcpQuota).toBeNull();
    expect(requestUrls.some((url) => url.includes(MCP_USAGE_PATH))).toBe(false);
  });

  it("未注入凭证来源时完全不查询 MCP 额度", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.includes(QUOTA_LIMIT_PATH)) {
          return createJsonResponse(createSuccessfulQuotaResponse());
        }
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "coding-pro",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ],
        });
      }),
    };
    const provider = createProvider({ apiClient });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.mcpQuota).toBeNull();
    expect(requestUrls.some((url) => url.includes(MCP_USAGE_PATH))).toBe(false);
  });
});
