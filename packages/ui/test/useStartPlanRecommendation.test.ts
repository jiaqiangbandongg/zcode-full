// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/provider";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
const fixture = vi.hoisted(() => ({
  dismissed: false,
  update: vi.fn(),
  toast: vi.fn(),
  readError: false,
  error: null as string | null,
}));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: {
      status: "ready",
      view: {
        revision: 1,
        providers: [
          {
            providerId: "account:bigmodel-start-plan",
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
      },
    },
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: fixture.toast }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => ({
    settingService: {
      get: async () => {
        if (fixture.readError) throw new Error("settings unavailable");
        return { startPlanRecommendationDismissed: fixture.dismissed };
      },
      update: fixture.update,
    },
    usageStatsService: {},
  }),
}));
vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlementWithService: (_service: unknown, options: { accountAccess: unknown }) => {
    expect(options.accountAccess).toEqual({
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "start-plan",
    });
    return {
      error: fixture.error,
      refresh: vi.fn(),
      snapshot: {
        provider: { id: "account:bigmodel-start-plan" },
        generatedAt: Date.now(),
        quota: { limits: [{ remaining: 10, usageDetails: [{ modelCode: "glm-5" }] }] },
      },
    };
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
const paid = {
  providerId: "account:bigmodel-individual-coding-plan",
  modelId: "glm-5",
  options: { reasoningLevel: "high" },
};
const start = { ...paid, providerId: "account:bigmodel-start-plan" };
const view = {
  revision: 1,
  providers: [
    {
      providerId: start.providerId,
      config: {},
      models: [
        {
          modelId: start.modelId,
          config: { optionSpecs: { reasoningLevel: { values: ["high"] } } },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;
beforeEach(() => {
  fixture.dismissed = false;
  fixture.readError = false;
  fixture.toast.mockReset();
  fixture.error = null;
  fixture.update.mockReset().mockImplementation(async (patch) => {
    fixture.dismissed = patch.startPlanRecommendationDismissed;
  });
});
afterEach(() => {
  act(() => useConfirmDialogStore.getState().settleChoice("dismiss"));
  cleanup();
});

describe("提交推荐确认与 Host 偏好", () => {
  it.each(["confirm", "cancel"] as const)(
    "%s + 不再提示：只保存抑制偏好，下次仍用当前入口的选择",
    async (choice) => {
      const first = renderHook(() => useStartPlanRecommendation(view));
      let pending!: ReturnType<typeof first.result.current>;
      await act(async () => {
        pending = first.result.current(paid);
      });
      expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined();
      act(() => {
        useConfirmDialogStore.getState().pendingRequest?.checkbox?.onCheckedChange(true);
        useConfirmDialogStore.getState().settleChoice(choice);
      });
      const chosen = await pending;
      expect(chosen).toEqual(choice === "confirm" ? start : paid);
      expect(fixture.update).toHaveBeenCalledExactlyOnceWith({
        startPlanRecommendationDismissed: true,
      });
      first.unmount();
      const next = renderHook(() => useStartPlanRecommendation(view));
      await expect(next.result.current(paid)).resolves.toEqual(paid);
      await expect(next.result.current(start)).resolves.toEqual(start);
      expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
    },
  );
  it("关闭弹窗取消本次提交，即使勾选也不保存偏好", async () => {
    const { result } = renderHook(() => useStartPlanRecommendation(view));
    let pending!: ReturnType<typeof result.current>;
    await act(async () => {
      pending = result.current(paid);
    });
    act(() => {
      useConfirmDialogStore.getState().pendingRequest?.checkbox?.onCheckedChange(true);
      useConfirmDialogStore.getState().settleChoice("dismiss");
    });
    await expect(pending).resolves.toBeNull();
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it("不勾选时保留后续推荐，另一弹窗占用时不误当成“不了”提交", async () => {
    const { result } = renderHook(() => useStartPlanRecommendation(view));
    let pending!: ReturnType<typeof result.current>;
    await act(async () => {
      pending = result.current(paid);
    });
    await expect(result.current(paid)).resolves.toBeNull();
    act(() => useConfirmDialogStore.getState().settleChoice("cancel"));
    await expect(pending).resolves.toEqual(paid);
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it("额度查询失败不会阻断原提交", async () => {
    fixture.error = "offline";
    const { result } = renderHook(() => useStartPlanRecommendation(view));
    await expect(result.current(paid)).resolves.toEqual(paid);
    expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
  });
  it("偏好读取失败跳过推荐，保留原付费提交", async () => {
    fixture.readError = true;
    const { result } = renderHook(() => useStartPlanRecommendation(view));
    await expect(result.current(paid)).resolves.toEqual(paid);
    expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
  });
  it.each(["confirm", "cancel"] as const)(
    "保存偏好失败仍遵守本次 %s，并提示没有保存成功",
    async (choice) => {
      fixture.update.mockRejectedValue(new Error("disk unavailable"));
      const { result } = renderHook(() => useStartPlanRecommendation(view));
      let pending!: ReturnType<typeof result.current>;
      await act(async () => {
        pending = result.current(paid);
      });
      act(() => {
        useConfirmDialogStore.getState().pendingRequest?.checkbox?.onCheckedChange(true);
        useConfirmDialogStore.getState().settleChoice(choice);
      });
      await expect(pending).resolves.toEqual(choice === "confirm" ? start : paid);
      expect(fixture.dismissed).toBe(false);
      expect(fixture.toast).toHaveBeenCalledExactlyOnceWith(
        "startPlan.recommendation.preferenceSaveFailed",
      );
    },
  );
  it("原二元确认兼容关闭行为", async () => {
    const pending = useConfirmDialogStore.getState().requestConfirmation({ title: "delete" });
    useConfirmDialogStore.getState().settleChoice("dismiss");
    await expect(pending).resolves.toBe(false);
  });
});
