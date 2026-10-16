// PLG（Picker 半区）UI 单测（docs/plugin-reference-mention.md §2/§5，
// docs/conversation-session-case-catalog.md PLG03/S01）：
// enabled 过滤、同名冲突禁选与原因、canonical markdown 载体、身份只在 destination、
// parseMentionMarkdown 的 plugin 分支不落 file/外链。
import { describe, expect, it } from "vitest";
import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import { mapPluginCatalogToMentionItemsForTest } from "../src/mentions/providers/pluginsMentionProvider.js";
import {
  coerceEnabledMentionIndex,
  getNextEnabledMentionIndex,
  shouldFreezeMentionRecalcWhileComposing,
} from "../src/mentions/MentionPlugin.js";
import {
  buildMentionMarkdown,
  buildPluginMentionMarkdown,
  parseMentionMarkdown,
} from "../src/mentions/mentionMarkdown.js";
import { normalizePromptMentionDisplayLabel } from "../src/mentions/promptMentionLabel.js";

import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { groupItemsByCategory, type StorePluginItem } from "@/settings/pluginStoreListing.js";

const LABELS = {
  conflictReason: "同名插件冲突，暂不可引用",
};

function entry(
  overrides: Partial<ZCodePluginReferenceCatalogEntry>,
): ZCodePluginReferenceCatalogEntry {
  return {
    pluginId: "demo@mkt-a",
    name: "demo",
    marketplace: "mkt-a",
    icon: "https://cdn.example.com/demo.png",
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: ["demo:search"],
    mcpServerNames: ["plugin:demo:main"],
    subagentNames: [],
    ...overrides,
  };
}

describe("plugins mention provider mapping", () => {
  it("按界面语言显示描述，缺翻译回退默认描述，旧 Host 留空", () => {
    const plugin = entry({
      description: "Default description",
      descriptionI18n: { "zh-CN": "处理文档", "en-US": "Work with documents" },
    });
    for (const [locale, description] of [
      ["zh-CN", "处理文档"],
      ["zh-TW", "处理文档"],
      ["en-US", "Work with documents"],
      ["fr-FR", "Default description"],
    ] as const) {
      const items = mapPluginCatalogToMentionItemsForTest([plugin], LABELS, locale);
      expect(items[0]?.description).toBe(description);
      expect(filterMentionItemsWithOptions(items, description)).toEqual([]);
    }
    expect(
      mapPluginCatalogToMentionItemsForTest([entry({})], LABELS, "en-US")[0]?.description,
    ).toBe("");
  });

  it("maps enabled catalog entries with the canonical plugin:// markdown carrier", () => {
    const items = mapPluginCatalogToMentionItemsForTest([entry({})], LABELS, "en-US");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "plugin:demo@mkt-a",
      category: "plugins",
      // label 固定 entry.name（chip/markdown 载体）；面板展示名 displayLabel 走全 app 统一的
      // resolvePluginDisplayName，无 listing 时回退 canonical 化 slug。
      label: "demo",
      displayLabel: "Demo",
      value: "demo@mkt-a",
      markdown: "[@demo](plugin://demo@mkt-a)",
      data: {
        pluginId: "demo@mkt-a",
        icon: "https://cdn.example.com/demo.png",
      },
    });
    expect(items[0]?.disabled).toBeUndefined();
  });

  it("resolves the localized display name for the picker but keeps label and markdown on entry.name", () => {
    const items = mapPluginCatalogToMentionItemsForTest(
      [
        entry({
          displayName: "Demo Plugin",
          displayNameI18n: { "zh-CN": "演示插件" },
        }),
      ],
      LABELS,
      "zh-CN",
    );
    expect(items[0]?.displayLabel).toBe("演示插件");
    // Bugfix：chip 节点复用 item.label、消息气泡按 markdown label 重建，二者必须同源；
    // 因此 label 与载体 label 固定 entry.name，不随 locale 变化，只有面板展示名本地化。
    expect(items[0]?.label).toBe("demo");
    expect(items[0]?.markdown).toBe("[@demo](plugin://demo@mkt-a)");
  });

  it("keeps every locale's display name searchable via keywords regardless of the active locale", () => {
    const items = mapPluginCatalogToMentionItemsForTest(
      [
        entry({
          displayName: "Demo Plugin",
          displayNameI18n: { "zh-CN": "演示插件" },
        }),
      ],
      LABELS,
      "en-US",
    );
    expect(items[0]?.displayLabel).toBe("Demo Plugin");
    expect(items[0]?.label).toBe("demo");
    // 英文界面下打中文也能搜到（常开双通道），英文 name/id 通道保持不变。
    expect(items[0]?.keywords).toEqual(
      expect.arrayContaining(["demo", "demo@mkt-a", "mkt-a", "Demo Plugin", "演示插件"]),
    );
  });

  it("filters out disabled catalog entries entirely", () => {
    const items = mapPluginCatalogToMentionItemsForTest(
      [entry({ enabled: false })],
      LABELS,
      "en-US",
    );
    expect(items).toHaveLength(0);
  });

  it("keeps conflicted plugins visible but disabled with a reason (fail closed)", () => {
    const items = mapPluginCatalogToMentionItemsForTest(
      [
        entry({ pluginId: "demo@mkt-a", conflictingPluginIds: ["demo@mkt-b"] }),
        entry({
          pluginId: "demo@mkt-b",
          marketplace: "mkt-b",
          conflictingPluginIds: ["demo@mkt-a"],
        }),
      ],
      LABELS,
      "en-US",
    );
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.disabled).toBe(true);
      expect(item.disabledReason).toBe(LABELS.conflictReason);
    }
  });

  it("never leaves keyboard selection on a conflicted plugin when another option is enabled", () => {
    const items = [
      { disabled: true },
      { disabled: true },
      { disabled: false },
      { disabled: false },
    ];
    expect(coerceEnabledMentionIndex(0, items)).toBe(2);
    expect(getNextEnabledMentionIndex(2, -1, items)).toBe(3);
    expect(getNextEnabledMentionIndex(3, 1, items)).toBe(2);
  });
});

