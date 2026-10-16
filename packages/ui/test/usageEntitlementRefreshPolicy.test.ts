import type { IUsageStatsService } from "@zcode/services";
import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  getUsageEntitlementScheduleState,
  publishSharedEntitlementSnapshot,
  readSharedEntitlementSnapshot,
  recordSharedEntitlementAccess,
  recordSharedEntitlementFailure,
  shouldDeferSharedEntitlementRefresh,
  shouldDeferSharedEntitlementAccess,
  shouldUseSharedEntitlementSnapshot,
  USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
} from "@/lib/usageEntitlementRefreshPolicy.js";

function createUsageStatsService(): IUsageStatsService {
  return {
    getAppUsageSnapshot: async () => {
      throw new Error("unused");
    },
    getCodingPlanUsageSnapshot: async () => {
      throw new Error("unused");
    },
    getEntitlementSnapshot: async () => {
      throw new Error("unused");
    },
    getSnapshot: async () => {
      throw new Error("unused");
    },
  };
}

function createSnapshot(
  overrides: Partial<UsageEntitlementSnapshot> = {},
): UsageEntitlementSnapshot {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: { id: "account:zai-individual-coding-plan", name: "Z.ai Coding Plan" },
    remaining: null,
    subscription: null,
    quota: null,
    ...overrides,
  };
}

describe("usageEntitlementRefreshPolicy", () => {
  it("复用同服务和 freshness key 下的新鲜快照", () => {
    const usageStatsService = createUsageStatsService();
    const freshnessKey = "provider-a";
    const snapshot = createSnapshot({ generatedAt: 100 });

    publishSharedEntitlementSnapshot({
      usageStatsService,
      freshnessKey,
      snapshot,
    });

    expect(readSharedEntitlementSnapshot({ usageStatsService, freshnessKey })).toBe(snapshot);
    expect(
      shouldUseSharedEntitlementSnapshot({
        usageStatsService,
        freshnessKey,
        intervalMs: 60_000,
        now: Date.now(),
      }),
    ).toBe(snapshot);
  });

  it("没有旧快照时也会记录失败退避", () => {
    const usageStatsService = createUsageStatsService();
    const freshnessKey = "provider-b";

    recordSharedEntitlementFailure({ usageStatsService, freshnessKey });

    expect(
      shouldDeferSharedEntitlementRefresh({
        usageStatsService,
        freshnessKey,
        now: Date.now(),
      }),
    ).toBe(true);
  });

  it("访问请求失败或无快照时仍限制一分钟内重复请求", () => {
    const usageStatsService = createUsageStatsService();
    const freshnessKey = "provider-access";
    recordSharedEntitlementAccess({ usageStatsService, freshnessKey, now: 1_000 });

    expect(
      shouldDeferSharedEntitlementAccess({ usageStatsService, freshnessKey, now: 60_999 }),
    ).toBe(true);
    expect(
      shouldDeferSharedEntitlementAccess({ usageStatsService, freshnessKey, now: 61_000 }),
    ).toBe(false);
  });

  it("访问刷新统一使用一分钟 freshness window", () => {
    const active = createSnapshot({
      subscription: {
        identityType: "unknown",
        identityMasked: null,
        details: [{ productId: "coding-lite", productName: "Coding Lite" }],
      },
      remaining: {
        count: 10,
        isShow: true,
      },
    });
    const none = createSnapshot({ unavailableReason: "no_plan" });
    const unavailable = createSnapshot({ unavailableReason: "unavailable" });

    expect(getUsageEntitlementScheduleState(active)).toBe("active");
    expect(getUsageEntitlementScheduleState(none)).toBe("none");
    expect(getUsageEntitlementScheduleState(unavailable)).toBe("unavailable");
    expect(getUsageEntitlementScheduleState(null)).toBe("unknown");
    expect(USAGE_ENTITLEMENT_ACCESS_REFRESH_MS).toBe(60_000);
  });

  it("轮询 freshness window 内复用共享快照，过窗后允许重新请求", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const usageStatsService = createUsageStatsService();
      const freshnessKey = "provider-poll";
      const snapshot = createSnapshot({ generatedAt: 1_000 });

      publishSharedEntitlementSnapshot({
        usageStatsService,
        freshnessKey,
        snapshot,
      });

      expect(
        shouldUseSharedEntitlementSnapshot({
          usageStatsService,
          freshnessKey,
          intervalMs: USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
          now: 1_000 + USAGE_ENTITLEMENT_ACCESS_REFRESH_MS - 1,
        }),
      ).toBe(snapshot);
      expect(
        shouldUseSharedEntitlementSnapshot({
          usageStatsService,
          freshnessKey,
          intervalMs: USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
          now: 1_000 + USAGE_ENTITLEMENT_ACCESS_REFRESH_MS + 1,
        }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
