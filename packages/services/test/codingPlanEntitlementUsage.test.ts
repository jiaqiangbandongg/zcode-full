import { BUILTIN_MODEL_PROVIDER_IDS, type ApiClient } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { BigModelUsageQuotaProvider } from "../src/usage-stats/providers/bigmodelUsageQuotaProvider.js";

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
describe("订阅快照与额度/调用 Key 独立", () => {
  it.each(["zero", "missing", "throw"])(
    "个人混合订阅列表 quota=%s 不撤销有效订阅",
    async (quota) => {
      const request = vi.fn(async (url: string) => {
        if (url.includes("subscription/list"))
          return json([
            {},
            { productName: "Storage" },
            {
              productId: "coding-lite",
              productName: "GLM Coding Lite",
              status: "VALID",
              inCurrentPeriod: true,
            },
          ]);
        if (quota === "throw") throw new Error("network");
        return json(
          quota === "missing"
            ? null
            : { level: "lite", limits: [{ type: "TIME_LIMIT", remaining: 0 }] },
        );
      });
      const provider = new BigModelUsageQuotaProvider({
        apiClient: { request },
        env: { ZCODE_BIGMODEL_USAGE_API_KEY: "personal.secret" },
        accountRequestAuthService: {
          resolveAccessCurrent: vi.fn(),
          resolveCurrent: vi.fn(),
          assertCurrent: vi.fn(),
        },
      });
      const snapshot = await provider.getSnapshot();
      expect(snapshot.unavailableReason).toBeUndefined();
      expect(snapshot.subscription?.details[0]?.productId).toBe("coding-lite");
    },
  );
  it("quota 有 level 不能构造个人订阅", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (url) =>
        json(String(url).includes("subscription/list") ? [] : { level: "max", limits: [] }),
      ),
    };
    const provider = new BigModelUsageQuotaProvider({
      apiClient,
      env: { ZCODE_BIGMODEL_USAGE_API_KEY: "personal.secret" },
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(),
        resolveCurrent: vi.fn(),
        assertCurrent: vi.fn(),
      },
    });
    expect(await provider.getSnapshot()).toMatchObject({
      subscription: null,
      unavailableReason: "no_plan",
    });
  });
  it("团队 Key 不可用仍返回业务 token 查询的团队订阅，不查询个人订阅", async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://bigmodel.cn/api/biz/team/subscribe/product/querySubscribeDetail");
      expect(init?.headers).toEqual({
        Authorization: "business",
        "bigmodel-organization": "org",
        "bigmodel-project": "project",
      });
      return json({
        hasSubscription: true,
        status: "EFFECTIVE",
        memberGrantStatus: "VALID",
        productId: "team-max",
        productName: "团队套餐",
        subscribeEndTime: "2027-08-25",
      });
    });
    const assertCurrent = vi.fn();
    const provider = new BigModelUsageQuotaProvider({
      apiClient: { request },
      env: {},
      credentialService: { load: async () => "business" },
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(),
        resolveCurrent: vi.fn(async () => {
          throw new Error("key unavailable");
        }),
        assertCurrent,
      },
    });
    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      accountAccess: {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "team-coding-plan",
        organizationId: "org",
        projectId: "project",
        productId: "stale-pricing-id",
      },
    });
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.subscription?.details[0]).toMatchObject({
      productId: "team-max",
      expireTime: "2027-08-25",
    });
    expect(snapshot.quota).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["EXPIRED", "expired"],
    ["EFFECTIVE", "unassigned"],
  ] as const)("团队 %s 经快照保留明确失效原因", async (status, reason) => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://bigmodel.cn/api/biz/team/subscribe/product/querySubscribeDetail");
      expect(init?.headers).toEqual({
        Authorization: "business",
        "bigmodel-organization": "org",
        "bigmodel-project": "project",
      });
      return json({
        hasSubscription: true,
        status,
        memberGrantStatus: "UNASSIGNED",
        productId: "team-max",
        productName: "团队套餐",
        subscribeEndTime: "2027-08-25",
      });
    });
    const assertCurrent = vi.fn();
    const provider = new BigModelUsageQuotaProvider({
      apiClient: { request },
      env: {},
      credentialService: { load: async () => "business" },
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(),
        resolveCurrent: vi.fn(async () => {
          throw new Error("key unavailable");
        }),
        assertCurrent,
      },
    });
    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      accountAccess: {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "team-coding-plan",
        organizationId: "org",
        projectId: "project",
        productId: "stale-pricing-id",
      },
    });
    expect(snapshot.unavailableReason).toBe("no_plan");
    expect(snapshot).toHaveProperty("teamPlanUnavailableReason", reason);
    expect(snapshot.subscription).toBeNull();
    expect(snapshot.quota).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });
});
