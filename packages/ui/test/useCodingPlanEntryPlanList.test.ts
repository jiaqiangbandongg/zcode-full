// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS as ids } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
const h = vi.hoisted(() => ({
  user: { id: "first" },
  view: {
    revision: 1,
    providers: [],
    providerOrder: [],
    addableProviders: [],
  } as ProviderSettingsView,
  readError: false,
  reload: vi.fn(),
  entitlements: {} as Record<string, unknown>,
  load: vi.fn(),
  pricing: vi.fn(),
  entitlementsHook: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: h.readError
      ? { status: "error", error: new Error("read failed") }
      : { status: "ready", view: h.view },
    reload: h.reload,
  }),
}));
vi.mock("@/hooks/useServices.js", () => {
  const services = {
    credentialService: { load: h.load },
    codingPlanSubscriptionService: { getEnterprisePricing: h.pricing },
  };
  return { useServices: () => services };
});
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (select: (state: unknown) => unknown) => select({ user: h.user }),
}));
vi.mock("@/settings/model-provider-section/useCodingPlanEntitlements.js", () => ({
  useCodingPlanEntitlements: (params: unknown) => {
    h.entitlementsHook(params);
    return { entitlements: h.entitlements, refresh: h.refresh };
  },
}));
import { useCodingPlanEntryPlanList } from "@/hooks/useCodingPlanEntryPlanList.js";
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useOptionalCodingPlanUpgradeDialog: () => ({ inventory: useCodingPlanEntryPlanList() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.readError = false;
});

function setProviders(ids: string[]) {
  h.view = {
    revision: h.view.revision + 1,
    providerOrder: [],
    addableProviders: [],
    providers: ids.map((providerId) => ({
      providerId,
      enabled: false,
      executable: false,
      issues: [],
      models: [],
      effectiveConfig: {
        access: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode: providerId.includes("start-plan") ? "start-plan" : "individual-coding-plan",
          entitled: true,
        },
        builtinModelIds: [],
      },
    })),
  };
}
it("includes disabled owned connections and authenticated teams; drops team data after account change", async () => {
  setProviders([ids.bigmodelIndividualCodingPlan, ids.bigmodelStartPlan]);
  h.entitlements = Object.fromEntries(
    h.view.providers.map(({ providerId: id }) => [
      id,
      {
        snapshot: {
          authenticated: true,
          provider: { id },
          subscription: {
            details: [
              {
                productId: id === ids.bigmodelStartPlan ? "start-v3" : "lite",
                productName: "",
                expireTime: null,
              },
            ],
          },
        },
      },
    ]),
  );
  h.load.mockResolvedValue("token");
  h.pricing.mockResolvedValue({
    productList: [{ subscribed: true, tier: "PRO", productId: "team-pro" }],
  });
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() =>
    expect(view.result.current.entryPlanList).toBe(
      "coding_plan__personal_lite,coding_plan__team_pro,start_plan__start_v3",
    ),
  );
  expect(h.entitlementsHook).toHaveBeenCalledWith({
    providerSettingsView: h.view,
    suppressProviderFingerprintAutoRefresh: true,
  });
  expect(h.pricing).toHaveBeenCalledWith({ authenticated: true, family: "bigmodel" });
  expect(h.pricing).toHaveBeenCalledWith({ authenticated: true, family: "zai" });
  h.user = { id: "second" };
  h.load.mockResolvedValue(null);
  view.rerender();
  expect(view.result.current.status).toBe("loading");
  await waitFor(() => expect(h.load).toHaveBeenCalledTimes(4));
});

it("waits for slow team queries and exposes retry after a failed query", async () => {
  setProviders([]);
  h.entitlements = {};
  h.load.mockResolvedValue("token");
  let rejectQuery!: (reason: Error) => void;
  h.pricing.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectQuery = reject;
      }),
  );
  // 两个 family 中仅 bigmodel 登录，避免测试悬挂的另一条请求。
  h.load.mockImplementation(async (key: string) => (key.includes("bigmodel") ? "token" : null));
  const view = renderHook(() => useCodingPlanEntryPlanList());
  expect(view.result.current.status).toBe("loading");
  await waitFor(() => expect(h.pricing).toHaveBeenCalledTimes(1));
  expect(view.result.current.status).toBe("loading");
  await act(async () => {
    rejectQuery(new Error("offline"));
  });
  await waitFor(() => expect(view.result.current.status).toBe("error"));
  h.pricing.mockResolvedValue({ productList: [] });
  act(() => view.result.current.retry());
  expect(view.result.current.status).toBe("loading");
  await waitFor(() => expect(view.result.current.status).toBe("ready"));
  expect(view.result.current.entryPlanList).toBe("");
});
it("does not treat a missing configured entitlement as successful empty inventory", async () => {
  setProviders([ids.bigmodelIndividualCodingPlan]);
  h.entitlements = {
    [ids.bigmodelIndividualCodingPlan]: { snapshot: null, loading: false, error: "offline" },
  };
  h.load.mockResolvedValue(null);
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(view.result.current.status).toBe("error"));
  h.entitlements = {
    [ids.bigmodelIndividualCodingPlan]: {
      snapshot: { unavailableReason: "no_plan" },
      loading: false,
      error: null,
    },
  };
  view.rerender();
  expect(view.result.current.status).toBe("ready");
});

