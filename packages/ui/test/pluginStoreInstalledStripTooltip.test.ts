import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

const actions: PluginStoreActions = {
  onOpenDetail: () => {},
  onInstall: () => {},
  onUninstall: () => {},
  onSetEnabled: () => {},
  onUpdate: () => {},
  operationId: null,
  togglingPluginId: null,
};

describe("PluginStoreListView installed strip", () => {
  it("shows each installed plugin display name through the standard tooltip", async () => {
    const item: StorePluginItem = {
      id: "example-plugin@zcode-plugins-official",
      name: "example-plugin",
      marketplace: "zcode-plugins-official",
      installed: true,
      restorable: false,
      orphaned: false,
      listing: { displayName: "Example Plugin", category: "developer-tools" },
      info: {
        id: "example-plugin@zcode-plugins-official",
        name: "example-plugin",
        marketplace: "zcode-plugins-official",
        enabled: false,
        source: "official",
        skillRootCount: 0,
        commandRootCount: 0,
        mcpServerNames: [],
        rootPath: "/builtin/example-plugin",
      },
    };
    const { PluginStoreListView } = await import("../src/settings/PluginStoreListView.js");
    const html = renderToStaticMarkup(
      createElement(PluginStoreListView, {
        items: [item],
        marketplaces: [],
        actions,
        loading: false,
        query: "",
        onQueryChange: () => {},
        segment: "public",
        onSegmentChange: () => {},
        onOpenManage: () => {},
      }),
    );

    expect(html).toContain('data-tooltip-title="Example Plugin"');
    expect(html).toContain('aria-label="Example Plugin"');
    const installedItemStart = html.indexOf('data-testid="plugin-store-installed-item"');
    const installedItemEnd = html.indexOf("</button>", installedItemStart);
    expect(html.slice(installedItemStart, installedItemEnd)).not.toContain("opacity-50");
    expect(html).toContain("py-4 first:pt-0 last:pb-0");
    expect(html).toContain("h-px bg-surface");
  });
});
