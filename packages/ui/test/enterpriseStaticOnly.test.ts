// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(cleanup);
import { expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
const mocks = vi.hoisted(() => ({
  getStaticTeamProducts: vi.fn(),
  getEnterprisePricing: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ codingPlanSubscriptionService: mocks }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, value: unknown) => value,
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
  const { result } = renderHook(() =>
    useEnterpriseCodingPlanProducts({ enabled: true, authenticated: false, staticOnly: true }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(mocks.getEnterprisePricing).not.toHaveBeenCalled();
  expect(result.current.snapshot!.productList.map((p: any) => p.payAmount)).toEqual(
    configured ? [321] : [],
  );
  expect(result.current.snapshot!.staticProductIds).toEqual(configured ? ["configured-team"] : []);
});
