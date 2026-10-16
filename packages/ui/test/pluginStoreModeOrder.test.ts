import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  groupItemsByCategory,
  KNOWN_CATEGORY_LABEL_IDS,
  type StorePluginItem,
} from "../src/settings/pluginStoreListing.js";

function item(name: string, category?: string): StorePluginItem {
  return {
    id: `${name}@official`,
    name,
    marketplace: "official",
    installed: false,
    restorable: false,
    orphaned: false,
    listing: { category },
  };
}

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

describe("公开分类排序", () => {
  it("详情页也将旧指南分类显示为实用工具", async () => {
    const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
    const html = renderToStaticMarkup(
      createElement(PluginStoreDetailView, {
        item: item("zcode-guide", "guides"),
        actions: {
          onOpenDetail() {},
          onInstall() {},
          onUninstall() {},
          onSetEnabled() {},
          onUpdate() {},
          operationId: null,
          togglingPluginId: null,
        },
        onRetryDescribe() {},
        onUsePrompt() {},
      }),
    );
    expect(html).toContain("settings.plugins.store.category.utilities");
  });
  it("旧指南类目并入实用工具且不改变插件身份，legal 无插件时不显示", () => {
    const entries = [item("zcode-guide", "guides"), item("skill-creator", "utilities")];
    const groups = groupItemsByCategory(entries, "zh-CN", {
      categoryOrder: ["legal", "guides", "utilities"],
    });
    expect(groups.map((group) => group.category)).toEqual(["utilities"]);
    expect(groups[0]?.items.map((entry) => entry.id).sort()).toEqual(
      entries.map((entry) => entry.id).sort(),
    );
    expect(entries[0]?.listing?.category).toBe("guides");
    expect(KNOWN_CATEGORY_LABEL_IDS.legal).toBe("settings.plugins.store.category.legal");
    expect(KNOWN_CATEGORY_LABEL_IDS.guides).toBeUndefined();
  });

  it("未来法律插件可按服务端分类及插件顺序展示", () => {
    const groups = groupItemsByCategory(
      [item("contract", "legal"), item("research", "legal"), item("util", "utilities")],
      "en-US",
      {
        categoryOrder: ["legal", "utilities"],
        pluginOrder: { legal: ["research@official", "contract@official"] },
      },
    );
    expect(groups.map((group) => group.category)).toEqual(["legal", "utilities"]);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(["research", "contract"]);
  });
  it("未知分类碰巧与对象原型属性同名时仍可使用默认排序", () => {
    const entries = [item("b", "constructor"), item("a", "constructor")];
    expect(
      groupItemsByCategory(entries, "en-US", { pluginOrder: {} })[0]?.items.map(
        (entry) => entry.name,
      ),
    ).toEqual(["a", "b"]);
  });
  const items = [
    item("z", "productivity"),
    item("a", "productivity"),
    item("b", "developer-tools"),
    item("c"),
    item("d", "unknown"),
  ];

  it("分类及分类内插件独立排序，未配置项保留默认，显式 other 可置顶", () => {
    const before = structuredClone(items);
    const groups = groupItemsByCategory(items, "en-US", {
      categoryOrder: ["missing", "other", "developer-tools", "other"],
      pluginOrder: { productivity: ["missing@official", "z@official", "z@official"] },
    });
    expect(groups.map((group) => group.category)).toEqual([
      "other",
      "developer-tools",
      "productivity",
      "unknown",
    ]);
    expect(groups[2]?.items.map((entry) => entry.name)).toEqual(["z", "a"]);
    expect(items).toEqual(before);
  });

  it.each(["zh-CN", "en-US"])("无配置保持原排序 %s", (locale) => {
    const groups = groupItemsByCategory(items, locale);
    expect(groups.map((group) => group.category)).toEqual([
      "productivity",
      "developer-tools",
      "unknown",
      "other",
    ]);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(["a", "z"]);
  });

  it("ID 必须完整匹配，不能跨分类搬动或加入插件", () => {
    const groups = groupItemsByCategory(items, "en-US", {
      pluginOrder: { productivity: ["z", "z@personal", "b@official"] },
    });
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(["a", "z"]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(items.length);
  });
});
