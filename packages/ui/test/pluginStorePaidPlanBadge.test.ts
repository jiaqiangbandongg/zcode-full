import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// 与 pluginStoreInstalledStripTooltip.test.ts 同款：ControlHintTooltip 依赖 Root 的
// TooltipProvider，SSR 单测里桩成透传 span，把 title 落到属性上便于断言 hover 文案。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

// 付费套餐提示：市场目录条目的 `listing.requiresPaidPlan` 决定商店卡片与详情页标题
// 右侧是否出现渐变徽标。缺字段（无需套餐/老目录）时整个标记不渲染，
// 见 docs/plugin-marketplace-ui-ux.md「降级矩阵」。
function makeItem(requiresPaidPlan: boolean | undefined): StorePluginItem {
  return {
    id: "pro-plugin@zcode-plugins-official",
    name: "pro-plugin",
    marketplace: "zcode-plugins-official",
    installed: false,
    restorable: false,
    orphaned: false,
    listing: {
      displayName: "Pro Plugin",
      ...(requiresPaidPlan === undefined ? {} : { requiresPaidPlan }),
    },
  };
}

const actions: PluginStoreActions = {
  onOpenDetail: () => {},
  onInstall: () => {},
  onUninstall: () => {},
  onSetEnabled: () => {},
  onUpdate: () => {},
  operationId: null,
  togglingPluginId: null,
};

async function renderCard(
  item: StorePluginItem,
  locale: "en-US" | "zh-CN" = "en-US",
): Promise<string> {
  const { PluginStoreCard } = await import("../src/settings/PluginStoreCard.js");
  const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(PluginStoreCard, { item, actions, locale }),
    ),
  );
}

async function renderDetail(item: StorePluginItem): Promise<string> {
  const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
  const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreDetailView, {
        item,
        actions,
        onRetryDescribe: () => {},
        onUsePrompt: () => {},
      }),
    ),
  );
}

describe("plugin store paid plan badge", () => {
  it("marks a plugin that needs a paid plan on the store card title", async () => {
    const html = await renderCard(makeItem(true));
    expect(html).toContain('data-testid="plugin-store-paid-plan-badge"');
    expect(html).toContain("bg-[var(--color-plugin-paid-plan-badge)]");
    expect(html).toContain("text-[var(--color-plugin-paid-plan-badge-foreground)]");
    expect(html).not.toContain("button-gradient");
    expect(html).toContain("text-ui-sm");
    expect(html).toContain("lucide-crown");
    expect(html).toContain("Coding Plan");
    expect(html).toContain("lucide-crown");
    expect(html).not.toContain("lucide-trending-up");
    expect(html).toContain('data-tooltip-title="This plugin works better with a Coding Plan"');
  });

  it("marks a plugin that needs a paid plan on the detail title", async () => {
    const html = await renderDetail(makeItem(true));
    expect(html).toContain('data-testid="plugin-store-paid-plan-badge"');
    expect(html).toContain("bg-[var(--color-plugin-paid-plan-badge)]");
    expect(html).toContain("Coding Plan");
    expect(html).toContain('data-tooltip-title="This plugin works better with a Coding Plan"');
  });

  it("uses the concise coding plan label in Chinese", async () => {
    const html = await renderCard(makeItem(true), "zh-CN");
    expect(html).toContain("编程套餐");
    expect(html).not.toContain("支持编程套餐");
  });

  it("omits the badge when the plan is not required and when the field is absent", async () => {
    for (const requiresPaidPlan of [false, undefined] as const) {
      expect(await renderCard(makeItem(requiresPaidPlan))).not.toContain(
        "plugin-store-paid-plan-badge",
      );
      expect(await renderDetail(makeItem(requiresPaidPlan))).not.toContain(
        "plugin-store-paid-plan-badge",
      );
    }
  });
});
