import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@zcode/shared";
import { resolveUsageEntitlementOutcome } from "@/lib/codingPlanProvider.js";
import { hasActiveCodingPlanSnapshot } from "@/CodingPlanUsageRemainingPanel.js";
import { resolveSidebarCodingPlanUpgradeProviderId } from "@/lib/sidebarCodingPlanUpgrade.js";
import { getUsageEntitlementScheduleState } from "@/lib/usageEntitlementRefreshPolicy.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";

const snapshot: UsageEntitlementSnapshot = {
  generatedAt: 1,
  authenticated: true,
  provider: null,
  subscription: null,
  remaining: { count: 100, isShow: true, nextResetTime: null },
  quota: { level: "max", limits: [] },
};
describe("所有入口使用订阅权益", () => {
  it("只有额度不能证明有权益", () => {
    expect(resolveUsageEntitlementOutcome(snapshot)).toBe("unknown");
    expect(getUsageEntitlementScheduleState(snapshot)).toBe("unknown");
    expect(
      hasActiveCodingPlanSnapshot({ ...snapshot, provider: { id: "p", name: "p" } }, "p"),
    ).toBe(false);
  });
  it("侧栏不能把 quota 当作可升级的已购套餐", () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    expect(
      resolveSidebarCodingPlanUpgradeProviderId({
        modelProvidersLoading: false,
        availableProviders: [
          {
            providerId,
            label: "BigModel",
            accountAccess: {
              type: "zhipu-account",
              family: "bigmodel",
              planKind: "individual-coding-plan",
            },
          },
        ],
        entitlements: [
          {
            providerId,
            loading: false,
            snapshot: { ...snapshot, provider: { id: providerId, name: "BigModel" } },
          },
        ],
      }),
    ).toBeUndefined();
  });
  it("明确无订阅不能被 quota 覆盖", () => {
    expect(resolveUsageEntitlementOutcome({ ...snapshot, unavailableReason: "no_plan" })).toBe(
      "inactive",
    );
  });
  it("订阅存在时不要求 quota 或 remaining", () => {
    expect(
      resolveUsageEntitlementOutcome({
        ...snapshot,
        quota: null,
        remaining: null,
        subscription: {
          identityType: "unknown",
          identityMasked: null,
          details: [
            {
              productId: "team",
              productName: "团队",
              purchaseTime: null,
              beginTime: null,
              renewTime: null,
              expireTime: null,
            },
          ],
        },
      }),
    ).toBe("active");
  });
  it("升级后缓存 key 不再命中旧版 quota 合成订阅", () => {
    expect(
      buildUsageEntitlementCacheKey({
        providerId: "provider",
        providerFingerprint: "account/project",
      }),
    ).toBe("zcode:usage-entitlement:subscription-v2:provider:account/project");
  });
});
