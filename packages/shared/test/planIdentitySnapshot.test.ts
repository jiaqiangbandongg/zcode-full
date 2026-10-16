import { describe, expect, it } from "vitest";
import { resolvePlanIdentitySnapshot } from "../src/plan-identity.js";
import type { UsageEntitlementSnapshot } from "../src/usage-stats.js";

function createEntitlementSnapshot(
  overrides: Partial<UsageEntitlementSnapshot> = {},
): UsageEntitlementSnapshot {
  return {
    generatedAt: 1_000,
    authenticated: true,
    provider: { id: "provider-a", name: "Provider A" },
    remaining: { count: 1, isShow: true },
    subscription: {
      identityType: "unknown",
      identityMasked: null,
      details: [
        {
          productId: "product-a",
          productName: "Product A",
          purchaseTime: null,
          beginTime: null,
          expireTime: null,
        },
      ],
    },
    quota: { level: "pro", limits: [] },
    ...overrides,
  };
}

describe("resolvePlanIdentitySnapshot", () => {
  it("prefers Coding Plan over Start Plan in the active provider family domain", () => {
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "zai",
        codingPlanEntitlement: createEntitlementSnapshot({
          generatedAt: 1_100,
          subscription: {
            identityType: "unknown",
            identityMasked: null,
            details: [
              {
                productId: "coding-product",
                productName: "Coding Product",
                purchaseTime: null,
                beginTime: null,
                expireTime: null,
              },
            ],
          },
        }),
        startPlanEntitlement: createEntitlementSnapshot({
          generatedAt: 1_200,
          subscription: {
            identityType: "unknown",
            identityMasked: null,
            details: [
              {
                productId: "start-product",
                productName: "Start Product",
                purchaseTime: null,
                beginTime: null,
                expireTime: null,
              },
            ],
          },
        }),
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }),
    ).toEqual({
      generatedAt: 1_100,
      planStatus: "coding_plan",
      planProductId: "coding-product",
    });
  });

  it("uses Start Plan only after Coding Plan is confirmed absent", () => {
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "bigmodel",
        codingPlanEntitlement: createEntitlementSnapshot({
          unavailableReason: "no_plan",
          remaining: null,
          subscription: null,
          quota: null,
        }),
        startPlanEntitlement: createEntitlementSnapshot({
          subscription: {
            identityType: "unknown",
            identityMasked: null,
            details: [
              {
                productId: "start-plan-id",
                productName: "Start Product",
                purchaseTime: null,
                beginTime: null,
                expireTime: null,
              },
            ],
          },
        }),
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }),
    ).toMatchObject({
      planStatus: "start_plan",
      planProductId: "start-plan-id",
    });
  });

  it("uses the first active Start Plan in server order as plan_product_id and follows server reordering", () => {
    // 口径快照（供数据侧评审）：Start Plan subscription.details 现在是全部 active 套餐
    // 按服务端优先级排序；plan_product_id 固定取 details[0]。服务端调整排序或套餐
    // 增减时，该维度会跟随翻转——这是有意的口径，不是回归。
    const buildStartPlanDetails = (firstId: string, secondId: string) => ({
      identityType: "unknown" as const,
      identityMasked: null,
      details: [
        {
          productId: firstId,
          productName: "Start Priority One",
          purchaseTime: null,
          beginTime: null,
          expireTime: null,
        },
        {
          productId: secondId,
          productName: "Start Priority Two",
          purchaseTime: null,
          beginTime: null,
          expireTime: null,
        },
      ],
    });
    const noPlan = createEntitlementSnapshot({
      unavailableReason: "no_plan",
      remaining: null,
      subscription: null,
      quota: null,
    });

    const firstSnapshot = resolvePlanIdentitySnapshot({
      providerFamilyDomain: "zai",
      codingPlanEntitlement: noPlan,
      startPlanEntitlement: createEntitlementSnapshot({
        subscription: buildStartPlanDetails("start-first", "start-second"),
      }),
      now: 1_300,
      entitlementCacheTtlMs: 1_000,
    });
    expect(firstSnapshot).toMatchObject({
      planStatus: "start_plan",
      planProductId: "start-first",
    });

    const reorderedSnapshot = resolvePlanIdentitySnapshot({
      providerFamilyDomain: "zai",
      codingPlanEntitlement: noPlan,
      startPlanEntitlement: createEntitlementSnapshot({
        subscription: buildStartPlanDetails("start-second", "start-first"),
      }),
      now: 1_300,
      entitlementCacheTtlMs: 1_000,
    });
    expect(reorderedSnapshot).toMatchObject({
      planStatus: "start_plan",
      planProductId: "start-second",
    });
  });

  it("keeps Coding Plan active with an empty product id when quota is valid but subscription is missing", () => {
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "zai",
        codingPlanEntitlement: createEntitlementSnapshot({
          subscription: null,
        }),
        startPlanEntitlement: null,
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }),
    ).toMatchObject({
      planStatus: "coding_plan",
      planProductId: "",
    });
  });

  it("does not derive BigModel Team Plan product id from the selected local connection key", () => {
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "bigmodel",
        modelProviderFamilySelectedKeys: {
          bigmodel:
            "team-plan:account:bigmodel-individual-coding-plan:product-team:org-team:project-team",
        },
        codingPlanEntitlement: createEntitlementSnapshot({
          context: {
            scope: "personal",
            productId: "product-personal",
          },
          subscription: {
            identityType: "unknown",
            identityMasked: null,
            details: [
              {
                productId: "product-personal",
                productName: "Personal Coding Plan",
                purchaseTime: null,
                beginTime: null,
                expireTime: null,
              },
            ],
          },
        }),
        startPlanEntitlement: null,
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }),
    ).toEqual({
      generatedAt: 1_000,
      planStatus: "coding_plan",
      planProductId: "product-personal",
    });
  });

  it("returns no_plan only when Coding Plan and Start Plan are both explicitly absent", () => {
    const noPlan = createEntitlementSnapshot({
      unavailableReason: "no_plan",
      remaining: null,
      subscription: null,
      quota: null,
    });

    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "zai",
        codingPlanEntitlement: noPlan,
        startPlanEntitlement: noPlan,
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }),
    ).toMatchObject({
      planStatus: "no_plan",
      planProductId: "",
    });
  });

  it("treats loading, failures, missing domain and stale snapshots as unknown", () => {
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: null,
        codingPlanEntitlement: createEntitlementSnapshot(),
        startPlanEntitlement: createEntitlementSnapshot(),
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }).planStatus,
    ).toBe("unknown");
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "zai",
        codingPlanEntitlement: createEntitlementSnapshot({
          unavailableReason: "unavailable",
          remaining: null,
          subscription: null,
          quota: null,
        }),
        startPlanEntitlement: createEntitlementSnapshot(),
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }).planStatus,
    ).toBe("unknown");
    expect(
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: "zai",
        codingPlanEntitlement: createEntitlementSnapshot({
          generatedAt: 1,
        }),
        startPlanEntitlement: createEntitlementSnapshot(),
        now: 1_300,
        entitlementCacheTtlMs: 1_000,
      }).planStatus,
    ).toBe("unknown");
  });
});
