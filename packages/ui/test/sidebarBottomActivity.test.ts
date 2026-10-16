// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createGlobalNoticeStore,
  type GlobalNoticeStorage,
} from "@/global-notice/globalNoticeStore.js";
import { isMarketingBannerRenderable } from "@/components/marketing-touch/marketingTouchController.js";
import type { MarketingTouchController } from "@/components/marketing-touch/marketingTouchController.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 领 token banner 的真实渲染树依赖 iframe/cloud-hero/intl，已由 marketingBanner.test.ts 覆盖；
// 这里只验仲裁选择，故把 MarketingBanner 换成轻量桩，保留真实的 useMarketingBannerVisible 与 Context。
vi.mock("@/components/marketing-touch/MarketingTouchProvider.js", async (importActual) => {
  const actual =
    await importActual<typeof import("@/components/marketing-touch/MarketingTouchProvider.js")>();
  return {
    ...actual,
    MarketingBanner: () =>
      createElement("div", { "data-testid": "marketing-banner-stub" }, "banner"),
  };
});

// 在 mock 之后再引入被测组件与 Context，确保拿到打了桩的 MarketingBanner。
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";
import { MarketingTouchContext } from "@/components/marketing-touch/MarketingTouchProvider.js";

function memoryStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function publishShareNotice(
  store: ReturnType<typeof createGlobalNoticeStore>,
  now = Date.now(),
): void {
  store.publish({
    noticeId: "notice-1",
    dedupeKey: "highspeed-share:latest",
    type: "highspeed-share",
    schemaVersion: 1,
    scope: "user",
    priority: "normal",
    interruptPolicy: "passive",
    createdAt: now,
    expiresAt: now + 100_000,
    payload: {
      cardId: "hsc-1",
      shareId: "share-1",
      shareUrl: "https://example.test/share-1",
      shareExpiresAt: now + 1_000_000,
      tokenUsage: 10,
      durationSeconds: 1,
    },
    actions: [],
    dismissPolicy: { kind: "cooldown", cooldownMs: 24 * 60 * 60_000 },
    persistencePolicy: "latest-only",
    source: "highspeed",
    revision: 1,
  });
}

// 构造一个仅够 useMarketingBannerVisible 读取的假控制器：只需要 store.subscribe / getState().banner。
function fakeController(banner: unknown): MarketingTouchController {
  const store = createStore(() => ({ banner }));
  return { store } as unknown as MarketingTouchController;
}

type GlobalNoticeStore = ReturnType<typeof createGlobalNoticeStore>;

// 可渲染的 banner 候选：满足 isMarketingBannerRenderable 谓词的最小结构。
const renderableBanner = {
  delivery: { resource_position: "banner" },
  image: "data:image/png;base64,a",
} as unknown;

function renderActivity(controller: MarketingTouchController, noticeStore: GlobalNoticeStore) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        MarketingTouchContext.Provider,
        { value: controller },
        createElement(SidebarBottomActivity, { noticeStore }),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("isMarketingBannerRenderable", () => {
  it("为 null 时判定不可见", () => {
    expect(isMarketingBannerRenderable(null)).toBe(false);
  });
  it("popup 位置的投放不算左下角 banner", () => {
    expect(
      isMarketingBannerRenderable({
        delivery: { resource_position: "popup" },
        image: "x",
      } as never),
    ).toBe(false);
  });
  it("banner 位置但无图无 hero 时不可见", () => {
    expect(
      isMarketingBannerRenderable({ delivery: { resource_position: "banner" } } as never),
    ).toBe(false);
  });
  it("banner 位置且有图片时可见", () => {
    expect(isMarketingBannerRenderable(renderableBanner as never)).toBe(true);
  });
  it("banner 位置且有 bannerHero 时可见", () => {
    expect(
      isMarketingBannerRenderable({
        delivery: { resource_position: "banner" },
        bannerHero: { type: "video" },
      } as never),
    ).toBe(true);
  });
});

describe("SidebarBottomActivity 共享槽位仲裁", () => {
  it("banner 可见 + highspeed 有通知 → 只渲染领 token banner，让位 highspeed", () => {
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage() });
    publishShareNotice(noticeStore);
    const { container } = renderActivity(fakeController(renderableBanner), noticeStore);

    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).toBeNull();
  });

  it("banner 不可见 + highspeed 有通知 → 同一槽位渲染 highspeed 卡", () => {
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage() });
    publishShareNotice(noticeStore);
    const { container } = renderActivity(fakeController(null), noticeStore);

    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).toBeNull();
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();
  });

  it("两者都不可见 → 槽位不产生多余内容", () => {
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage() });
    const { container } = renderActivity(fakeController(null), noticeStore);

    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).toBeNull();
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).toBeNull();
  });

  it("banner 关闭后（store 更新为 null）highspeed 在同一槽位复现", () => {
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage() });
    publishShareNotice(noticeStore);
    const controller = fakeController(renderableBanner);
    const { container } = renderActivity(controller, noticeStore);
    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).not.toBeNull();

    act(() => {
      controller.store.setState({ banner: null } as never);
    });

    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).toBeNull();
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();
  });
});
