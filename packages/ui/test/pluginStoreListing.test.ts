import { describe, expect, it } from "vitest";
import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
} from "@zcode/shared";
import {
  buildStoreItems,
  canUpdatePluginItem,
  formatCanonicalPluginName,
  formatCanonicalMarketplaceName,
  groupItemsByCategory,
  resolveItemDisplayName,
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
  resolveLocalizedList,
  resolveLocalizedText,
  selectFeaturedItems,
  sortMarketplaceSources,
  sortInstalledStripItems,
  sortPersonalMarketplaceGroups,
} from "../src/settings/pluginStoreListing.js";

function makeSummary(
  overrides: Partial<ZCodeAvailablePluginSummary> & { id: string },
): ZCodeAvailablePluginSummary {
  const [name = "", marketplace = ""] = overrides.id.split("@");
  return {
    name,
    marketplace,
    installed: false,
    ...overrides,
  };
}

function makeInfo(overrides: Partial<ZCodePluginInfo> & { id: string }): ZCodePluginInfo {
  const [name = "", marketplace = ""] = overrides.id.split("@");
  return {
    name,
    marketplace,
    enabled: true,
    source: "cache",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    rootPath: `/cache/${name}`,
    ...overrides,
  };
}

function makeMarketplace(
  overrides: Partial<ZCodePluginMarketplaceSummary> & { id: string },
): ZCodePluginMarketplaceSummary {
  return {
    name: overrides.id,
    source: {},
    pluginCount: 0,
    ...overrides,
  };
}

