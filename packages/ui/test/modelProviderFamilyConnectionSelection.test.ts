import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type ProviderFamilyConnectionSelection,
  type EnterpriseCodingPlanPricingProduct,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import {
  resolveAutomaticModelProviderFamilyConnectionSelection,
  resolveModelProviderFamilyConnectionProviderId,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

function createEntitlementSnapshot(providerId: string): UsageEntitlementSnapshot {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: {
      id: providerId,
      name: providerId,
    },
    remaining: null,
    subscription: {
      identityType: "unknown",
      identityMasked: null,
      details: [
        {
          productId: "pro",
          productName: "GLM Coding Pro",
          purchaseTime: null,
          beginTime: null,
          expireTime: null,
        },
      ],
    },
    quota: null,
  };
}

describe("resolveAutomaticModelProviderFamilyConnectionSelection", () => {
  it.each([
    ["start-plan", BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan],
    ["individual-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan],
    ["team-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan],
  ] as const)("把 BigModel %s 连接映射到对应 Account Provider", (kind, providerId) => {
    const selection: ProviderFamilyConnectionSelection =
      kind === "team-coding-plan"
        ? {
            kind,
            productId: "team-pro",
            organizationId: "org-1",
            projectId: "project-1",
          }
        : { kind };
    expect(
      resolveModelProviderFamilyConnectionProviderId({
        providerFamilyDomain: "bigmodel",
        selection,
      }),
    ).toBe(providerId);
  });

  function resolveBigModelSelection(params: {
    hasStart: boolean;
    hasPersonal: boolean;
    teamProducts?: EnterpriseCodingPlanPricingProduct[];
  }) {
    return resolveAutomaticModelProviderFamilyConnectionSelection({
      providerFamilyDomain: "bigmodel",
      codingPlanEntitlement: params.hasPersonal
        ? createEntitlementSnapshot(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan)
        : null,
      startPlanEntitlement: params.hasStart
        ? createEntitlementSnapshot(BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan)
        : null,
      teamProducts: params.teamProducts ?? [],
    });
  }

  const subscribedTeamProduct = {
    productId: "team-pro",
    tier: "PRO",
    subscribeMode: "CONTINUOUS",
    subscribePeriod: "MONTHLY",
    subscribed: true,
    teamProjects: [
      {
        organizationId: "org-1",
        projectId: "project-1",
      },
    ],
  } satisfies EnterpriseCodingPlanPricingProduct;

  it.each([
    {
      name: "有 Start、有个人、有团队时选个人 Coding",
      hasStart: true,
      hasPersonal: true,
      teamProducts: [subscribedTeamProduct],
      expectedSelection: { kind: "individual-coding-plan" },
    },
    {
      name: "有 Start、有个人、无团队时选个人 Coding",
      hasStart: true,
      hasPersonal: true,
      teamProducts: [],
      expectedSelection: { kind: "individual-coding-plan" },
    },
    {
      name: "有 Start、无个人、有团队时选团队 Coding",
      hasStart: true,
      hasPersonal: false,
      teamProducts: [subscribedTeamProduct],
      expectedSelection: {
        kind: "team-coding-plan",
        productId: "team-pro",
        organizationId: "org-1",
        projectId: "project-1",
      },
    },
    {
      name: "只有 Start 时保留独立 Start，付费连接落到个人购买入口",
      hasStart: true,
      hasPersonal: false,
      teamProducts: [],
      expectedSelection: { kind: "individual-coding-plan" },
    },
    {
      name: "无 Start、有个人、有团队时选个人 Coding",
      hasStart: false,
      hasPersonal: true,
      teamProducts: [subscribedTeamProduct],
      expectedSelection: { kind: "individual-coding-plan" },
    },
    {
      name: "无 Start、有个人、无团队时选个人 Coding",
      hasStart: false,
      hasPersonal: true,
      teamProducts: [],
      expectedSelection: { kind: "individual-coding-plan" },
    },
    {
      name: "无 Start、无个人、有团队时选团队 Coding",
      hasStart: false,
      hasPersonal: false,
      teamProducts: [subscribedTeamProduct],
      expectedSelection: {
        kind: "team-coding-plan",
        productId: "team-pro",
        organizationId: "org-1",
        projectId: "project-1",
      },
    },
    {
      name: "无 Start、无个人、无团队时兜底个人 Coding",
      hasStart: false,
      hasPersonal: false,
      teamProducts: [],
      expectedSelection: { kind: "individual-coding-plan" },
    },
  ] satisfies Array<{
    name: string;
    hasStart: boolean;
    hasPersonal: boolean;
    teamProducts: EnterpriseCodingPlanPricingProduct[];
    expectedSelection: ProviderFamilyConnectionSelection;
  }>)("$name", ({ hasStart, hasPersonal, teamProducts, expectedSelection }) => {
    expect(resolveBigModelSelection({ hasStart, hasPersonal, teamProducts })).toEqual(
      expectedSelection,
    );
  });

  it("多个团队时选择后端返回顺序里的第一个已订阅团队项目", () => {
    const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
      providerFamilyDomain: "bigmodel",
      codingPlanEntitlement: null,
      startPlanEntitlement: null,
      teamProducts: [
        {
          productId: "team-a",
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "MONTHLY",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-a",
              projectId: "project-a",
            },
            {
              organizationId: "org-a",
              projectId: "project-a-2",
            },
          ],
        } satisfies EnterpriseCodingPlanPricingProduct,
        {
          productId: "team-b",
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "MONTHLY",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-b",
              projectId: "project-b",
            },
          ],
        } satisfies EnterpriseCodingPlanPricingProduct,
      ],
    });

    expect(selection).toEqual({
      kind: "team-coding-plan",
      productId: "team-a",
      organizationId: "org-a",
      projectId: "project-a",
    });
  });

  it("自动选择 Team Plan 时跳过 key 不可用的团队项目", () => {
    const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
      providerFamilyDomain: "bigmodel",
      codingPlanEntitlement: null,
      startPlanEntitlement: null,
      teamProducts: [
        {
          productId: "team-a",
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "MONTHLY",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-a",
              projectId: "project-a",
              apiKeyStatus: "unavailable",
            },
            {
              organizationId: "org-a",
              projectId: "project-a-2",
              apiKeyStatus: "available",
            },
          ],
        } satisfies EnterpriseCodingPlanPricingProduct,
      ],
    });

    expect(selection).toEqual({
      kind: "team-coding-plan",
      productId: "team-a",
      organizationId: "org-a",
      projectId: "project-a-2",
    });
  });

  it("团队项目未返回时不选 Team Plan，避免缺少团队身份边界", () => {
    const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
      providerFamilyDomain: "bigmodel",
      codingPlanEntitlement: null,
      startPlanEntitlement: null,
      teamProducts: [
        {
          productId: "team-pro",
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "MONTHLY",
          subscribed: true,
          teamProjects: [],
        } satisfies EnterpriseCodingPlanPricingProduct,
      ],
    });

    expect(selection).toEqual({
      kind: "individual-coding-plan",
    });
  });
});
