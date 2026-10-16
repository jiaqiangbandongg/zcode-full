import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeInstalledPluginSummary } from "@zcode/shared";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// 复用 pluginStoreCardRestorable.test.ts 的「mock Button 捕获 onClick」套路。
const { buttonProps } = vi.hoisted(() => ({
  buttonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => {
    buttonProps.push(props);
    return createElement("button", props as Record<string, unknown>, children);
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) =>
    createElement("span", {}, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

function installedMeta(
  overrides: Partial<ZCodeInstalledPluginSummary> = {},
): ZCodeInstalledPluginSummary {
  return {
    id: "demo@personal",
    name: "demo",
    marketplace: "personal",
    enabled: true,
    scope: "user",
    updateStatus: "update-available",
    ...overrides,
  };
}

function storeItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "demo@personal",
    name: "demo",
    marketplace: "personal",
    installed: true,
    restorable: false,
    orphaned: false,
    installedMeta: installedMeta(),
    ...overrides,
  };
}

function makeActions(overrides: Partial<PluginStoreActions> = {}): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onSetEnabled: () => {},
    onUpdate: () => {},
    operationId: null,
    togglingPluginId: null,
    ...overrides,
  };
}

async function renderCard(item: StorePluginItem, actions: PluginStoreActions): Promise<string> {
  const { PluginStoreCard } = await import("../src/settings/PluginStoreCard.js");
  return renderToStaticMarkup(createElement(PluginStoreCard, { item, actions, locale: "en-US" }));
}

async function renderListView(item: StorePluginItem, actions: PluginStoreActions): Promise<string> {
  const { PluginStoreListView } = await import("../src/settings/PluginStoreListView.js");
  return renderToStaticMarkup(
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
}

describe("plugin update badge and inline update entries", () => {
  afterEach(() => {
    buttonProps.length = 0;
  });

  it("shows the update badge and inline update button on an updatable installed card", async () => {
    const html = await renderCard(storeItem(), makeActions());
    expect(html).toContain('data-testid="plugin-store-update-badge"');
    expect(html).toContain('data-testid="plugin-store-card-update"');
  });

  it("hides both entries when the plugin has no pending update", async () => {
    const html = await renderCard(
      storeItem({ installedMeta: installedMeta({ updateStatus: "none" }) }),
      makeActions(),
    );
    expect(html).not.toContain('data-testid="plugin-store-update-badge"');
    expect(html).not.toContain('data-testid="plugin-store-card-update"');
  });

  it("hides both entries for an orphaned plugin even when a stale updateStatus remains", async () => {
    const html = await renderCard(storeItem({ orphaned: true }), makeActions());
    expect(html).not.toContain('data-testid="plugin-store-update-badge"');
    expect(html).not.toContain('data-testid="plugin-store-card-update"');
  });

  it("invokes onUpdate with the plugin id when the inline button is clicked", async () => {
    const onUpdate = vi.fn();
    await renderCard(storeItem(), makeActions({ onUpdate }));

    const updateButton = buttonProps.find(
      (props) => props["data-testid"] === "plugin-store-card-update",
    );
    const onClick = updateButton?.onClick as ((event: unknown) => void) | undefined;
    expect(onClick).toBeTypeOf("function");
    onClick?.({ stopPropagation: () => {} });
    expect(onUpdate).toHaveBeenCalledWith("demo@personal");
  });

  it("overlays an update entry on the installed strip avatar only when updatable", async () => {
    const pendingHtml = await renderListView(storeItem(), makeActions());
    expect(pendingHtml).toContain('data-testid="plugin-store-installed-item-update"');

    const noneHtml = await renderListView(
      storeItem({ installedMeta: installedMeta({ updateStatus: "none" }) }),
      makeActions(),
    );
    expect(noneHtml).not.toContain('data-testid="plugin-store-installed-item-update"');
  });
});