describe("mention panel recalc during IME composition", () => {
  const DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36";

  it("freezes recalculation while a transforming IME (pinyin) is composing on desktop", () => {
    expect(shouldFreezeMentionRecalcWhileComposing(true, DESKTOP_UA)).toBe(true);
    expect(shouldFreezeMentionRecalcWhileComposing(false, DESKTOP_UA)).toBe(false);
  });

  it("keeps live filtering on Android where Gboard composes every Latin word", () => {
    // Android Chrome + Gboard 对英文单词也走 composition，冻结重算会让手机 Web 失去逐字过滤。
    expect(shouldFreezeMentionRecalcWhileComposing(true, ANDROID_UA)).toBe(false);
  });
});

describe("plugin mention markdown carrier", () => {
  it("serializes via buildMentionMarkdown using the stable id, not the label", () => {
    expect(
      buildMentionMarkdown({
        category: "plugins",
        label: "Fancy Display Name",
        value: "demo@mkt-a",
        data: { pluginId: "demo@mkt-a" },
      }),
    ).toBe("[@Fancy Display Name](plugin://demo@mkt-a)");
  });

  it("escapes markdown-sensitive label characters without touching the destination", () => {
    expect(buildPluginMentionMarkdown("we[i]rd", "demo@mkt-a")).toBe(
      "[@we\\[i\\]rd](plugin://demo@mkt-a)",
    );
  });

  it("parses plugin links into plugin chips, never file or external-link parts", () => {
    const parts = parseMentionMarkdown(
      "before [@Demo](plugin://demo@mkt-a) after [readme](./README.md)",
    );
    expect(parts).toEqual([
      { type: "text", text: "before " },
      { type: "plugin", label: "Demo", pluginId: "demo@mkt-a" },
      { type: "text", text: " after " },
      { type: "file", label: "readme" },
    ]);
  });

  it("keeps an invalid plugin destination display-only without exposing it as a catalog key", () => {
    expect(parseMentionMarkdown("[@Demo](plugin://demo@mkt?inject=1)")).toEqual([
      { type: "plugin", label: "Demo" },
    ]);
  });

  it("strips the @ prefix for plugin chip display labels", () => {
    expect(normalizePromptMentionDisplayLabel("plugins", "@demo", "demo@mkt-a")).toBe("demo");
  });
});

