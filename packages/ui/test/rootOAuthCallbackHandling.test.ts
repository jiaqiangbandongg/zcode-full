import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  type EnterpriseCodingPlanPricingProduct,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";

const reportAppTelemetryEventMock = vi.fn(async () => {});
const resolveProviderTelemetryLabelMock = vi.fn((providerId: string) =>
  providerId === ZAI_PROVIDER_ID ? "z.ai" : "bigmodel",
);

vi.mock("@/lib/appTelemetry.js", () => ({
  reportAppTelemetryEvent: reportAppTelemetryEventMock,
  resolveProviderTelemetryLabel: resolveProviderTelemetryLabelMock,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("handleOAuthCallbackSuccess", () => {
  beforeEach(() => {
    reportAppTelemetryEventMock.mockClear();
    resolveProviderTelemetryLabelMock.mockClear();
  });

  it("应用登录回调会更新 user、清理错误并上报登录埋点", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => null);
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: BIGMODEL_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "bigmodel-user",
          displayName: "BigModel User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(setUser).toHaveBeenCalledWith({
      id: "user-1",
      username: "bigmodel-user",
      displayName: "BigModel User",
    });
    expect(setOAuthError).toHaveBeenCalledWith(null);
    expect(setProviderFamilyDomain).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshLatestModelProviderFamilySelection).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshProviderState).toHaveBeenCalledOnce();
    expect(reportAppTelemetryEventMock).toHaveBeenCalledTimes(1);
  });

  it("Provider Family 选择校正失败不应阻断 OAuth 登录成功态", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const setProviderFamilyDomain = vi.fn(async () => {});
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      throw new Error("selection failed");
    });
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await expect(
      handleOAuthCallbackSuccess({
        result: {
          kind: "session",
          provider: BIGMODEL_PROVIDER_ID,
          userInfo: {
            id: "user-1",
            username: "bigmodel-user",
            displayName: "BigModel User",
          },
        },
        platform,
        refreshLatestModelProviderFamilySelection,
        refreshProviderState,
        setProviderFamilyDomain,
        setUser,
        setOAuthError,
      }),
    ).resolves.toBeUndefined();

    expect(setUser).toHaveBeenCalledWith({
      id: "user-1",
      username: "bigmodel-user",
      displayName: "BigModel User",
    });
    expect(setOAuthError).toHaveBeenCalledWith(null);
    expect(setProviderFamilyDomain).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshLatestModelProviderFamilySelection).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshProviderState).toHaveBeenCalledOnce();
    expect(reportAppTelemetryEventMock).toHaveBeenCalledTimes(1);
  });

  it("Team Plan 选择收敛后统一刷新 Provider Runtime", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const events: string[] = [];
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {
      events.push("provider-state");
    });
    const refreshAppSettings = vi.fn(async () => {
      events.push("settings");
    });
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      events.push("selection");
      return {
        kind: "team-coding-plan" as const,
        productId: "product-team",
        organizationId: "org-1",
        projectId: "project-1",
      };
    });
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: BIGMODEL_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "bigmodel-user",
          displayName: "BigModel User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshAppSettings,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(events).toEqual(["selection", "settings", "provider-state"]);
  });

  it("个人 Coding Plan 选择收敛后统一刷新 Provider Runtime", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const events: string[] = [];
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {
      events.push("provider-state");
    });
    const refreshAppSettings = vi.fn(async () => {
      events.push("settings");
    });
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      events.push("selection");
      return { kind: "individual-coding-plan" as const };
    });
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: ZAI_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "zai-user",
          displayName: "Z.ai User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshAppSettings,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(events).toEqual(["selection", "settings", "provider-state"]);
  });

  it("Start Plan 选择收敛后统一刷新 Provider Runtime", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const events: string[] = [];
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {
      events.push("provider-state");
    });
    const refreshAppSettings = vi.fn(async () => {
      events.push("settings");
    });
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      events.push("selection");
      return { kind: "start-plan" as const };
    });
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: ZAI_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "zai-user",
          displayName: "Z.ai User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshAppSettings,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(events).toEqual(["selection", "settings", "provider-state"]);
  });
});

const teamProduct = {
  productId: "product-team",
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

function createStartupRestoreServices(params: {
  events: string[];
  settings: {
    providerFamilyConnectionSelections: Record<string, unknown>;
  };
  codingPlanEntitlement?: UsageEntitlementSnapshot | null;
  startPlanEntitlement?: UsageEntitlementSnapshot | null;
  enterprisePricingError?: Error;
}) {
  const update = vi.fn(async (patch) => {
    params.events.push("update");
    Object.assign(params.settings, patch);
  });
  return {
    services: {
      settingService: {
        get: vi.fn(async () => params.settings),
        update,
      },
      providerSettingsService: {
        refresh: vi.fn(async () => ({
          revision: 1,
          providers: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
              enabled: true,
              effectiveConfig: {
                access: {
                  type: "zhipu-account",
                  accountType: "bigmodel",
                  mode: "individual-coding-plan",
                  entitled: true,
                },
              },
            },
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
              enabled: true,
              effectiveConfig: {
                access: {
                  type: "zhipu-account",
                  accountType: "bigmodel",
                  mode: "start-plan",
                  entitled: true,
                },
              },
            },
          ],
        })),
      },
      usageStatsService: {
        getEntitlementSnapshot: vi.fn(async ({ preferredProviderId }) => {
          if (preferredProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
            return params.codingPlanEntitlement ?? null;
          }
          if (preferredProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan) {
            return params.startPlanEntitlement ?? null;
          }
          return null;
        }),
      },
      codingPlanSubscriptionService: {
        getEnterprisePricing: vi.fn(async () => {
          if (params.enterprisePricingError) {
            throw params.enterprisePricingError;
          }
          return {
            productList: [teamProduct],
          };
        }),
      },
    },
    update,
  };
}

