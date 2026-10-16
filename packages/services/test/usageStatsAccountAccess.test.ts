import { BUILTIN_MODEL_PROVIDER_IDS, type ApiClient } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";

describe("UsageStats account access", () => {
  it("按当前 Account 连接获取 Coding Plan 鉴权，不读取旧 Provider Service", async () => {
    const resolve = vi.fn(async () => ({ apiKey: "account-a-plan-key" }));
    const request = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (String(_input).includes("subscription/list")) {
        expect(init?.headers).toMatchObject({ Authorization: "account-a-plan-key" });
        return new Response(JSON.stringify({ code: 200, data: [] }));
      }
      expect(init?.headers).toMatchObject({
        authorization: "account-a-plan-key",
      });
      return new Response(JSON.stringify({ code: 200, data: { level: "pro", limits: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const service = createUsageStatsService({
      apiClient: { request } as ApiClient,
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(async () => null),
        resolveCurrent: resolve,
        assertCurrent: vi.fn(async () => undefined),
      },
      credentialService: { load: vi.fn(async () => null) },
      zcodeAgentService: {
        getAppUsageStats: vi.fn(),
      },
    });

    await expect(
      service.getEntitlementSnapshot({
        includeSubscription: false,
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "individual-coding-plan",
        },
        requirePreferredProvider: true,
        allowEnvApiKey: false,
      }),
    ).resolves.toMatchObject({ authenticated: true, quota: { level: "pro" } });
    expect(resolve).toHaveBeenCalledWith({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      accountAccess: {
        type: "zhipu-account",
        family: "zai",
        planKind: "individual-coding-plan",
      },
      reason: "usage",
    });
  });

  it("把 Registry 静态 mode 交给账号服务解析后再读取权益", async () => {
    const dynamicAccess = {
      type: "zhipu-account" as const,
      family: "bigmodel" as const,
      planKind: "team-coding-plan" as const,
      productId: "product-1",
      organizationId: "org-1",
      projectId: "project-1",
    };
    const resolveAccessCurrent = vi.fn(async () => dynamicAccess);
    const resolveCurrent = vi.fn(async () => ({ apiKey: "team-plan-key" }));
    const request = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (String(_input).includes("querySubscribeDetail")) {
        expect(init?.headers).toMatchObject({
          Authorization: "team-business-token",
          "bigmodel-organization": "org-1",
          "bigmodel-project": "project-1",
        });
        return new Response(JSON.stringify({ code: 200, data: { hasSubscription: false } }));
      }
      expect(init?.headers).toMatchObject({ authorization: "team-plan-key" });
      return new Response(JSON.stringify({ code: 200, data: { level: "team", limits: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const service = createUsageStatsService({
      apiClient: { request } as ApiClient,
      accountRequestAuthService: {
        resolveAccessCurrent,
        resolveCurrent,
        assertCurrent: vi.fn(async () => undefined),
      },
      credentialService: {
        load: vi.fn(async (key) =>
          key === "oauth:bigmodel:access_token" ? "team-business-token" : null,
        ),
      },
      zcodeAgentService: { getAppUsageStats: vi.fn() },
    });

    await expect(
      service.getEntitlementSnapshot({
        includeSubscription: false,
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        accountAccess: {
          type: "zhipu-account",
          family: "bigmodel",
          mode: "team-coding-plan",
        },
        requirePreferredProvider: true,
        allowEnvApiKey: false,
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      context: { scope: "team", organizationId: "org-1", projectId: "project-1" },
      quota: { level: "team" },
    });
    expect(resolveAccessCurrent).toHaveBeenCalledWith({
      type: "zhipu-account",
      family: "bigmodel",
      mode: "team-coding-plan",
    });
    expect(resolveCurrent).toHaveBeenCalledWith({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      accountAccess: dynamicAccess,
      reason: "usage",
    });
  });
});