describe("pluginStoreListing", () => {
  it("only falls back to a listing when the plugin name is unique", () => {
    const official = makeSummary({
      id: "computer-use@zcode-plugins-official",
      listing: { displayName: "Computer Use" },
    });
    const custom = makeSummary({
      id: "computer-use@custom-marketplace",
      listing: { displayName: "Custom CUA" },
    });

    expect(resolveUniquePluginListingByName([official], "computer-use")).toEqual(official.listing);
    expect(resolveUniquePluginListingByName([official, custom], "computer-use")).toBeUndefined();
  });

  it("prefers the official listing name over the internal plugin slug", () => {
    expect(
      resolvePluginDisplayName(
        {
          name: "computer-use",
          listing: {
            displayName: "Computer Use",
            displayNameI18n: { "zh-CN": "电脑控制" },
          },
        },
        "en-US",
      ),
    ).toBe("Computer Use");
    expect(
      resolvePluginDisplayName(
        {
          name: "computer-use",
          listing: {
            displayName: "Computer Use",
            displayNameI18n: { "zh-CN": "电脑控制" },
          },
        },
        "zh-CN",
      ),
    ).toBe("电脑控制");
    expect(resolvePluginDisplayName({ name: "third-party-tool" }, "en-US")).toBe(
      "Third Party Tool",
    );
  });

  it("formats marketplace slugs as display names", () => {
    expect(formatCanonicalMarketplaceName("zcode-plugins-official", "en-US")).toBe(
      "ZCode Plugins Official",
    );
    expect(formatCanonicalMarketplaceName("claude-plugins-official", "en-US")).toBe(
      "Claude Plugins Official",
    );
  });
  it("resolves localized text with exact locale then language-prefix fallback", () => {
    expect(resolveLocalizedText("zh-CN", "base", { "zh-CN": "精确" })).toBe("精确");
    expect(resolveLocalizedText("zh-CN", "base", { zh: "前缀" })).toBe("前缀");
    expect(resolveLocalizedText("en-US", "base", { en: "english" })).toBe("english");
    expect(resolveLocalizedText("en-US", "base", { "zh-CN": "中文" })).toBe("base");
    expect(resolveLocalizedList("zh-CN", ["base"], { zh: ["列表"] })).toEqual(["列表"]);
    expect(resolveLocalizedList("en-US", undefined, undefined)).toBeUndefined();
  });

  it("joins catalog, runtime, and installed records into store items", () => {
    const items = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({ id: "a@zcode-plugins-official", installed: true }),
        makeSummary({ id: "b@zcode-plugins-official" }),
      ],
      installedPlugins: [
        {
          id: "a@zcode-plugins-official",
          name: "a",
          marketplace: "zcode-plugins-official",
          enabled: true,
          scope: "user",
        } as ZCodeInstalledPluginSummary,
      ],
      plugins: [
        makeInfo({ id: "a@zcode-plugins-official" }),
        // 运行时独有（inline）插件也要出现在条目集合里。
        makeInfo({ id: "c@inline", source: "inline" }),
      ],
      restorableBuiltins: [makeSummary({ id: "d@zcode-plugins-official" })],
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("a@zcode-plugins-official")?.installed).toBe(true);
    expect(byId.get("a@zcode-plugins-official")?.info).toBeDefined();
    expect(byId.get("a@zcode-plugins-official")?.installedMeta).toBeDefined();
    expect(byId.get("b@zcode-plugins-official")?.installed).toBe(false);
    expect(byId.get("c@inline")?.installed).toBe(true);
    expect(byId.get("c@inline")?.orphaned).toBe(false);
    expect(byId.get("d@zcode-plugins-official")?.restorable).toBe(true);
  });

  it("merges a restorable built-in with its catalog entry instead of dropping detail metadata", () => {
    const [item] = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({
          id: "document-skills@zcode-plugins-official",
          listing: {
            category: "productivity",
            displayName: "Document Skills",
            descriptionI18n: { "en-US": "Work with documents" },
          },
        }),
      ],
      installedPlugins: [],
      plugins: [],
      restorableBuiltins: [makeSummary({ id: "document-skills@zcode-plugins-official" })],
    });

    expect(item).toMatchObject({
      id: "document-skills@zcode-plugins-official",
      installed: false,
      restorable: true,
      listing: {
        category: "productivity",
        displayName: "Document Skills",
      },
    });
  });

  it("does not treat a missing-package configuration projection as installed inventory", () => {
    const [item] = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "personal-market" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({
          id: "missing@personal-market",
          installed: true,
          marketplace: "personal-market",
        }),
      ],
      installedPlugins: [],
      plugins: [
        makeInfo({
          id: "missing@personal-market",
          packageStatus: "missing",
          rootPath: "",
          source: "missing",
        }),
      ],
      restorableBuiltins: [],
    });

    expect(item).toMatchObject({
      id: "missing@personal-market",
      installed: false,
      info: {
        packageStatus: "missing",
      },
    });
  });

  it("keeps marketplace ownership when a stale restorable marker overlaps an installed record", () => {
    const [item] = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({ id: "document-skills@zcode-plugins-official", installed: true }),
      ],
      installedPlugins: [
        {
          id: "document-skills@zcode-plugins-official",
          name: "document-skills",
          marketplace: "zcode-plugins-official",
          enabled: true,
          scope: "user",
        } as ZCodeInstalledPluginSummary,
      ],
      plugins: [makeInfo({ id: "document-skills@zcode-plugins-official", enabled: true })],
      restorableBuiltins: [makeSummary({ id: "document-skills@zcode-plugins-official" })],
    });

    expect(item).toMatchObject({
      id: "document-skills@zcode-plugins-official",
      installed: true,
      restorable: false,
      info: { enabled: true },
      installedMeta: { enabled: true },
    });
  });

  it("marks a cache install as orphaned when its known marketplace source is absent", () => {
    const [item] = buildStoreItems({
      marketplaces: [],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [],
      installedPlugins: [
        {
          id: "orphan@personal-market",
          name: "orphan",
          marketplace: "personal-market",
          enabled: true,
          scope: "user",
          updateStatus: "update-available",
        } as ZCodeInstalledPluginSummary,
      ],
      plugins: [makeInfo({ id: "orphan@personal-market" })],
      restorableBuiltins: [],
    });

    expect(item).toMatchObject({
      id: "orphan@personal-market",
      installed: true,
      orphaned: true,
    });
    expect(canUpdatePluginItem(item)).toBe(false);
  });

  it("does not infer orphaned from a missing catalog listing when the source still exists", () => {
    const installedMeta: ZCodeInstalledPluginSummary = {
      id: "installed@personal-market",
      name: "installed",
      marketplace: "personal-market",
      enabled: true,
      scope: "user",
      updateStatus: "update-available",
    };
    const [item] = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "personal-market" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [],
      installedPlugins: [installedMeta],
      plugins: [makeInfo({ id: "installed@personal-market" })],
      restorableBuiltins: [],
    });

    expect(item?.orphaned).toBe(false);
    expect(canUpdatePluginItem(item)).toBe(true);
  });

  it("does not turn missing configuration into an installable item without a catalog source", () => {
    const missing = makeInfo({
      id: "document-skills@zcode-plugins-official",
      source: "missing",
      packageStatus: "missing",
      rootPath: "",
    });
    const input = {
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [],
      installedPlugins: [],
      plugins: [missing],
      restorableBuiltins: [],
    };
    expect(buildStoreItems(input)).toEqual([]);
    // 配置诊断必须仍留给设置页，不能通过删源数据来掩盖商店误投影。
    expect(input.plugins).toEqual([missing]);
    expect(
      buildStoreItems({ ...input, availablePlugins: [makeSummary({ id: missing.id })] }),
    ).toEqual([
      expect.objectContaining({ id: missing.id, installed: false, summary: expect.any(Object) }),
    ]);
  });

  it("never marks official plugins as orphaned when the catalog listing is absent", () => {
    const [item] = buildStoreItems({
      marketplaces: [],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [],
      installedPlugins: [],
      plugins: [
        makeInfo({
          id: "builtin@zcode-plugins-official",
          source: "official",
        }),
      ],
      restorableBuiltins: [],
    });

    expect(item?.orphaned).toBe(false);
  });

  it("allows updates only when the installed item still has a marketplace source", () => {
    const installedMeta: ZCodeInstalledPluginSummary = {
      id: "plugin@personal-market",
      name: "plugin",
      marketplace: "personal-market",
      enabled: true,
      scope: "user",
      updateStatus: "update-available",
    };

    expect(canUpdatePluginItem({ installedMeta, orphaned: false })).toBe(true);
    expect(canUpdatePluginItem({ installedMeta, orphaned: true })).toBe(false);
    expect(
      canUpdatePluginItem({
        installedMeta: { ...installedMeta, updateStatus: "none" },
        orphaned: false,
      }),
    ).toBe(false);
  });

  it("selects featured items from public marketplaces in catalog order", () => {
    const items = buildStoreItems({
      marketplaces: [
        makeMarketplace({ id: "zcode-plugins-official" }),
        makeMarketplace({ id: "claude-plugins-official" }),
      ],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({ id: "alpha@zcode-plugins-official" }),
        makeSummary({ id: "beta@zcode-plugins-official" }),
        makeSummary({ id: "gamma@claude-plugins-official" }),
      ],
      installedPlugins: [],
      plugins: [],
      restorableBuiltins: [],
    });
    const publicItems = items.filter((item) => item.marketplace === "zcode-plugins-official");
    const featured = selectFeaturedItems(publicItems, [
      makeMarketplace({ id: "zcode-plugins-official", featured: ["beta", "missing", "alpha"] }),
      // 非公开市场的 featured 名单不参与。
      makeMarketplace({ id: "claude-plugins-official", featured: ["gamma"] }),
    ]);
    expect(featured.map((item) => item.name)).toEqual(["beta", "alpha"]);
  });

  it("orders category groups identically across locales with a fixed product order", () => {
    const items = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({ id: "a@zcode-plugins-official", listing: { category: "productivity" } }),
        makeSummary({ id: "b@zcode-plugins-official", listing: { category: "developer-tools" } }),
        makeSummary({ id: "c@zcode-plugins-official", listing: { category: "legal" } }),
        makeSummary({ id: "d@zcode-plugins-official", listing: { category: "template" } }),
        makeSummary({ id: "e@zcode-plugins-official", listing: { category: "utilities" } }),
        makeSummary({ id: "f@zcode-plugins-official", listing: { category: "zebra-unknown" } }),
        makeSummary({ id: "h@zcode-plugins-official", listing: { category: "finance" } }),
        makeSummary({ id: "g@zcode-plugins-official" }),
      ],
      installedPlugins: [],
      plugins: [],
      restorableBuiltins: [],
    });
    // 固定产品顺序：已知分类按 KNOWN_CATEGORY_ORDER，未知分类按 slug 排在其后，other 恒最后；
    // 与 UI locale 无关（旧实现按本地化标签排序，zh 拼音序与 en 字母序会得到不同分组顺序）。
    const expected = [
      "productivity",
      "developer-tools",
      "utilities",
      "finance",
      "legal",
      "template",
      "zebra-unknown",
      "other",
    ];
    for (const locale of ["zh-CN", "en-US"]) {
      expect(groupItemsByCategory(items, locale).map((group) => group.category)).toEqual(expected);
    }
  });

  it("prefers listing display name with locale resolution", () => {
    const [item] = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({
          id: "a@zcode-plugins-official",
          listing: { displayName: "Alpha", displayNameI18n: { "zh-CN": "阿尔法" } },
        }),
      ],
      installedPlugins: [],
      plugins: [],
      restorableBuiltins: [],
    });
    expect(item).toBeDefined();
    expect(resolveItemDisplayName(item!, "zh-CN")).toBe("阿尔法");
    expect(resolveItemDisplayName(item!, "en-US")).toBe("Alpha");
  });

  it("formats a canonical plugin name when no display name is configured", () => {
    const [item] = buildStoreItems({
      marketplaces: [makeMarketplace({ id: "zcode-plugins-official" })],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [
        makeSummary({
          id: "cloudbase-skills@zcode-plugins-official",
          name: "cloudbase-skills",
        }),
      ],
      installedPlugins: [],
      plugins: [],
      restorableBuiltins: [],
    });
    expect(item).toBeDefined();
    expect(resolveItemDisplayName(item!, "en-US")).toBe("Cloudbase Skills");
    expect(formatCanonicalPluginName("zcode-guide", "en-US")).toBe("ZCode Guide");
    expect(formatCanonicalPluginName("aws-mcp-server", "en-US")).toBe("AWS MCP Server");
    expect(formatCanonicalPluginName("AWS_mCp_tools", "en-US")).toBe("AWS MCP Tools");
  });

  it("sorts built-in and inline plugins first, then marketplace plugins by installedAt desc", () => {
    const items = buildStoreItems({
      marketplaces: [
        makeMarketplace({ id: "m" }),
        makeMarketplace({ id: "zcode-plugins-official" }),
      ],
      marketplaceAvailabilityKnown: true,
      availablePlugins: [],
      installedPlugins: [
        {
          id: "old@m",
          name: "old",
          marketplace: "m",
          enabled: true,
          scope: "user",
          installedAt: "2026-01-01T00:00:00Z",
        } as ZCodeInstalledPluginSummary,
        {
          id: "new@m",
          name: "new",
          marketplace: "m",
          enabled: true,
          scope: "user",
          installedAt: "2026-07-01T00:00:00Z",
        } as ZCodeInstalledPluginSummary,
        {
          id: "builtin@zcode-plugins-official",
          name: "builtin",
          marketplace: "zcode-plugins-official",
          enabled: true,
          scope: "user",
          installedAt: "2025-01-01T00:00:00Z",
        } as ZCodeInstalledPluginSummary,
      ],
      plugins: [
        makeInfo({ id: "old@m" }),
        makeInfo({ id: "new@m" }),
        makeInfo({ id: "inline@inline", source: "inline" }),
        makeInfo({ id: "builtin@zcode-plugins-official", source: "official" }),
      ],
      restorableBuiltins: [],
    });
    const sorted = sortInstalledStripItems(items, "en-US");
    expect(sorted.map((item) => item.name)).toEqual(["builtin", "inline", "new", "old"]);
  });

  it("orders personal marketplace groups by lastUpdated descending, sinking unknown to the end", () => {
    const groups = [
      { marketplace: "claude-plugins-official", title: "Claude Code Plugins", items: [] },
      { marketplace: "zcode-plugins-test", title: "zcode-plugins-test", items: [] },
      { marketplace: "never-refreshed", title: "never-refreshed", items: [] },
      { marketplace: "paid-demo-market", title: "paid-demo-market", items: [] },
    ];
    const sorted = sortPersonalMarketplaceGroups(
      groups,
      [
        makeMarketplace({ id: "claude-plugins-official", lastUpdated: "2026-01-01T00:00:00Z" }),
        makeMarketplace({ id: "zcode-plugins-test", lastUpdated: "2026-08-20T12:00:00Z" }),
        makeMarketplace({ id: "paid-demo-market", lastUpdated: "2026-08-20T12:00:00Z" }),
        // never-refreshed 无记录：没有 lastUpdated，按缺失沉底。
      ],
      "en-US",
    );
    expect(sorted.map((group) => group.marketplace)).toEqual([
      // 最近刷新的在前；同刻（zcode-plugins-test / paid-demo-market）按显示名字母序。
      "paid-demo-market",
      "zcode-plugins-test",
      "claude-plugins-official",
      "never-refreshed",
    ]);
  });

  it("pins official sources and sorts custom sources by lastUpdated", () => {
    const sorted = sortMarketplaceSources(
      [
        makeMarketplace({
          id: "never-refreshed",
          name: "Never Refreshed",
        }),
        makeMarketplace({
          id: "zcode-plugins-test",
          name: "zcode-plugins-test",
          lastUpdated: "2026-08-20T12:00:00Z",
        }),
        makeMarketplace({
          id: "claude-plugins-official",
          name: "claude-plugins-official",
          lastUpdated: "2026-01-01T00:00:00Z",
        }),
        makeMarketplace({
          id: "zcode-plugins-official",
          name: "zcode-plugins-official",
          lastUpdated: "2026-08-20T23:00:00Z",
        }),
        makeMarketplace({
          id: "zcode-labs",
          name: "zcode-labs",
          lastUpdated: "2026-08-20T12:00:00Z",
        }),
      ],
      "en-US",
    );

    expect(sorted.map((marketplace) => marketplace.id)).toEqual([
      "zcode-plugins-official",
      "claude-plugins-official",
      "zcode-labs",
      "zcode-plugins-test",
      "never-refreshed",
    ]);
  });
});

