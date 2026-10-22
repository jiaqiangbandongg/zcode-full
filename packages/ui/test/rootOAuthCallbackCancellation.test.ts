import { describe, expect, it, vi } from "vitest";

const { effects, errorLog } = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  errorLog: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => unknown) => effects.push(effect),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@/hooks/useAlertDialog.js", () => ({ useAlertDialog: () => vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "登录失败" } }),
}));
vi.mock("@/root/useAccountConnectionLossNotification.js", () => ({
  useAccountConnectionLossNotification: vi.fn(),
}));
vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: errorLog },
}));
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";

describe("失效 OAuth 回调", () => {
  it.each([true, false])("pollingActive=%s 时静默忽略取消结果", async (oauthPollingActive) => {
    effects.length = 0;
    errorLog.mockClear();
    let callback!: (url: string) => Promise<void>;
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const markOAuthSuccess = vi.fn();
    const setOAuthPollingActive = vi.fn();
    useRootOAuthEffects({
      accountIntentKey: "test",
      platform: {
        notifyRendererReady: vi.fn(),
        onOAuthCallback: (handler: typeof callback) => {
          callback = handler;
          return vi.fn();
        },
      } as never,
      services: {
        oauthService: { handleCallback: vi.fn(async () => null) },
        broadcastService: {},
      } as never,
      refreshProviderState: vi.fn(async () => {}),
      setUser,
      setIsRestoringOAuthSession: vi.fn(),
      setOAuthError,
      oauthPollingActive,
      setOAuthPollingActive,
      markOAuthSuccess,
      onReauthenticationRequired: vi.fn(),
    });
    // 只挂载回调订阅；启动恢复和轮询在各自测试中验证。
    effects.at(-1)!();
    await callback("zcode://oauth/callback?state=cancelled");
    expect(errorLog).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    expect(setOAuthError).not.toHaveBeenCalled();
    expect(markOAuthSuccess).not.toHaveBeenCalled();
    expect(setOAuthPollingActive).not.toHaveBeenCalled();
  });
});

describe("OAuth 成功后的真实设置 CAS", () => {
  it.each(["polling", "deep-link"] as const)("%s 保留并发连接并完成成功收尾", async (mode) => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createSettingService } = await import("@zcode/services/node");
    const root = await mkdtemp(join(tmpdir(), "oauth-cas-"));
    const previousHome = process.env.ZCODE_DESKTOP_HOME_DIR;
    process.env.ZCODE_DESKTOP_HOME_DIR = root;
    const setting = createSettingService();
    if (previousHome === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previousHome;
    effects.length = 0;
    let poll!: () => void;
    let callback!: (url: string) => Promise<void>;
    const previousWindow = globalThis.window;
    vi.stubGlobal("window", {
      setInterval: (fn: () => void) => {
        poll = fn;
        return 1;
      },
      clearInterval: vi.fn(),
    });
    let injected = false;
    let concurrentVersion = 0;
    const newer = {
      kind: "team-coding-plan" as const,
      productId: "p",
      organizationId: "o",
      projectId: "j",
    };
    const result = {
      kind: "session",
      provider: "bigmodel",
      userInfo: { id: "user", username: "user" },
    };
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const markOAuthSuccess = vi.fn();
    const providerRefresh = vi.fn(async () => ({
      providers: [
        {
          providerId: "account:bigmodel-individual-coding-plan",
          accountState: { availability: "available", entitled: true, current: false },
        },
      ],
    }));
    const refreshProviderState = vi.fn(async () => {
      await providerRefresh();
    });
    const refreshAppSettings = vi.fn(async () => {
      await setting.get();
    });
    const admission = vi.fn();
    try {
      useRootOAuthEffects({
        accountIntentKey: "test",
        oauthPollingActive: mode === "polling",
        platform: {
          notifyRendererReady: vi.fn(),
          reportTelemetryEvent: vi.fn(async () => {}),
          onOAuthCallback: (fn: typeof callback) => {
            callback = fn;
            return vi.fn();
          },
        } as never,
        services: {
          oauthService: {
            pollPendingOAuth: async () => result,
            handleCallback: async () => result,
          },
          settingService: {
            get: () => setting.get(),
            update: async (patch: any, expected: any) => {
              admission(patch);
              if (!injected) {
                injected = true;
                const current = await setting.get();
                await setting.update(
                  {
                    providerFamilyConnectionSelections: {
                      ...current.providerFamilyConnectionSelections,
                      bigmodel: newer,
                    },
                  },
                  {
                    providerFamilyDomain: current.providerFamilyDomain,
                    providerFamilyConnectionSelections: current.providerFamilyConnectionSelections,
                    providerFamilyDomainUpdatedAt: current.providerFamilyDomainUpdatedAt ?? 0,
                  },
                );
                concurrentVersion = (await setting.get()).providerFamilyDomainUpdatedAt ?? 0;
              }
              return setting.update(patch, expected);
            },
          },
          providerSettingsService: { refresh: providerRefresh },
          usageStatsService: { getEntitlementSnapshot: async () => null },
          codingPlanSubscriptionService: {
            getEnterprisePricing: async () => ({ productList: [] }),
          },
          broadcastService: {},
        } as never,
        refreshProviderState,
        refreshAppSettings,
        setUser,
        setOAuthError,
        markOAuthSuccess,
        setIsRestoringOAuthSession: vi.fn(),
        setOAuthPollingActive: vi.fn(),
        onReauthenticationRequired: vi.fn(),
      });
      if (mode === "polling") {
        effects.at(-2)!();
        poll();
      } else {
        effects.at(-1)!();
        await callback("zcode://oauth/callback?state=test");
      }
      await vi.waitFor(() => expect(markOAuthSuccess).toHaveBeenCalledWith("bigmodel"));
      expect(setUser).toHaveBeenCalledWith(result.userInfo);
      expect(setOAuthError).toHaveBeenCalledExactlyOnceWith(null);
      expect(refreshProviderState).toHaveBeenCalledOnce();
      expect((await setting.get()).providerFamilyConnectionSelections?.bigmodel).toEqual(newer);
      expect((await setting.get()).providerFamilyDomainUpdatedAt).toBe(concurrentVersion);
      expect(admission).toHaveBeenCalledOnce();
      expect(providerRefresh).toHaveBeenCalledOnce();
      expect(refreshAppSettings).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal("window", previousWindow);
      await rm(root, { recursive: true, force: true });
    }
  });
});
