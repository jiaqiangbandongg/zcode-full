// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceSidebarFooterUsageSummaryState } from "@/WorkspaceSidebarFooterUsageSummary.js";

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: null,
    loading: false,
    update: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const providerSettingsViewMock = vi.hoisted(() => ({
  current: null as ProviderSettingsView | null,
}));

const enterpriseProductsMock = vi.hoisted(() => ({
  calls: [] as Array<{ enabled: boolean; family: "bigmodel" | "zai" }>,
  loading: false,
}));

vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: providerSettingsViewMock.current
      ? { status: "ready", view: providerSettingsViewMock.current }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));

beforeEach(() => {
  enterpriseProductsMock.calls = [];
  enterpriseProductsMock.loading = false;
  providerSettingsViewMock.current = {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        enabled: true,
        executable: true,
        effectiveConfig: {
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "individual-coding-plan",
            entitled: true,
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://example.com",
          },
          label: "Z.ai - Coding Plan",
          builtinModelIds: [],
        },
        issues: [],
        models: [],
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        enabled: true,
        executable: true,
        effectiveConfig: {
          access: {
            type: "zhipu-account",
            accountType: "bigmodel",
            mode: "individual-coding-plan",
            entitled: true,
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://example.com",
          },
          label: "BigModel - Coding Plan",
          builtinModelIds: [],
        },
        issues: [],
        models: [],
      },
    ],
  };
});

vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: (request: { enabled: boolean; family: "bigmodel" | "zai" }) => {
    enterpriseProductsMock.calls.push(request);
    return { snapshot: null, loading: enterpriseProductsMock.loading };
  },
}));

describe("WorkspaceSidebarFooterUsageSummary entitlement 冷启动探测", () => {
  it("footer 挂载即触发个人 Coding Plan entitlement 的 access 刷新", async () => {
    const getEntitlementSnapshot = vi.fn(async (request: { preferredProviderId?: string }) =>
      createEntitlementSnapshot(request.preferredProviderId ?? "unknown"),
    );
    const wrapper = createServiceProviderWrapper(getEntitlementSnapshot);

    renderHook(() => useWorkspaceSidebarFooterUsageSummaryState({ enabled: true }), {
      wrapper,
    });

    // CR-02 回归：refreshOnMount: false 后 footer 是常驻入口，冷启动没有其它入口
    // 预热 entitlement，个人计划徽标一直缺失。footer 可见时必须主动 access 探测。
    await waitFor(() => {
      expect(getEntitlementSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(getEntitlementSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      }),
    );
    expect(getEntitlementSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    );
  });

  it("共享 1 分钟 access freshness window 内重复挂载不放大请求", async () => {
    const getEntitlementSnapshot = vi.fn(async (request: { preferredProviderId?: string }) =>
      createEntitlementSnapshot(request.preferredProviderId ?? "unknown"),
    );
    const wrapper = createServiceProviderWrapper(getEntitlementSnapshot);

    const first = renderHook(() => useWorkspaceSidebarFooterUsageSummaryState({ enabled: true }), {
      wrapper,
    });
    await waitFor(() => {
      expect(getEntitlementSnapshot).toHaveBeenCalledTimes(2);
    });
    first.unmount();

    // 同一服务实例上的第二次挂载（例如 sidebar 重挂载）受 access window 限制，
    // 不会对 zai/bigmodel 再各发一次 quota 请求。
    const second = renderHook(() => useWorkspaceSidebarFooterUsageSummaryState({ enabled: true }), {
      wrapper,
    });
    await waitFor(() => {
      expect(second.result.current.providerSourcesLoading).toBe(false);
    });
    expect(getEntitlementSnapshot).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("footer 未启用时不触发 entitlement 请求", () => {
    const getEntitlementSnapshot = vi.fn();
    const wrapper = createServiceProviderWrapper(getEntitlementSnapshot);

    renderHook(() => useWorkspaceSidebarFooterUsageSummaryState({ enabled: false }), {
      wrapper,
    });

    expect(getEntitlementSnapshot).not.toHaveBeenCalled();
  });

  it("Account Access 不存在时不从静态 Provider 或旧凭据猜测连接", () => {
    providerSettingsViewMock.current = {
      revision: 2,
      addableProviders: [],
      providerOrder: [],
      providers: [],
    };
    const getEntitlementSnapshot = vi.fn();
    const wrapper = createServiceProviderWrapper(getEntitlementSnapshot);

    renderHook(() => useWorkspaceSidebarFooterUsageSummaryState({ enabled: true }), {
      wrapper,
    });

    expect(getEntitlementSnapshot).not.toHaveBeenCalled();
  });

  it("只有团队权益时仍显示 Team 徽标，并启用团队产品查询", async () => {
    enterpriseProductsMock.loading = true;
    providerSettingsViewMock.current = {
      revision: 2,
      addableProviders: [],
      providerOrder: [],
      providers: [
        {
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
          enabled: true,
          executable: true,
          effectiveConfig: {
            access: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "team-coding-plan",
              entitled: true,
            },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com",
            },
            label: "BigModel Team",
            builtinModelIds: [],
          },
          issues: [],
          models: [],
        },
      ],
    };
    const wrapper = createServiceProviderWrapper(vi.fn());

    const { result } = renderHook(
      () => useWorkspaceSidebarFooterUsageSummaryState({ enabled: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.profilePlanBadge).toEqual({ audience: "team" });
    });
    expect(
      enterpriseProductsMock.calls.some(
        (request) => request.family === "bigmodel" && request.enabled,
      ),
    ).toBe(true);
  });
});

function createServiceProviderWrapper(getEntitlementSnapshot: ReturnType<typeof vi.fn>) {
  const services = {
    usageStatsService: { getEntitlementSnapshot },
  } as unknown as IServiceAccessor;
  return ({ children }: { children: ReactNode }) =>
    createElement(ServiceProvider, { services }, children);
}

function createEntitlementSnapshot(providerId: string): UsageEntitlementSnapshot {
  return {
    generatedAt: 1_786_800_000_000,
    authenticated: true,
    context: { scope: "personal" },
    provider: { id: providerId, name: "Coding Plan" },
    remaining: { count: 120, isShow: true, nextResetTime: null },
    subscription: null,
    quota: { level: "pro", limits: [] },
  };
}