describe("document plugin default order", () => {
  const names = ["pdf", "presentations", "spreadsheets", "documents"];
  const ids = names.map((name) => `${name}@zcode-plugins-official`);
  const items = buildStoreItems({
    marketplaces: [],
    installedPlugins: [],
    restorableBuiltins: [],
    availablePlugins: ["aaa", ...names.toReversed()].map((name) =>
      makeSummary({
        id: `${name}@zcode-plugins-official`,
        installed: true,
        listing: { category: "productivity" },
      }),
    ),
    plugins: ["aaa", ...names].map((name) =>
      makeInfo({
        id: `${name}@zcode-plugins-official`,
        source: "official",
        enabled: false,
      }),
    ),
  });
  it.each(["en-US", "zh-CN"])(
    "pins documents across installed and category views in %s",
    (locale) => {
      expect(
        sortInstalledStripItems(items, locale)
          .slice(0, 4)
          .map((item) => item.id),
      ).toEqual(ids);
      expect(
        groupItemsByCategory(items, locale)[0]
          ?.items.slice(0, 4)
          .map((item) => item.id),
      ).toEqual(ids);
      expect(items[0]?.name).toBe("aaa");
    },
  );
  it("retains explicit server priority and skips absent document plugins", () => {
    const groups = groupItemsByCategory(
      items.filter((item) => item.name !== "pdf"),
      "en-US",
      {
        pluginOrder: { productivity: ["aaa@zcode-plugins-official"] },
      },
    );
    expect(groups[0]?.items.map((item) => item.name)).toEqual([
      "aaa",
      "presentations",
      "spreadsheets",
      "documents",
    ]);
  });
  it("does not pin personal plugins with the same name", () => {
    const personal = items.map((item) => ({
      ...item,
      id: `${item.name}@personal`,
      marketplace: "personal",
    }));
    expect(sortInstalledStripItems(personal, "en-US")[0]?.name).toBe("aaa");
  });
});
