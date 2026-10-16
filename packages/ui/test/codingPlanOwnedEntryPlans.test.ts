import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@zcode/shared";
import { buildOwnedEntryPlanList } from "@/lib/codingPlanOwnedEntryPlans.js";

function snapshot(
  id: string,
  productId: string,
  productName: string,
  expireTime: string | null = null,
): UsageEntitlementSnapshot {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: { id, name: id },
    remaining: null,
    quota: null,
    subscription: {
      identityType: "unknown",
      identityMasked: null,
      details: [{ productId, productName, purchaseTime: null, beginTime: null, expireTime }],
    },
  };
}

describe("all owned entry plans", () => {
  it("combines Start, personal and subscribed team plans across families without relying on the selected card", () => {
    const snapshots = [
      snapshot(BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan, "start-v3", "Start Plan"),
      snapshot(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        "lite-month",
        "GLM Coding Lite",
      ),
      snapshot(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, "lite-month", "GLM Coding Lite"),
    ];
    const teamProducts = [
      { subscribed: true, tier: "standard", productId: "enterprise-x" },
      { subscribed: false, tier: "advanced", productId: "enterprise-y" },
    ];
    const expected = "coding_plan__personal_lite,coding_plan__team_standard,start_plan__start_v3";
    expect(buildOwnedEntryPlanList({ snapshots, teamProducts })).toBe(expected);
    expect(buildOwnedEntryPlanList({ snapshots: [...snapshots].reverse(), teamProducts })).toBe(
      expected,
    );
  });
  it("excludes expired, unauthenticated, no-plan and non-plan sources", () => {
    const current = snapshot(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, "pro", "Pro");
    expect(
      buildOwnedEntryPlanList({
        snapshots: [
          snapshot(BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan, "expired", "Start", "2000-01-01"),
          { ...current, authenticated: false },
          { ...current, unavailableReason: "no_plan" },
          snapshot("custom-provider", "pro", "Pro"),
          null,
        ],
        teamProducts: [],
      }),
    ).toBe("");
  });
});
