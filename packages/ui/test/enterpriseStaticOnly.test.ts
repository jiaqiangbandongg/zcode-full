import { expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
const mocks = vi.hoisted(() => ({
  state: null as any,
  getStaticTeamProducts: vi.fn(),
  getEnterprisePricing: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ codingPlanSubscriptionService: mocks }),
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => fn(),
  useMemo: (fn: () => unknown) => fn(),
  useState: (initial: unknown) => {
    mocks.state = initial;
    return [
      initial,
      (next: any) => {
        mocks.state = typeof next === "function" ? next(mocks.state) : next;
      },
    ];
  },
}));
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
it.each([true, false])("未登录仅静态目录，配置存在=%s，不请求 pricing", async (configured) => {
  mocks.getEnterprisePricing.mockReset();
  mocks.getStaticTeamProducts.mockResolvedValue(
    configured
      ? {
          [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
            {
              productId: "configured-team",
              productName: "标准版",
              tier: "PRO",
              subscribeMode: "CONTINUOUS",
              subscribePeriod: "MONTHLY",
              payAmount: 321,
              priceCurrency: "CNY",
            },
          ],
        }
      : {},
  );
  useEnterpriseCodingPlanProducts({ enabled: true, authenticated: false, staticOnly: true });
  await vi.waitFor(() => expect(mocks.state.loading).toBe(false));
  expect(mocks.getEnterprisePricing).not.toHaveBeenCalled();
  expect(mocks.state.snapshot.productList.map((p: any) => p.payAmount)).toEqual(
    configured ? [321] : [],
  );
  expect(mocks.state.snapshot.staticProductIds).toEqual(configured ? ["configured-team"] : []);
});
