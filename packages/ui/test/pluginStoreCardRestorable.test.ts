import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeAvailablePluginSummary, ZCodePluginInfo } from "@zcode/shared";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// 复用 installedPluginManagementUpdate.test.ts 的「mock Button 捕获 onClick」套路：
// SSR 渲染时桩组件把 props 入栈，渲染后直接调用捕获到的按钮 onClick，
// 确定性验证回调——无需真实 DOM/卸载/计时器。
const { buttonProps } = vi.hoisted(() => ({
  buttonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => {
    buttonProps.push(props);
    return createElement("button", props as Record<string, unknown>, children);
  },
}));

function restorableItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  const summary: ZCodeAvailablePluginSummary = {
    id: "skill-creator@zcode-plugins-official",
    name: "skill-creator",
    marketplace: "zcode-plugins-official",
    version: "1.0.0",
    installed: false,
  };
  return {
    id: summary.id,
    name: summary.name,
    marketplace: summary.marketplace,
    installed: false,
    restorable: true,
    orphaned: false,
    summary,
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

function installedItemWithRuntimeInfo(): StorePluginItem {
  const item = restorableItem({ installed: true, restorable: false });
  const info: ZCodePluginInfo = {
    id: item.id,
    name: item.name,
    marketplace: item.marketplace,
    enabled: true,
    source: "official",
    skillCount: 1,
    skillRootCount: 1,
    commandRootCount: 0,
    declaredMcpServerNames: [],
    mcpServerNames: [],
    rootPath: "/cache/skill-creator",
  };
  return { ...item, info };
}

async function renderCard(item: StorePluginItem, actions: PluginStoreActions): Promise<string> {
  const { PluginStoreCard } = await import("../src/settings/PluginStoreCard.js");
  const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreCard, { item, actions, locale: "en-US" }),
    ),
  );
}

async function renderDetail(
  item: StorePluginItem,
  actions: PluginStoreActions,
  onUsePrompt: (item: StorePluginItem, prompt: string) => void = () => {},
): Promise<string> {
  const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
  const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreDetailView, {
        item,
        actions,
        onBack: () => {},
        onRetryDescribe: () => {},
        onUsePrompt,
      }),
    ),
  );
}

describe("PluginStoreCard restorable built-ins", () => {
  afterEach(() => {
    buttonProps.length = 0;
  });

  it("renders an install button for an uninstalled (restorable) built-in", async () => {
    const html = await renderCard(restorableItem(), makeActions());
    expect(html).toContain("skill-creator");
    expect(html).toContain("Install");
  });

  it("invokes onInstall with the restorable item when the install button is clicked", async () => {
    const onInstall = vi.fn();
    await renderCard(restorableItem(), makeActions({ onInstall }));

    const clickHandlers = buttonProps
      .map((props) => props.onClick)
      .filter((onClick): onClick is (event?: unknown) => void => typeof onClick === "function");
    expect(clickHandlers.length).toBeGreaterThan(0);
    for (const onClick of clickHandlers) {
      // 安装按钮的 onClick 依赖事件对象做 stopPropagation，给一个最小事件桩。
      onClick({ stopPropagation: () => {} });
    }

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onInstall.mock.calls[0]?.[0]).toMatchObject({
      id: "skill-creator@zcode-plugins-official",
      restorable: true,
    });
  });

  it("keeps the management menu when an installed plugin has no runtime info", async () => {
    const item = restorableItem({ installed: true, restorable: false });
    const html = await renderCard(item, makeActions());
    expect(html).not.toContain("Install");
    expect(html).toContain('data-testid="plugin-store-item-menu"');
  });

  it("keeps the detail management menu when an installed plugin has no runtime info", async () => {
    const item = restorableItem({ installed: true, restorable: false });
    const html = await renderDetail(item, makeActions());
    expect(html).not.toContain("Install");
    expect(html).toContain('data-testid="plugin-store-item-menu"');
  });

  it("shows Try now for an installed plugin without runtime info and delegates an empty prompt", async () => {
    const item = restorableItem({ installed: true, restorable: false });
    const onUsePrompt = vi.fn();
    const html = await renderDetail(item, makeActions(), onUsePrompt);

    expect(html).toContain('data-testid="plugin-store-try-now"');
    expect(html).toContain("Try now");

    const tryNowButton = buttonProps.find(
      (props) => props["data-testid"] === "plugin-store-try-now",
    );
    expect(tryNowButton?.onClick).toBeTypeOf("function");
    (tryNowButton?.onClick as (() => void) | undefined)?.();
    expect(onUsePrompt).toHaveBeenCalledWith(item, "");
  });

  it("keeps Try now hidden while an uninstalled plugin shows Install", async () => {
    const html = await renderDetail(restorableItem(), makeActions());
    expect(html).not.toContain('data-testid="plugin-store-try-now"');
    expect(html).toContain("Install");
  });

  it("keeps the Workspace config menu for a missing package without offering uninstall", async () => {
    const html = await renderDetail(
      restorableItem({
        info: {
          id: "skill-creator@zcode-plugins-official",
          name: "skill-creator",
          marketplace: "zcode-plugins-official",
          enabled: true,
          source: "missing",
          packageStatus: "missing",
          skillRootCount: 0,
          commandRootCount: 0,
          mcpServerNames: [],
          rootPath: "",
        },
      }),
      makeActions({ onResetConfig: () => {} }),
    );

    expect(html).toContain('data-testid="plugin-store-item-menu"');
    expect(html).not.toContain('data-testid="plugin-store-menu-uninstall"');
    expect(html).toContain("Install");
  });

  it("keeps installed card and detail enablement inside the actions menu", async () => {
    const item = installedItemWithRuntimeInfo();
    const cardHtml = await renderCard(item, makeActions());
    const detailHtml = await renderDetail(item, makeActions());

    expect(cardHtml).toContain('data-testid="plugin-store-item-menu"');
    expect(cardHtml).not.toContain('data-testid="plugin-store-enabled-switch"');
    expect(detailHtml).not.toContain('data-testid="plugin-store-enabled-switch"');
    expect(detailHtml).toContain('data-testid="plugin-store-item-menu"');
  });
});
