// @vitest-environment jsdom

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "@zcode/services";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  resolveCodingPlanProviderFingerprintAutoRefresh,
  useCodingPlanAccessRefresh,
  useCodingPlanEntitlements,
} from "@/settings/model-provider-section/useCodingPlanEntitlements.js";

const { usageEntitlementCalls, usageEntitlementRefresh } = vi.hoisted(() => ({
  usageEntitlementCalls: [] as Array<Record<string, unknown>>,
  usageEntitlementRefresh: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlement: (options: Record<string, unknown>) => {
    usageEntitlementCalls.push(options);
    return {
      error: null,
      loading: false,
      refresh: usageEntitlementRefresh,
      snapshot: null,
    };
  },
}));

function HookProbe({
  connectionSelections,
  providerSettingsView,
}: {
  connectionSelections?: Parameters<typeof useCodingPlanEntitlements>[0]["connectionSelections"];
  providerSettingsView: ProviderSettingsView | null;
}) {
  useCodingPlanEntitlements({
    connectionSelections,
    providerSettingsView,
  });
  return null;
}

function createProviderSettingsView(
  providers: Array<{
    providerId: string;
    access?: Record<string, string | boolean>;
  }>,
): ProviderSettingsView {
  return {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: providers.map(({ access, providerId }) => ({
      providerId,
      enabled: true,
      executable: Boolean(access),
      effectiveConfig: {
        ...(access
          ? {
              access: {
                type: "zhipu-account" as const,
                entitled: true,
                ...access,
              },
            }
          : {}),
        api: {
          type: "anthropic-messages" as const,
          baseUrl: "https://example.com",
        },
        builtinModelIds: [],
      },
      issues: [],
      models: [],
    })),
  };
}

describe("useCodingPlanEntitlements", () => {
  it("等价 Family 权益事实重新渲染时保持返回引用稳定", () => {
    usageEntitlementCalls.length = 0;
    const providerSettingsView = createProviderSettingsView([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        access: {
          accountType: "bigmodel",
          mode: "team-coding-plan",
        },
      },
    ]);
    const initialSelection = {
      bigmodel: {
        kind: "team-coding-plan" as const,
        productId: "team-pro",
        organizationId: "org-a",
        projectId: "project-a",
      },
    };
    const hook = renderHook(
      ({ connectionSelections }) =>
        useCodingPlanEntitlements({ connectionSelections, providerSettingsView }),
      { initialProps: { connectionSelections: initialSelection } },
    );
    const firstResult = hook.result.current;

    hook.rerender({
      connectionSelections: {
        bigmodel: { ...initialSelection.bigmodel },
      },
    });

    expect(hook.result.current).toBe(firstResult);
  });

  it("BigModel Team Plan 选中时仍独立刷新 Start Plan entitlement", () => {
    usageEntitlementCalls.length = 0;
    renderToString(
      createElement(HookProbe, {
        connectionSelections: {
          bigmodel: {
            kind: "team-coding-plan",
            productId: "team-pro",
            organizationId: "org-a",
            projectId: "project-a",
          },
        },
        providerSettingsView: createProviderSettingsView([
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            access: {
              accountType: "bigmodel",
              mode: "team-coding-plan",
            },
          },
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
            access: {
              accountType: "bigmodel",
              mode: "start-plan",
            },
          },
        ]),
      }),
    );

    const bigmodelCall = usageEntitlementCalls.find(
      (call) => call.preferredProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    );
    expect(bigmodelCall).toMatchObject({
      allowDisabledPreferredProvider: true,
      enabled: true,
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      accountAccess: expect.objectContaining({
        organizationId: "org-a",
        projectId: "project-a",
      }),
      requirePreferredProvider: true,
      refreshOnMount: false,
    });
    expect(String(bigmodelCall?.cacheKey)).toContain("bigmodel-team");

    const bigmodelStartCall = usageEntitlementCalls.find(
      (call) => call.preferredProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    );
    expect(bigmodelStartCall?.enabled).toBe(true);
  });

  it("Account Provider 没有已启用连接时不把旧静态入口当作可查询连接", () => {
    usageEntitlementCalls.length = 0;

    renderToString(
      createElement(HookProbe, {
        providerSettingsView: createProviderSettingsView([
          { providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan },
          { providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan },
        ]),
      }),
    );

    const calls = usageEntitlementCalls.filter((call) =>
      [
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      ].includes(String(call.preferredProviderId)),
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.enabled === false)).toBe(true);
  });

  it("权益缓存身份跟随结构化 Account 连接而不是 Renderer 中的 API Key", () => {
    usageEntitlementCalls.length = 0;
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;

    renderToString(
      createElement(HookProbe, {
        providerSettingsView: createProviderSettingsView([
          {
            providerId,
            access: {
              accountType: "zai",
              mode: "individual-coding-plan",
            },
          },
        ]),
      }),
    );
    const firstCacheKey = usageEntitlementCalls.find(
      (call) => call.preferredProviderId === providerId,
    )?.cacheKey;

    usageEntitlementCalls.length = 0;
    renderToString(
      createElement(HookProbe, {
        connectionSelections: {
          zai: {
            kind: "team-coding-plan",
            productId: "team",
            organizationId: "org-a",
            projectId: "project-a",
          },
        },
        providerSettingsView: createProviderSettingsView([
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
            access: {
              accountType: "zai",
              mode: "team-coding-plan",
            },
          },
        ]),
      }),
    );
    const secondCacheKey = usageEntitlementCalls.find(
      (call) => call.preferredProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    )?.cacheKey;

    expect(firstCacheKey).not.toBe(secondCacheKey);
    expect(String(firstCacheKey)).toContain(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
    // 缓存键包含规范化的请求身份；不依赖其中快照 JSON 的转义/序列化层数。
    expect(String(firstCacheKey)).toContain('"planKind":"individual-coding-plan"');
    expect(String(secondCacheKey)).toContain(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan);
    expect(String(secondCacheKey)).toContain('"organizationId":"org-a"');
  });
});