it("does not expose empty success when Settings failed; retry reloads the shared view", async () => {
  h.readError = true;
  const view = renderHook(() => useCodingPlanEntryPlanList());
  expect(view.result.current.status).toBe("error");
  expect(h.pricing).not.toHaveBeenCalled();
  act(() => view.result.current.retry());
  expect(h.reload).toHaveBeenCalledOnce();
});

it("uses valid personal and Start snapshots during refresh and after failure", async () => {
  setProviders([ids.bigmodelIndividualCodingPlan, ids.bigmodelStartPlan]);
  h.load.mockResolvedValue(null);
  h.entitlements = Object.fromEntries(
    h.view.providers.map(({ providerId }) => [
      providerId,
      {
        snapshot: {
          authenticated: true,
          provider: { id: providerId },
          subscription: { details: [{ productId: "lite", productName: "", expireTime: null }] },
        },
        loading: true,
        error: "offline",
      },
    ]),
  );
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(view.result.current.status).toBe("ready"));
  expect(view.result.current.entryPlanList).toContain("coding_plan__personal_lite");
});

it("keeps a confirmed no_plan despite a later refresh error", async () => {
  setProviders([ids.bigmodelIndividualCodingPlan]);
  h.load.mockResolvedValue(null);
  h.entitlements = {
    [ids.bigmodelIndividualCodingPlan]: {
      snapshot: { unavailableReason: "no_plan" },
      error: "offline",
    },
  };
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(view.result.current.status).toBe("ready"));
  expect(view.result.current.entryPlanList).toBe("");
});

it("retains team results on failure, replaces them on success, and isolates changed credentials", async () => {
  setProviders([]);
  h.entitlements = {};
  h.load.mockImplementation(async (key: string) => (key.includes("bigmodel") ? "token-a" : null));
  h.pricing.mockResolvedValue({
    productList: [{ subscribed: true, tier: "PRO", productId: "team-pro" }],
  });
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(view.result.current.entryPlanList).toBe("coding_plan__team_pro"));
  h.pricing.mockRejectedValue(new Error("offline"));
  await act(async () => view.result.current.retry());
  expect(view.result.current.status).toBe("ready");
  expect(view.result.current.entryPlanList).toBe("coding_plan__team_pro");
  h.pricing.mockResolvedValue({ productList: [] });
  await act(async () => view.result.current.retry());
  expect(view.result.current.entryPlanList).toBe("");
  h.pricing.mockRejectedValue(new Error("offline"));
  await act(async () => view.result.current.retry());
  expect(view.result.current.status).toBe("ready");
  h.load.mockImplementation(async (key: string) => (key.includes("bigmodel") ? "token-b" : null));
  await act(async () => view.result.current.retry());
  expect(view.result.current.status).toBe("error");
});

it("retains team data across a view refresh but never across account changes", async () => {
  setProviders([]);
  h.entitlements = {};
  h.load.mockResolvedValue("token");
  h.pricing.mockResolvedValue({
    productList: [{ subscribed: true, tier: "PRO", productId: "team-pro" }],
  });
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(view.result.current.entryPlanList).toBe("coding_plan__team_pro"));
  h.pricing.mockRejectedValue(new Error("offline"));
  setProviders([]);
  await act(async () => view.rerender());
  expect(view.result.current.status).toBe("ready");
  h.user = { id: "new-account" };
  view.rerender();
  expect(view.result.current.entryPlanList).toBe("");
  await waitFor(() => expect(view.result.current.status).toBe("error"));
});

it("allows the purchase button to open with a successful snapshot and a refresh error", async () => {
  setProviders([ids.bigmodelIndividualCodingPlan]);
  h.load.mockResolvedValue(null);
  h.entitlements = {
    [ids.bigmodelIndividualCodingPlan]: {
      snapshot: { authenticated: true, unavailableReason: "no_plan" },
      error: "HTTP 429",
      loading: false,
    },
  };
  const purchase = vi.fn();
  render(createElement(CodingPlanEntryButton, { onClick: purchase }, "Upgrade"));
  await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Upgrade"));
  fireEvent.click(screen.getByRole("button"));
  expect(purchase).toHaveBeenCalledOnce();
});

it("does not accept an unavailable snapshot as a successful empty result", async () => {
  setProviders([ids.bigmodelIndividualCodingPlan]);
  h.load.mockResolvedValue(null);
  h.entitlements = {
    [ids.bigmodelIndividualCodingPlan]: {
      snapshot: { authenticated: true, unavailableReason: "unavailable" },
      loading: false,
    },
  };
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(view.result.current.status).toBe("error"));
});

it("ignores an old account's pending team response after switching accounts", async () => {
  setProviders([]);
  h.entitlements = {};
  h.load.mockImplementation(async (key: string) => (key.includes("bigmodel") ? "token" : null));
  let finish!: (value: unknown) => void;
  h.pricing.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() => useCodingPlanEntryPlanList());
  await waitFor(() => expect(h.pricing).toHaveBeenCalledOnce());
  h.user = { id: "switched-while-pending" };
  h.load.mockResolvedValue(null);
  view.rerender();
  await waitFor(() => expect(view.result.current.status).toBe("ready"));
  await act(async () =>
    finish({ productList: [{ subscribed: true, tier: "PRO", productId: "team-pro" }] }),
  );
  expect(view.result.current.entryPlanList).toBe("");
});
