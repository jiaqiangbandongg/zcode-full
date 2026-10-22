// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
const mocks = vi.hoisted(() => ({
  auth: { user: { id: "account-a" } as { id: string } | null, authSessionSeq: 1 },
  getStaticTeamProducts: vi.fn(async () => ({})),
  getEnterprisePricing: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ codingPlanSubscriptionService: mocks }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (selector: (state: typeof mocks.auth) => unknown) =>
    selector(mocks.auth),
}));
function Harness({
  enabled,
  authenticated,
  family = "bigmodel",
}: {
  enabled: boolean;
  authenticated: boolean;
  family?: "bigmodel" | "zai";
}) {
  const products = useEnterpriseCodingPlanProducts({ enabled, authenticated, family });
  return createElement(
    "div",
    null,
    products.snapshot?.raw.productList.map((p) => p.productId).join(","),
  );
}
beforeEach(() => {
  mocks.auth = { user: { id: "account-a" }, authSessionSeq: 1 };
  mocks.getEnterprisePricing.mockReset().mockResolvedValue({
    productList: [
      {
        productId: "private-team-a",
        subscribed: true,
        tier: "PRO",
        subscribeMode: "CONTINUOUS",
        subscribePeriod: "MONTHLY",
        payAmount: 100,
      },
    ],
  });
});
afterEach(cleanup);
it("登录目录已加载后登出，立即清除团队；普通 disabled 仍保留同身份快照", async () => {
  const { rerender } = render(createElement(Harness, { enabled: true, authenticated: true }));
  await screen.findByText("private-team-a");
  rerender(createElement(Harness, { enabled: false, authenticated: true }));
  expect(screen.queryByText("private-team-a")).not.toBeNull();
  mocks.auth.user = null;
  rerender(createElement(Harness, { enabled: false, authenticated: false }));
  expect(screen.queryByText("private-team-a")).toBeNull();
});
it("登出后的迟到响应不能复活旧团队目录", async () => {
  let resolve!: (value: unknown) => void;
  mocks.getEnterprisePricing.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { rerender } = render(createElement(Harness, { enabled: true, authenticated: true }));
  await waitFor(() => expect(mocks.getEnterprisePricing).toHaveBeenCalledTimes(1));
  mocks.auth.user = null;
  rerender(createElement(Harness, { enabled: false, authenticated: false }));
  await act(async () => {
    resolve({
      productList: [
        {
          productId: "private-team-a",
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "MONTHLY",
          payAmount: 100,
        },
      ],
    });
  });
  expect(screen.queryByText("private-team-a")).toBeNull();
});
it.each(["account", "session", "family"] as const)(
  "身份边界 %s 变化时不能保留旧目录",
  async (boundary) => {
    const { rerender } = render(createElement(Harness, { enabled: true, authenticated: true }));
    await screen.findByText("private-team-a");
    mocks.getEnterprisePricing.mockReturnValue(new Promise(() => {}));
    if (boundary === "account") mocks.auth.user = { id: "account-b" };
    if (boundary === "session") mocks.auth.authSessionSeq++;
    rerender(
      createElement(Harness, {
        enabled: true,
        authenticated: true,
        family: boundary === "family" ? "zai" : "bigmodel",
      }),
    );
    expect(screen.queryByText("private-team-a")).toBeNull();
  },
);
