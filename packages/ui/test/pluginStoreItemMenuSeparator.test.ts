import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// Radix 菜单关闭时不会渲染内容，这里把菜单原语替换为直出子节点，只验证菜单项结构。
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) =>
    createElement("div", { role: "menuitem", "data-testid": props["data-testid"] }, children),
  DropdownMenuSeparator: () => createElement("hr", { "data-slot": "dropdown-menu-separator" }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

function storeItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "skill-creator@zcode-plugins-official",
    name: "skill-creator",
    marketplace: "zcode-plugins-official",
    installed: true,
    restorable: false,
    orphaned: false,
    ...overrides,
  };
}

function makeActions(overrides: Partial<PluginStoreActions> = {}): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onUpdate: () => {},
    operationId: null,
    togglingPluginId: null,
    ...overrides,
  };
}

async function renderMenu(item: StorePluginItem, actions: PluginStoreActions): Promise<string> {
  const { PluginStoreItemMenu } = await import("../src/settings/PluginStoreCard.js");
  return renderToStaticMarkup(createElement(PluginStoreItemMenu, { item, actions }));
}

describe("PluginStoreItemMenu separator", () => {
  // Bug：菜单只剩「卸载」一项时仍在其上方渲染分隔线，用户看到一条孤立横线。
  it("菜单只有卸载一项时不渲染分隔线", async () => {
    const html = await renderMenu(storeItem(), makeActions());

    expect(html).toContain('data-testid="plugin-store-menu-uninstall"');
    expect(html).not.toContain('data-slot="dropdown-menu-separator"');
  });

  it("卸载前只有「更新」一项时同样保留分隔线", async () => {
    const html = await renderMenu(
      storeItem({
        installedMeta: {
          id: "skill-creator@zcode-plugins-official",
          name: "skill-creator",
          marketplace: "zcode-plugins-official",
          enabled: true,
          scope: "user",
          updateStatus: "update-available",
        },
      }),
      makeActions(),
    );

    expect(html).toContain('data-testid="plugin-store-menu-update"');
    expect(html).toContain('data-slot="dropdown-menu-separator"');
  });

  it("卸载前有其他操作项时保留分隔线", async () => {
    const html = await renderMenu(
      storeItem({ info: { enabled: true } as StorePluginItem["info"] }),
      makeActions({ onSetEnabled: () => {} }),
    );

    expect(html).toContain('data-testid="plugin-store-menu-enabled"');
    expect(html).toContain('data-slot="dropdown-menu-separator"');
  });
});