describe("输入框复用市场排序", () => {
  const official = "zcode-plugins-official";
  const entries = [
    entry({ pluginId: "personal@personal", marketplace: "personal" }),
    entry({ name: "b", pluginId: `b@${official}`, marketplace: official, category: "utilities" }),
    entry({ name: "a", pluginId: `a@${official}`, marketplace: official, category: "utilities" }),
    entry({
      name: "dev",
      pluginId: `dev@${official}`,
      marketplace: official,
      category: "developer-tools",
      conflictingPluginIds: ["dev@personal"],
    }),
    entry({
      name: "off",
      pluginId: `off@${official}`,
      marketplace: official,
      category: "utilities",
      enabled: false,
    }),
  ];
  it("配置重排官方，个人随后保序；不添加目录外插件或启用禁用项", () => {
    const result = mapPluginCatalogToMentionItemsForTest(entries, LABELS, "en-US", {
      categoryOrder: ["utilities", "developer-tools"],
      pluginOrder: { utilities: [`missing@${official}`, `b@${official}`] },
    });
    expect(result.map((x) => x.value)).toEqual([
      `b@${official}`,
      `a@${official}`,
      `dev@${official}`,
      "personal@personal",
    ]);
    expect(result[2]?.disabled).toBe(true);
  });
  it("无配置和旧 Host 没分类时保留发现顺序", () => {
    expect(
      mapPluginCatalogToMentionItemsForTest(entries, LABELS, "en-US").map((x) => x.value),
    ).toEqual(entries.filter((x) => x.enabled).map((x) => x.pluginId));
    const old = entries.map(({ category: _category, ...item }) => item);
    expect(
      mapPluginCatalogToMentionItemsForTest(old, LABELS, "en-US", {
        categoryOrder: ["utilities"],
      }).map((x) => x.value),
    ).toEqual(old.filter((x) => x.enabled).map((x) => x.pluginId));
  });
});

it("市场和 Picker 的官方子集同序，查询同分保序且匹配度优先", () => {
  const official = "zcode-plugins-official";
  const catalog = [
    entry({ name: "b", pluginId: `b@${official}`, marketplace: official, category: "guides" }),
    entry({ name: "a", pluginId: `a@${official}`, marketplace: official, category: "utilities" }),
    entry({
      name: "dev",
      pluginId: `dev@${official}`,
      marketplace: official,
      category: "developer-tools",
    }),
  ];
  for (const categoryOrder of [
    ["utilities", "developer-tools"],
    ["developer-tools", "utilities"],
  ]) {
    const order = { categoryOrder, pluginOrder: { utilities: [`b@${official}`] } };
    const picker = mapPluginCatalogToMentionItemsForTest(
      catalog,
      { conflictReason: "conflict" },
      "zh-CN",
      order,
    );
    const store = catalog.map(
      (x) =>
        ({
          id: x.pluginId,
          name: x.name,
          marketplace: x.marketplace,
          installed: true,
          restorable: false,
          orphaned: false,
          listing: { category: x.category },
        }) satisfies StorePluginItem,
    );
    expect(picker.map((x) => x.value)).toEqual(
      groupItemsByCategory(store, "zh-CN", order).flatMap((x) => x.items.map((y) => y.id)),
    );
    const sameScoreItems = picker.map((item) => ({
      ...item,
      keywords: [...(item.keywords ?? []), "same"],
    }));
    expect(filterMentionItemsWithOptions(sameScoreItems, "same").map((x) => x.value)).toEqual(
      picker.map((x) => x.value),
    );
    expect(filterMentionItemsWithOptions(picker, "dev").map((x) => x.value)).toEqual([
      `dev@${official}`,
    ]);
  }
  expect(catalog.map((x) => x.name)).toEqual(["b", "a", "dev"]);
});
