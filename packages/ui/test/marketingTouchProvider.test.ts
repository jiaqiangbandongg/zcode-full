// @vitest-environment jsdom
import { createElement, useContext } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const services = {
    marketingTouchService: { query: vi.fn(), report: vi.fn().mockResolvedValue(undefined) },
    cloudContentService: {},
    codingPlanSubscriptionService: {
      claimManualPlan: vi.fn().mockResolvedValue({ success: true }),
    },
    usageStatsService: { getEntitlementSnapshot: vi.fn().mockResolvedValue({}) },
    providerSettingsService: { refresh: vi.fn().mockResolvedValue({}) },
  };
  const tabs = { openSettingsTab: vi.fn(), activeWorkspacePath: "/fixture" };
  return {
    services,
    tabs,
    tabApi: { getState: () => tabs },
    platform: { openExternal: vi.fn() },
    store: { user: { id: "fixture" }, isRestoringOAuthSession: false, requestLoginEntry: vi.fn() },
    intl: { formatMessage: ({ id }: { id: string }) => id },
    upgrade: vi.fn(),
    rewards: vi.fn().mockResolvedValue(undefined),
  };
});
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
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => h.services }));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => h.platform }));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: typeof h.store) => unknown) => selector(h.store),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof h.tabs) => unknown) => selector(h.tabs),
  useTabStoreApi: () => h.tabApi,
}));
vi.mock("@/WorkspaceSidebarFooterUsageSummary.js", () => ({
  useWorkspaceSidebarFooterUsageSummaryState: () => ({}),
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: h.upgrade }),
}));
vi.mock("@/rewards/RewardsProvider.js", () => ({ useOpenRewards: () => h.rewards }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: h.intl, locale: "en-US" }),
}));
vi.mock("@/components/cloud-content-dialog/useCloudHeroEnvironment.js", () => ({
  useCloudHeroEnvironment: () => ({ dark: false }),
}));
vi.mock("@/components/marketing-touch/marketingResources.js", () => ({
  prepareMarketingHero: vi.fn().mockResolvedValue({
    hero: { type: "image", src: "fixture.png" },
    release: async () => {},
  }),
}));
vi.mock("@/components/marketing-touch/MarketingDialogs.js", () => ({
  MarketingDialogs: () => null,
}));
vi.mock("@/components/marketing-touch/MarketingBanner.js", () => ({
  MarketingBannerView: ({ onClick }: { onClick: () => void }) =>
    createElement("button", { onClick }, "Claim"),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  MarketingBanner,
  MarketingTouchProvider,
} from "@/components/marketing-touch/MarketingTouchProvider.js";
import { MarketingRefreshContext } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";

function TaskCompletionProbe() {
  const refresh = useContext(MarketingRefreshContext);
  return createElement("button", { onClick: () => refresh?.() }, "Task completed");
}

it.each([true, false])("任务完成请求复用窗口 poller（desktop=%s）", async (desktop) => {
  let release!: () => void;
  h.services.marketingTouchService.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ scope: "fixture", deliveries: [] });
        }),
    )
    .mockResolvedValue({ scope: "fixture", deliveries: [] });
  render(
    createElement(MarketingTouchProvider, {
      desktop,
      children: createElement(TaskCompletionProbe),
    }),
  );
  await waitFor(() => expect(h.services.marketingTouchService.query).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("Task completed"));
  fireEvent.click(screen.getByText("Task completed"));
  expect(h.services.marketingTouchService.query).toHaveBeenCalledTimes(1);
  await act(async () => release());
  await waitFor(() => expect(h.services.marketingTouchService.query).toHaveBeenCalledTimes(2));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("rewards 导航委托窗口 Provider，保留一次 confirm 上报且不领取", async () => {
  h.services.marketingTouchService.query.mockResolvedValue({
    scope: "fixture-scope",
    deliveries: [
      {
        campaign_id: "fixture-rewards",
        resource_position: "banner",
        banner: {
          background: { type: "image" },
          buttons: [
            {
              text: { format: "plaintext", content: "Open rewards" },
              action: { type: "navigate", args: { page: "rewards" } },
            },
          ],
        },
      },
    ],
  });
  render(
    createElement(MarketingTouchProvider, {
      desktop: true,
      children: createElement(MarketingBanner),
    }),
  );
  fireEvent.click(await screen.findByText("Claim"));
  await waitFor(() => expect(h.rewards).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(h.services.marketingTouchService.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ campaignId: "fixture-rewards", actionType: "confirm" }),
    ),
  );
  expect(h.services.codingPlanSubscriptionService.claimManualPlan).not.toHaveBeenCalled();
});