// zai family 版 startup restore services：modelProviders/entitlement mock 按 zai providerId 匹配，
describe("refreshRestoredOAuthProviderFamilyAfterStartup", () => {
  it("登录后的自动选择也以查询前的设置作条件写入，不能覆盖期间手动切换", async () => {
    const { refreshLatestModelProviderFamilySelectionAfterLogin } =
      await import("@/root/oauthProviderFamilySelectionRefresh.js");
    const initial = {
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
    };
    const { services, update } = createStartupRestoreServices({ events: [], settings: initial });
    const view = await services.providerSettingsService.refresh();
    services.settingService.get.mockResolvedValueOnce(structuredClone(initial));
    services.providerSettingsService.refresh.mockImplementation(async () => {
      services.settingService.get.mockResolvedValue({
        providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
      });
      return view;
    });
    await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: BIGMODEL_PROVIDER_ID,
      services: services as never,
    });
    expect(update).toHaveBeenCalledWith(expect.anything(), {
      providerFamilyDomain: undefined,
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
    });
  });
  it.each(["bigmodel", "zai"])(
    "%s 启动保留已保存的个人、Team、Start，不根据权益重新选择",
    async (family) => {
      const { refreshRestoredOAuthProviderFamilyAfterStartup } =
        await import("@/root/useRootOAuthEffects.js");
      for (const selection of [
        { kind: "individual-coding-plan" },
        { kind: "start-plan" },
        {
          kind: "team-coding-plan",
          productId: "product",
          organizationId: "org",
          projectId: "project",
        },
      ]) {
        const { services, update } = createStartupRestoreServices({
          events: [],
          settings: { providerFamilyConnectionSelections: { [family]: selection } },
          startPlanEntitlement: { checkedAt: 1, unavailableReason: "no_plan" },
          codingPlanEntitlement: { checkedAt: 1, unavailableReason: "no_plan" },
        });
        const result = await refreshRestoredOAuthProviderFamilyAfterStartup({
          activeProvider: family === "bigmodel" ? BIGMODEL_PROVIDER_ID : ZAI_PROVIDER_ID,
          services: services as never,
        });
        expect(result).toEqual(selection);
        expect(update).not.toHaveBeenCalled();
        expect(services.usageStatsService.getEntitlementSnapshot).not.toHaveBeenCalled();
        expect(services.codingPlanSubscriptionService.getEnterprisePricing).not.toHaveBeenCalled();
      }
    },
  );
  it("已保存连接在刷新失败时仍保留，启动不因网络失败中断", async () => {
    const { refreshRestoredOAuthProviderFamilyAfterStartup } =
      await import("@/root/useRootOAuthEffects.js");
    const { services, update } = createStartupRestoreServices({
      events: [],
      settings: { providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } } },
    });
    services.providerSettingsService.refresh.mockRejectedValue(new Error("offline"));
    expect(
      await refreshRestoredOAuthProviderFamilyAfterStartup({
        activeProvider: BIGMODEL_PROVIDER_ID,
        services: services as never,
      }),
    ).toEqual({ kind: "start-plan" });
    expect(update).not.toHaveBeenCalled();
  });
  it.each(["startup", "login"])(
    "%s 没有新连接但 Family 全部未知时不覆盖待迁移连接",
    async (entry) => {
      const { services, update } = createStartupRestoreServices({
        events: [],
        settings: { providerFamilyConnectionSelections: {} },
      });
      services.providerSettingsService.refresh.mockResolvedValue({
        providers: [
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        ].map((providerId) => ({
          providerId,
          accountState: { availability: "unknown", entitled: false, current: false },
        })),
      } as never);
      const module = await import("@/root/oauthProviderFamilySelectionRefresh.js");
      const result =
        entry === "startup"
          ? await module.refreshRestoredOAuthProviderFamilyAfterStartup({
              activeProvider: BIGMODEL_PROVIDER_ID,
              services: services as never,
            })
          : await module.refreshLatestModelProviderFamilySelectionAfterLogin({
              provider: BIGMODEL_PROVIDER_ID,
              services: services as never,
            });
      expect(result).toBeNull();
      expect(update).not.toHaveBeenCalled();
      expect(services.codingPlanSubscriptionService.getEnterprisePricing).not.toHaveBeenCalled();
    },
  );
  it("首次没有选择仍初始化，并按查询前的设置条件写入", async () => {
    const { refreshRestoredOAuthProviderFamilyAfterStartup } =
      await import("@/root/useRootOAuthEffects.js");
    const { services, update } = createStartupRestoreServices({
      events: [],
      settings: { providerFamilyConnectionSelections: {} },
    });
    const refreshAppSettings = vi.fn();
    expect(
      await refreshRestoredOAuthProviderFamilyAfterStartup({
        activeProvider: BIGMODEL_PROVIDER_ID,
        services: services as never,
        refreshAppSettings,
      }),
    ).toEqual({
      kind: "team-coding-plan",
      productId: "product-team",
      organizationId: "org-1",
      projectId: "project-1",
    });
    expect(update).toHaveBeenCalledWith(expect.anything(), {
      providerFamilyDomain: undefined,
      providerFamilyConnectionSelections: {},
    });
    expect(refreshAppSettings).toHaveBeenCalledOnce();
  });
});
