// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/provider";
import type { IUsageStatsService, ProviderSettingsView } from "@zcode/services";
import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
const f = vi.hoisted(() => ({
  query: vi.fn(),
  account: "A",
  service: undefined as IUsageStatsService | undefined,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => ({
    usageStatsService: f.service,
    settingService: { get: async () => ({ startPlanRecommendationDismissed: false }) },
  }),
}));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({ state: { status: "ready", view: settingsView() } }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
const startId = "account:bigmodel-start-plan";
const paid = {
  providerId: "account:bigmodel-individual-coding-plan",
  modelId: "glm-5",
  options: { reasoningLevel: "high" },
};
function settingsView(): ProviderSettingsView {
  return {
    revision: 1,
    providers: [
      {
        providerId: startId,
        accountState: {
          availability: "available",
          entitled: true,
          current: true,
          connectionKey: f.account,
        },
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
  } as ProviderSettingsView;
}
const view = {
  revision: 1,
  providers: [
    {
      providerId: startId,
      config: {},
      models: [
        { modelId: "glm-5", config: { optionSpecs: { reasoningLevel: { values: ["high"] } } } },
      ],
    },
  ],
} as unknown as ModelSelectionView;
const snapshot = (remaining: number): UsageEntitlementSnapshot =>
  ({
    provider: { id: startId },
    generatedAt: Date.now(),
    quota: {
      limits: [
        {
          remaining,
          number: 100,
          periodStart: 0,
          periodEnd: Date.now() + 600000,
          usageDetails: [{ modelCode: "glm-5" }],
        },
      ],
    },
  }) as UsageEntitlementSnapshot;
beforeEach(() => {
  f.account = "A";
  f.query.mockReset().mockImplementation(async () => snapshot(10));
  f.service = { getEntitlementSnapshot: f.query } as unknown as IUsageStatsService;
  localStorage.clear();
});
afterEach(() => {
  act(() => useConfirmDialogStore.getState().settleChoice("dismiss"));
  cleanup();
  vi.restoreAllMocks();
});
async function shown(recommend: ReturnType<typeof useStartPlanRecommendation>) {
  let pending!: ReturnType<typeof recommend>;
  await act(async () => {
    pending = recommend(paid);
  });
  const visible = Boolean(useConfirmDialogStore.getState().pendingRequest);
  act(() => useConfirmDialogStore.getState().settleChoice("cancel"));
  await pending;
  return visible;
}
async function ready() {
  const hook = renderHook(() => useStartPlanRecommendation(view));
  await waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  await act(async () => {});
  return hook;
}
it("长时间闲置后本次提交不等待余额，也不补弹；后续使用新采样", async () => {
  const hook = await ready();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  expect(await shown(hook.result.current)).toBe(false);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(await shown(hook.result.current)).toBe(true);
});
it("重挂使用真实采样时间，跨日访问重新查询", async () => {
  const first = await ready();
  first.unmount();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400000);
  f.query.mockImplementation(async () => snapshot(0));
  const next = renderHook(() => useStartPlanRecommendation(view));
  await act(async () => {});
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(await shown(next.result.current)).toBe(false);
});
it("同品牌换账号按原连接指纹获取新余额", async () => {
  const hook = await ready();
  f.account = "B";
  f.query.mockImplementation(async () => snapshot(0));
  hook.rerender();
  await act(async () => {});
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(await shown(hook.result.current)).toBe(false);
});
it("设置页刷新向推荐发布零额度及补充后的正额度，并合并同一访问", async () => {
  const hook = await ready();
  const settings = renderHook(() =>
    useUsageEntitlementWithService(
      f.service,
      buildStartPlanEntitlementOptions(settingsView(), startId),
    ),
  );
  await act(async () => {
    await settings.result.current.refresh({ reason: "access" });
  });
  expect(f.query).toHaveBeenCalledTimes(1);
  for (const remaining of [0, 10]) {
    f.query.mockImplementation(async () => snapshot(remaining));
    await act(async () => {
      await settings.result.current.refresh({ force: true, reason: "manual" });
    });
    expect(await shown(hook.result.current)).toBe(remaining > 0);
  }
});
it("刷新失败跳过推荐，重复提交遵守退避，恢复后可再次推荐", async () => {
  const hook = await ready();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  f.query.mockRejectedValue(new Error("offline"));
  expect(await shown(hook.result.current)).toBe(false);
  expect(await shown(hook.result.current)).toBe(false);
  expect(f.query).toHaveBeenCalledTimes(2);
  now.mockReturnValue(Date.now() + 61000);
  f.query.mockImplementation(async () => snapshot(10));
  expect(await shown(hook.result.current)).toBe(false);
  expect(await shown(hook.result.current)).toBe(true);
});

it("设置刷新失败不能让另一入口继续按旧正额度推荐", async () => {
  const hook = await ready();
  const settings = renderHook(() =>
    useUsageEntitlementWithService(
      f.service,
      buildStartPlanEntitlementOptions(settingsView(), startId),
    ),
  );
  f.query.mockRejectedValue(new Error("offline"));
  await act(async () => {
    await settings.result.current.refresh({ force: true, silent: true });
  });
  expect(await shown(hook.result.current)).toBe(false);
});
