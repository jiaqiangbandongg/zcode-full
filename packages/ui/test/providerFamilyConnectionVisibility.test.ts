import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  ZAI_PROVIDER_ID,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { describe, expect, it } from "vitest";
import {
  buildVisibleFamilyConnectionItems,
  buildVisibleFamilyConnectionKeys,
  resolveCodingPlanEntitlementState,
} from "@/settings/model-provider-section/providerFamilyConnectionVisibility.js";
import {
  CODING_PLAN_PROVIDER_SPECS,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "@/settings/model-provider-section/constants.js";

type ProviderOverrides = Partial<ProviderSettingsFormProvider> & {
  id?: string;
  name?: string;
  apiKey?: string;
  models?: string[];
};

it("待生效套餐可查看订阅，不借 entitled 点亮执行资格", () => {
  const result = resolveCodingPlanEntitlementState({
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    accountEntitled: false,
    accountAvailability: "pending",
    modelProvidersLoading: false,
    entitlement: {
      loading: false,
      error: null,
      snapshot: {
        subscription: {
          details: [{ productId: "start", productName: "Start Plan", effectiveAt: 2000 }],
        },
      } as UsageEntitlementSnapshot,
    },
  });
  expect(result.status).toBe("purchased");
  expect(result.currentProductId).toBe("start");
});

it("已登录但服务端明确无个人订阅时显示未开通，而不是未连接", () => {
  const result = resolveCodingPlanEntitlementState({
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountEntitled: false,
    accountAvailability: "unavailable",
    accountUnavailableReason: "not-entitled",
    modelProvidersLoading: false,
  });
  expect(result.status).toBe("notPurchased");
});

it("凭据失效时显示获取失败，既不显示未连接也不显示未开通", () => {
  const result = resolveCodingPlanEntitlementState({
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountEntitled: false,
    accountAvailability: "unavailable",
    accountUnavailableReason: "credential-failed",
    modelProvidersLoading: false,
  });
  expect(result.status).toBe("unavailable");
});

it.each(["not-connected", "not-authenticated", undefined] as const)(
  "未连接 / 未登录 / 原因缺失时仍显示未连接（%s）",
  (accountUnavailableReason) => {
    const result = resolveCodingPlanEntitlementState({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      accountEntitled: false,
      accountAvailability: "unavailable",
      accountUnavailableReason,
      modelProvidersLoading: false,
    });
    expect(result.status).toBe("disconnected");
  },
);

it("原因未知时保持未连接，不把网络抖动当成未开通", () => {
  const result = resolveCodingPlanEntitlementState({
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountEntitled: false,
    accountAvailability: "unknown",
    accountUnavailableReason: "not-entitled",
    modelProvidersLoading: false,
  });
  expect(result.status).toBe("disconnected");
});

it.each([
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
] as const)("Start Plan 的明确无权益显示暂无套餐（%s）", (providerId) => {
  const result = resolveCodingPlanEntitlementState({
    providerId,
    accountEntitled: false,
    accountAvailability: "unavailable",
    accountUnavailableReason: "not-entitled",
    modelProvidersLoading: false,
  });
  expect(result.status).toBe("notPurchased");
});

it("Z.AI 个人套餐与服务端无权益判定对称", () => {
  const result = resolveCodingPlanEntitlementState({
    providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountEntitled: false,
    accountAvailability: "unavailable",
    accountUnavailableReason: "not-entitled",
    modelProvidersLoading: false,
  });
  expect(result.status).toBe("notPurchased");
});

function createProvider(overrides: ProviderOverrides): ProviderSettingsFormProvider {
  const providerId =
    overrides.providerId ?? overrides.id ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  const modelIds = overrides.models ?? ["glm-5"];
  return {
    providerId,
    executable: overrides.executable ?? true,
    enabled: overrides.enabled ?? true,
    hasPersonalConfig: false,
    personalConfig: {},
    config: {
      label: overrides.name ?? "BigModel",
      access: { type: "api-key", apiKey: overrides.apiKey ?? "sk-test" },
      api: { type: "anthropic-messages", baseUrl: "https://example.com" },
      builtinModelIds: modelIds,
      enabled: overrides.enabled ?? true,
      ...overrides.config,
    },
    models: modelIds.map((modelId) => ({
      kind: "candidate" as const,
      modelId,
      builtin: true,
      personalConfig: {},
      config: {},
      hasPersonalConfig: false,
      executable: true,
      selectable: true,
    })),
  };
}

function createCodingPlanItem(
  status: "notPurchased" | "purchased",
): Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }> {
  return {
    key: `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}`,
    type: "codingPlan",
    presetId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel - Coding Plan",
    providerName: "BigModel",
    provider: createProvider({
      id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      name: "BigModel - Coding Plan",
    }),
    status,
    statusActive: status === "purchased",
    subscriptionRenewTime: "2026-09-15T00:00:00.000Z",
    subscriptionBillingCycle: "monthly",
  };
}

