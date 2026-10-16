// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGlobalNoticeStore,
  type GlobalNoticeStorage,
} from "@/global-notice/globalNoticeStore.js";
import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function memoryStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

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
    expiresAt: now + 1000,
    payload: {
      cardId: "hsc-1",
      shareId: "share-1",
      shareUrl: "https://example.test/share-1",
      shareExpiresAt: now + 10_000,
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

describe("GlobalNoticeSurface", () => {
  it("hides a visible notice when its expiry is reached without another store event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createGlobalNoticeStore({ storage: memoryStorage() });
    publishShareNotice(store, 1000);

    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(GlobalNoticeSurface, { store }),
      ),
    );
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1020);
    });

    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).toBeNull();
  });

});
