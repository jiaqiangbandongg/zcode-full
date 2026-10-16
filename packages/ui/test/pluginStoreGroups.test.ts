// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";

const state = vi.hoisted(() => ({ locale: "zh-CN" }));
vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: state.locale,
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/settings/PluginStoreCard.js", () => ({
  PluginStoreCard: ({ item }: { item: StorePluginItem }) =>
    createElement("div", { "data-testid": "card" }, item.id),
}));
vi.mock("@/settings/PluginStoreAvatar.js", () => ({ PluginStoreAvatar: () => null }));
import { PluginStoreListView } from "../src/settings/PluginStoreListView.js";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
});

describe.each(["zh-CN", "en-US"])("plugin groups in %s", (locale) => {
  it.each(["public", "personal"] as const)(
    "shows all %s cards by default and retains manual toggling",
    async (segment) => {
      state.locale = locale;
      const marketplace = segment === "public" ? ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID : "my-market";
      const items: StorePluginItem[] = Array.from({ length: 8 }, (_, index) => ({
        id: `item-${index}@${marketplace}`,
        name: `item-${index}`,
        marketplace,
        installed: false,
        restorable: false,
        orphaned: false,
        listing: { category: "utilities" },
      }));
      const container = document.createElement("div");
      root = createRoot(container);
      const render = (query = "") =>
        act(() =>
          root?.render(
            createElement(PluginStoreListView, {
              items,
              marketplaces: [],
              actions: {} as PluginStoreActions,
              loading: false,
              query,
              segment,
              onQueryChange: vi.fn(),
              onSegmentChange: vi.fn(),
              onOpenManage: vi.fn(),
            }),
          ),
        );
      const count = () => container.querySelectorAll('[data-testid="card"]').length;
      const toggle = () =>
        act(() =>
          container
            .querySelector<HTMLButtonElement>('[data-testid="plugin-store-group-toggle"]')!
            .click(),
        );
      await render();
      expect(count()).toBe(8);
      await toggle();
      expect(count()).toBe(6);
      await render("item-7");
      expect(count()).toBe(1);
      await render();
      expect(count()).toBe(6);
      await toggle();
      expect(count()).toBe(8);
    },
  );
});