function createStartPlanItem(
  status: CodingPlanStatus,
): Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }> {
  return {
    ...createCodingPlanItem(status === "purchased" ? "purchased" : "notPurchased"),
    key: `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
    presetId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    label: "BigModel - Start Plan",
    provider: createProvider({
      id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      name: "BigModel - Start Plan",
    }),
    status,
    statusActive: status === "purchased",
  };
}

function createNoTeamQuotaEntitlementSnapshot(): UsageEntitlementSnapshot {
  return {
    generatedAt: 1,
    authenticated: true,
    context: {
      scope: "team",
      organizationId: "org-a",
      projectId: "project-a",
      productId: "product-team",
      displayName: "Org A",
    },
    provider: {
      id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      name: "BigModel - Coding Plan",
    },
    remaining: null,
    quota: null,
    subscription: null,
    unavailableReason: "no_plan",
  };
}

describe("buildVisibleFamilyConnectionKeys", () => {
  it("Start 与个人 Coding 同时有效时保留两个连接项", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased"), createStartPlanItem("purchased")],
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: false,
    });

    expect(items.map((item) => item.key)).toEqual([
      `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}`,
      `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
    ]);
  });

  it("Start 与 Team Plan 同时有效时仍保留 Start 连接项", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("notPurchased"), createStartPlanItem("purchased")],
      subscribedTeamProducts: [
        {
          productId: "team-pro",
          productName: "Team Pro",
          productBigTitle: "Team Pro",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "team-pro",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-a",
            organizationName: "Org A",
            projectId: "project-a",
            projectName: "Project A",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-a",
          organizationName: "Org A",
          projectId: "project-a",
          projectName: "Project A",
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    expect(items.map((item) => item.key)).toContain(
      `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
    );
    expect(items.some((item) => item.type === "teamPlan")).toBe(true);
  });

  it("已选 Start 临时不可用时保留入口，明确无权益时隐藏", () => {
    const selectedConnectionKey = `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`;
    const common = {
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: false,
      connectionSelections: { bigmodel: { kind: "start-plan" } } as const,
    };

    expect(
      buildVisibleFamilyConnectionItems({
        ...common,
        items: [createCodingPlanItem("purchased"), createStartPlanItem("unavailable")],
      }).map((item) => item.key),
    ).toContain(selectedConnectionKey);
    expect(
      buildVisibleFamilyConnectionItems({
        ...common,
        items: [createCodingPlanItem("purchased"), createStartPlanItem("notPurchased")],
      }).map((item) => item.key),
    ).not.toContain(selectedConnectionKey);
  });

  it("模型删空后仍按 API Key 和权益保持 Coding Plan 已购状态", () => {
    const provider = createProvider({
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      apiKey: "coding-plan-key",
      models: [],
    });

    expect(
      resolveCodingPlanEntitlementState({
        providerId: provider.providerId,
        accountEntitled: true,
        modelProvidersLoading: false,
        entitlement: {
          loading: false,
          error: null,
          snapshot: {
            generatedAt: 1,
            authenticated: true,
            provider: {
              id: provider.providerId,
              name: provider.config.label ?? provider.providerId,
            },
            remaining: null,
            quota: null,
            subscription: {
              identityType: "email",
              identityMasked: "u***@example.com",
              details: [
                {
                  productId: "coding-lite",
                  productName: "GLM Coding Lite",
                  purchaseTime: null,
                  beginTime: null,
                  expireTime: null,
                },
              ],
            },
          },
        },
      }).status,
    ).toBe("purchased");
  });

  it.each(["not_authenticated", "not_configured", "unavailable"] as const)(
    "账号已连接时 %s 权益快照不会被误报为未购买",
    (unavailableReason) => {
      expect(
        resolveCodingPlanEntitlementState({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          accountEntitled: true,
          modelProvidersLoading: false,
          entitlement: {
            loading: false,
            error: null,
            snapshot: {
              generatedAt: 1,
              authenticated: unavailableReason !== "not_authenticated",
              provider: null,
              remaining: null,
              quota: null,
              subscription: null,
              unavailableReason,
            },
          },
        }).status,
      ).toBe("unavailable");
    },
  );

  it("BigModel 个人套餐管理入口使用当前环境的个人套餐页", () => {
    const bigmodelSpecs = CODING_PLAN_PROVIDER_SPECS.filter(
      (item) =>
        item.id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
        item.id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    );

    expect(bigmodelSpecs.map((item) => item.purchaseUrl)).toEqual([
      "https://bigmodel.cn/coding-plan/personal/overview",
      "https://bigmodel.cn/coding-plan/personal/overview",
    ]);
  });

  it("输入框连接方式保留未购买 Coding Plan", () => {
    const keys = buildVisibleFamilyConnectionKeys({
      items: [createCodingPlanItem("notPurchased")],
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: false,
      modelProviders: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
          apiKey: "",
          models: ["glm-api-key"],
        }),
      ],
    });

    expect([...keys]).toEqual([
      `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}`,
    ]);
  });

  it("已购 Coding Plan 会进入输入框连接方式", () => {
    const keys = buildVisibleFamilyConnectionKeys({
      items: [createCodingPlanItem("purchased")],
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: false,
      modelProviders: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
          apiKey: "sk-api",
          models: ["glm-api-key"],
        }),
      ],
    });

    expect([...keys]).toEqual([
      `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}`,
    ]);
  });

  it("Team Plan 管理入口使用当前环境的团队套餐列表页", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [
        {
          ...createCodingPlanItem("purchased"),
          purchaseUrl: "https://bigmodel.cn/coding-plan/personal/overview",
        },
      ],
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "GLM Coding Team",
          productBigTitle: "GLM Coding Team",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "product-team",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-a",
            organizationName: "Org A",
            projectId: "project-a",
            projectName: "Project A",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-a",
          organizationName: "Org A",
          projectId: "project-a",
          projectName: "Project A",
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem?.purchaseUrl).toBe("https://bigmodel.cn/coding-plan/team/plans");
    expect(teamItem?.teamPlanName).toBe("Org A");
    expect(teamItem?.planLevel).toBe("Org A");
  });

  it("缺少组织名称时不生成空白 Team Plan 连接项", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "GLM Coding Team",
          productBigTitle: "GLM Coding Team",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "product-team",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-a",
            organizationName: null,
            projectId: "project-a",
            projectName: "Project A",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-a",
          organizationName: null,
          projectId: "project-a",
          projectName: "Project A",
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    expect(items.some((item) => item.type === "teamPlan")).toBe(false);
  });

  it("Team Plan 项目 key 不可用时保留连接项但标成不可用", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "GLM Coding Team",
          productBigTitle: "GLM Coding Team",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "product-team",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            teamProjects: [
              {
                organizationId: "org-a",
                organizationName: "Org A",
                projectId: "project-a",
                projectName: "Project A",
                apiKeyStatus: "unavailable",
                apiKeyUnavailableReason: "no_valid_team_plan_authorization",
              },
            ],
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-a",
              organizationName: "Org A",
              projectId: "project-a",
              projectName: "Project A",
              apiKeyStatus: "unavailable",
              apiKeyUnavailableReason: "no_valid_team_plan_authorization",
            },
          ],
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem).toMatchObject({
      key: `team:bigmodel:product-team:org-a:project-a`,
      status: "unavailable",
      statusActive: false,
      availabilityReason: "credential-unavailable",
      statusLabelId: undefined,
      inactivePlanTitle: "Org A",
      teamPlanName: "Org A",
    });
  });

  it("Team Plan quota 权益失败时不继承个人续费日期且不点亮", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      codingPlanEntitlements: {
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: {
          loading: false,
          error: null,
          snapshot: createNoTeamQuotaEntitlementSnapshot(),
          refresh: async () => {},
        },
      },
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "GLM Coding Team",
          productBigTitle: "GLM Coding Team",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "product-team",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            teamProjects: [
              {
                organizationId: "org-a",
                organizationName: "Org A",
                projectId: "project-a",
                projectName: "Project A",
                apiKeyStatus: "available",
              },
            ],
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-a",
              organizationName: "Org A",
              projectId: "project-a",
              projectName: "Project A",
              apiKeyStatus: "available",
            },
          ],
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem).toMatchObject({
      status: "unavailable",
      statusActive: false,
      statusLabelId: "settings.modelProvider.codingPlan.status.teamUnavailable",
    });
    expect(teamItem).toMatchObject({
      subscriptionRenewTime: null,
      subscriptionBillingCycle: null,
    });
  });

  it("Team Plan quota 仍在加载或请求报错时不提前标成未分配", () => {
    for (const entitlement of [
      { loading: true, error: null },
      { loading: false, error: new Error("network failed") },
    ]) {
      const items = buildVisibleFamilyConnectionItems({
        items: [createCodingPlanItem("purchased")],
        codingPlanEntitlements: {
          [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: {
            ...entitlement,
            snapshot: createNoTeamQuotaEntitlementSnapshot(),
            refresh: async () => {},
          },
        },
        subscribedTeamProducts: [
          {
            productId: "product-team",
            productName: "GLM Coding Team",
            productBigTitle: "GLM Coding Team",
            originalAmount: 598,
            payAmount: 598,
            priceUnit: "year",
            priceCurrency: "CNY",
            productEquityList: [],
            hasPreview: true,
            enterpriseProduct: {
              productId: "product-team",
              tier: "PRO",
              subscribeMode: "CONTINUOUS",
              subscribePeriod: "YEARLY",
              subscribed: true,
              teamProjects: [
                {
                  organizationId: "org-a",
                  organizationName: "Org A",
                  projectId: "project-a",
                  projectName: "Project A",
                  apiKeyStatus: "available",
                },
              ],
            },
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            purchaseMethodName: "yearly",
            subscribed: true,
            teamProjects: [
              {
                organizationId: "org-a",
                organizationName: "Org A",
                projectId: "project-a",
                projectName: "Project A",
                apiKeyStatus: "available",
              },
            ],
          },
        ],
        showPurchasedTeamPlanFallback: false,
      });

      const teamItem = items.find((item) => item.type === "teamPlan");
      expect(teamItem?.statusLabelId).not.toBe(
        "settings.modelProvider.codingPlan.status.teamUnavailable",
      );
    }
  });

  it("优先使用 entitlement snapshot 团队上下文生成 Team Plan 连接项", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      codingPlanEntitlements: {
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: {
          loading: false,
          error: null,
          snapshot: {
            generatedAt: 1,
            authenticated: true,
            context: {
              scope: "team",
              organizationId: "org-snapshot",
              projectId: "project-snapshot",
              productId: "product-snapshot",
              displayName: "Snapshot Team",
            },
            provider: {
              id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
              name: "BigModel - Coding Plan",
            },
            remaining: null,
            subscription: null,
            quota: null,
          },
        },
      },
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem?.key).toBe(`team:bigmodel:product-snapshot:org-snapshot:project-snapshot`);
    expect(teamItem?.teamPlanName).toBe("Snapshot Team");
    expect(teamItem?.organizationId).toBe("org-snapshot");
    expect(teamItem?.projectId).toBe("project-snapshot");
  });

  it("enterprise products 只校正 entitlement 生成的同项目 Team Plan 元数据", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      codingPlanEntitlements: {
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: {
          loading: false,
          error: null,
          snapshot: {
            generatedAt: 1,
            authenticated: true,
            context: {
              scope: "team",
              organizationId: "org-a",
              projectId: "project-a",
              productId: "product-old",
              displayName: "Snapshot Team",
            },
            provider: {
              id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
              name: "BigModel - Coding Plan",
            },
            remaining: null,
            subscription: null,
            quota: null,
          },
        },
      },
      subscribedTeamProducts: [
        {
          productId: "product-new",
          productName: "GLM Coding Team",
          productBigTitle: "GLM Coding Team",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "product-new",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-a",
            organizationName: "Org A",
            projectId: "project-a",
            projectName: "Corrected Project",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-a",
          organizationName: "Org A",
          projectId: "project-a",
          projectName: "Corrected Project",
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItems = items.filter((item) => item.type === "teamPlan");
    expect(teamItems).toHaveLength(1);
    expect(teamItems[0]?.key).toBe(`team:bigmodel:product-new:org-a:project-a`);
    expect(teamItems[0]?.teamPlanName).toBe("Org A");
  });

  it("enterprise pricing 未返回团队项目时按已保存 selected key 展示 Team Plan fallback", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: true,
      teamPlanSelections: {
        bigmodel: {
          kind: "team-coding-plan",
          productId: "product-saved",
          organizationId: "org-saved",
          projectId: "project-saved",
        },
      },
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem).toMatchObject({
      key: `team:bigmodel:product-saved:org-saved:project-saved`,
      organizationId: "org-saved",
      projectId: "project-saved",
      status: "purchased",
    });
  });
});

describe("zai family Team Plan 可见性对称化", () => {
  function createZaiCodingPlanItem(
    status: "notPurchased" | "purchased",
  ): Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }> {
    return {
      key: `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan}`,
      type: "codingPlan",
      presetId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      oauthProviderId: ZAI_PROVIDER_ID,
      label: "Z.ai - Coding Plan",
      providerName: "Z.ai",
      provider: createProvider({
        id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        name: "Z.ai - Coding Plan",
      }),
      status,
      statusActive: status === "purchased",
    };
  }

  it("zai family 的已订阅 Team Plan 会生成 zai 前缀连接项", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased"), createZaiCodingPlanItem("purchased")],
      subscribedTeamProducts: [
        {
          productId: "zai-team-pro",
          productName: "Z.ai Coding Team",
          productBigTitle: "Z.ai Coding Team",
          originalAmount: 216,
          payAmount: 216,
          priceUnit: "year",
          priceCurrency: "USD",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "zai-team-pro",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "zai-org",
            organizationName: "Zai Org",
            projectId: "zai-project",
            projectName: "Zai Project",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "zai-org",
          organizationName: "Zai Org",
          projectId: "zai-project",
          projectName: "Zai Project",
          // 关键：标记 family=zai，触发 zai codingPlanItem 派生 + zai key 前缀
          family: "zai",
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem).toBeDefined();
    // 关键：key 前缀必须是 zai-coding-plan，不能误用 bigmodel
    expect(teamItem?.key).toBe(`team:zai:zai-team-pro:zai-org:zai-project`);
    expect(teamItem?.key).not.toContain("bigmodel");
    // providerName 应继承自 zai codingPlanItem
    expect(teamItem?.providerName).toBe("Z.ai");
    expect(teamItem?.teamPlanName).toBe("Zai Org");
    expect(teamItem?.purchaseUrl).toBe(getModelProviderFamilySpec("zai").teamCodingPlanManageUrl);
  });

  it("未标记 family 的 product 仍走 bigmodel（向后兼容）", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased")],
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "GLM Coding Team",
          productBigTitle: "GLM Coding Team",
          originalAmount: 598,
          payAmount: 598,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "product-team",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-a",
            organizationName: "Org A",
            projectId: "project-a",
            projectName: "Project A",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-a",
          organizationName: "Org A",
          projectId: "project-a",
          projectName: "Project A",
          // 不标记 family
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    expect(teamItem?.key).toBe(`team:bigmodel:product-team:org-a:project-a`);
  });

  it("zai 和 bigmodel 同名团队不会互相覆盖（family 维度去重）", () => {
    const items = buildVisibleFamilyConnectionItems({
      items: [createCodingPlanItem("purchased"), createZaiCodingPlanItem("purchased")],
      subscribedTeamProducts: [
        {
          productId: "shared-product",
          productName: "Team",
          productBigTitle: "Team",
          originalAmount: 100,
          payAmount: 100,
          priceUnit: "year",
          priceCurrency: "CNY",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "shared-product",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-same",
            organizationName: "Same Org",
            projectId: "proj-same",
            projectName: "Same Project",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-same",
          organizationName: "Same Org",
          projectId: "proj-same",
          projectName: "Same Project",
          family: "bigmodel",
        },
        {
          productId: "shared-product",
          productName: "Team",
          productBigTitle: "Team",
          originalAmount: 100,
          payAmount: 100,
          priceUnit: "year",
          priceCurrency: "USD",
          productEquityList: [],
          hasPreview: true,
          enterpriseProduct: {
            productId: "shared-product",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "YEARLY",
            subscribed: true,
            organizationId: "org-same",
            organizationName: "Same Org",
            projectId: "proj-same",
            projectName: "Same Project",
          },
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "yearly",
          subscribed: true,
          organizationId: "org-same",
          organizationName: "Same Org",
          projectId: "proj-same",
          projectName: "Same Project",
          family: "zai",
        },
      ],
      showPurchasedTeamPlanFallback: false,
    });

    const teamItems = items.filter((item) => item.type === "teamPlan");
    // 关键：两个 family 各生成一个，不能因 productId+org+project 相同而互相覆盖
    expect(teamItems).toHaveLength(2);
    const keys = teamItems.map((item) => item.key);
    expect(keys).toContain(`team:bigmodel:shared-product:org-same:proj-same`);
    expect(keys).toContain(`team:zai:shared-product:org-same:proj-same`);
  });

  it("zai-only 视图（无 bigmodel codingPlan item）仍生成 zai Team Plan 连接项", () => {
    // 修复原因：appendSubscribedTeamPlanItems 原有 `if (!bigmodelCodingPlanItem) return items`
    // 前置守卫。当设置页 providerFamilyDomain === "zai" 时，传入的 codingPlanItems 只含 zai family，
    // 没有 bigmodelCodingPlan，守卫直接短路，zai teamPlan item 永远不生成，
    // 导致 pickFamilyModeNavigationItem 找不到 saved team item → selectedNavItem=null → Plan Card 永远 loading。
    const items = buildVisibleFamilyConnectionItems({
      // 关键：只有 zai codingPlan item，没有 bigmodel
      items: [createZaiCodingPlanItem("notPurchased")],
      subscribedTeamProducts: [],
      showPurchasedTeamPlanFallback: true,
      // 模拟已落盘的 zai team plan selectedKey（和 setting.json 里的格式一致）
      teamPlanSelections: {
        zai: {
          kind: "team-coding-plan",
          productId: "zai-pro",
          organizationId: "zai-org-1",
          projectId: "zai-proj-1",
        },
      },
    });

    const teamItem = items.find((item) => item.type === "teamPlan");
    // 关键：必须生成 zai teamPlan item，不能因为 bigmodelCodingPlanItem 不存在就整体短路
    expect(teamItem).toBeDefined();
    expect(teamItem?.key).toBe(`team:zai:zai-pro:zai-org-1:zai-proj-1`);
    expect(teamItem?.key).not.toContain("bigmodel");
  });
});

it("Start 查询未知不能显示未登录，查询失败可重试", () => {
  expect(
    resolveCodingPlanEntitlementState({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      accountEntitled: false,
      accountAvailability: "unknown",
      modelProvidersLoading: false,
    }).status,
  ).toBe("unavailable");
});
