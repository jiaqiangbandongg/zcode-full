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
  it.each(["public", "community", "personal"] as const)(
    "expands UI plugins inline in %s and preserves the group during search",
    async (segment) => {
      state.locale = locale;
      const marketplace = segment === "personal" ? "custom" : ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID;
      const items: StorePluginItem[] = Array.from({ length: 9 }, (_, index) => {
        const name = index < 8 ? `panel-${index}` : "panel-regular";
        return {
          id: `${name}@${marketplace}`,
          name,
          marketplace,
          installed: false,
          restorable: false,
          orphaned: false,
          listing: {
            category: "utilities",
            publisherType: segment === "community" ? "community" : "official",
          },
          summary: {
            id: `${name}@${marketplace}`,
            name,
            marketplace,
            installed: false,
            componentTypes: index < 8 ? ["ui"] : [],
          },
        };
      });
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
            }),
          ),
        );
      const uiSection = () => container.querySelector('[data-testid="plugin-store-ui-section"]')!;
      const toggle = () =>
        act(() =>
          uiSection()
            .querySelector<HTMLButtonElement>('[data-testid="plugin-store-group-toggle"]')!
            .click(),
        );
      await render();
      expect(uiSection().querySelectorAll('[data-testid="card"]')).toHaveLength(8);
      expect(container.querySelector('[data-testid="plugin-store-ui-all"]')).toBeNull();
      expect(container.textContent).toContain("panel-regular");
      await toggle();
      expect(uiSection().querySelectorAll('[data-testid="card"]')).toHaveLength(6);
      expect(container.textContent).toContain("panel-regular");
      await render("panel");
      expect(container.querySelectorAll('[data-testid="card"]')).toHaveLength(9);
      await render();
      expect(uiSection().querySelectorAll('[data-testid="card"]')).toHaveLength(6);
      await toggle();
      expect(uiSection().querySelectorAll('[data-testid="card"]')).toHaveLength(8);
      expect(container.querySelector('[data-testid="plugin-store-ui-back"]')).toBeNull();
    },
  );

  it.each(["public", "community", "personal"] as const)(
    "limits %s search to its publisher/source segment",
    async (segment) => {
      const items: StorePluginItem[] = ["public", "community", "personal"].map((source) => ({
        id: `${source}@${source === "personal" ? "custom" : ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
        name: source,
        marketplace: source === "personal" ? "custom" : ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        installed: false,
        restorable: false,
        orphaned: false,
        listing: {
          category: "utilities",
          publisherType: source === "public" ? "official" : "community",
          displayName: "needle",
        },
      }));
      const container = document.createElement("div");
      root = createRoot(container);
      await act(() =>
        root?.render(
          createElement(PluginStoreListView, {
            items,
            marketplaces: [],
            actions: {} as PluginStoreActions,
            loading: false,
            query: "needle",
            segment,
            onQueryChange: vi.fn(),
            onSegmentChange: vi.fn(),
          }),
        ),
      );
      const cards = [...container.querySelectorAll('[data-testid="card"]')];
      expect(cards).toHaveLength(1);
      expect(cards[0]?.textContent).toBe(items.find((item) => item.name === segment)?.id);
    },
  );

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
