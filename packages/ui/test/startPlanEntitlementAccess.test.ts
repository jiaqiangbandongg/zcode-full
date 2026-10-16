// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
const f = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: {
      status: "ready",
      view: {
        revision: 1,
        providers: ["start-plan", "individual-coding-plan", "team-coding-plan"].map((mode) => ({
          providerId: `account:bigmodel-${mode}`,
          effectiveConfig: {
            access: { type: "zhipu-account", accountType: "bigmodel", mode, entitled: true },
          },
        })),
      },
    },
  }),
}));
vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlementWithService: (_service: unknown, options: Record<string, unknown>) => {
    f.options.push(options);
    return { snapshot: null, error: null, loading: false, refresh: async () => {} };
  },
}));
afterEach(() => {
  cleanup();
  f.options = [];
});
it("冷缓存身份统计同时显式查询 Start 和所选团队，团队 scope 不丢失", () => {
  renderHook(() =>
    usePlanIdentitySnapshot("bigmodel", {
      kind: "team-coding-plan",
      productId: "p",
      organizationId: "o",
      projectId: "j",
    }),
  );
  expect(
    f.options.find((o) => o.preferredProviderId === "account:bigmodel-start-plan")?.accountAccess,
  ).toEqual({ type: "zhipu-account", family: "bigmodel", planKind: "start-plan" });
  expect(
    f.options.find((o) => o.preferredProviderId === "account:bigmodel-team-coding-plan")
      ?.accountAccess,
  ).toEqual({
    type: "zhipu-account",
    family: "bigmodel",
    planKind: "team-coding-plan",
    productId: "p",
    organizationId: "o",
    projectId: "j",
  });
});
it("会话反馈按执行 Start 补访问参数；切到其他执行 Provider 时停止 Start 查询", () => {
  const hook = renderHook(
    ({ providerId }) =>
      useV4SessionQuotaBanner({
        sessionId: "access",
        error: null,
        errorKey: null,
        phase: "idle",
        providerId,
        modelId: "glm-5",
      }),
    { initialProps: { providerId: "account:bigmodel-start-plan" } },
  );
  expect(f.options[0]).toMatchObject({
    enabled: true,
    accountAccess: { type: "zhipu-account", family: "bigmodel", planKind: "start-plan" },
    includeSubscription: true,
  });
  f.options = [];
  hook.rerender({ providerId: "account:bigmodel-team-coding-plan" });
  expect(f.options[0]?.enabled).toBe(false);
});