describe("useCodingPlanAccessRefresh", () => {
  it("只在套餐选择身份变化时刷新权益", () => {
    const refresh = vi.fn(async () => undefined);
    const hook = renderHook(
      ({ selectedPlanKey }) => useCodingPlanAccessRefresh({ refresh, selectedPlanKey }),
      { initialProps: { selectedPlanKey: null as string | null } },
    );

    expect(refresh).not.toHaveBeenCalled();

    hook.rerender({ selectedPlanKey: "coding-plan:bigmodel-individual" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith({ silent: true, reason: "access" });

    hook.rerender({ selectedPlanKey: "coding-plan:bigmodel-individual" });
    expect(refresh).toHaveBeenCalledTimes(1);

    hook.rerender({ selectedPlanKey: "team-plan:bigmodel:project-a" });
    expect(refresh).toHaveBeenCalledTimes(2);

    hook.rerender({ selectedPlanKey: null });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCodingPlanProviderFingerprintAutoRefresh", () => {
  it("连接方式同步期间跳过一次 provider 指纹自动刷新", () => {
    const skipped = resolveCodingPlanProviderFingerprintAutoRefresh({
      loading: false,
      providerFingerprint: "provider-key:v2",
      skippedProviderFingerprint: "",
      suppressAutoRefresh: true,
    });

    expect(skipped).toEqual({
      shouldRefresh: false,
      skippedProviderFingerprint: "provider-key:v2",
    });

    expect(
      resolveCodingPlanProviderFingerprintAutoRefresh({
        loading: false,
        providerFingerprint: "provider-key:v2",
        skippedProviderFingerprint: skipped.skippedProviderFingerprint,
        suppressAutoRefresh: false,
      }),
    ).toEqual({
      shouldRefresh: false,
      skippedProviderFingerprint: "",
    });
  });
});
