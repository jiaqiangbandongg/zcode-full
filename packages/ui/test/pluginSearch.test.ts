import { describe, expect, it } from "vitest";
import type { ZCodePluginInfo } from "@zcode/shared";
import { storeItemMatches, type StorePluginItem } from "../src/settings/pluginStoreListing.js";
import { filterPluginsByQuery } from "../src/settings/pluginCapabilityProjection.js";

describe("plugin name pinyin search", () => {
  const plugin = { id: "lark@official", name: "lark", marketplace: "official" } as ZCodePluginInfo;
  const item: StorePluginItem = {
    ...plugin,
    installed: true,
    restorable: false,
    orphaned: false,
    listing: {
      displayName: "Lark CLI",
      displayNameI18n: { "zh-CN": "飞书 CLI" },
      descriptionI18n: { "zh-CN": "文档协作" },
    },
  };
  const items = new Map([[item.id, item]]);
  for (const locale of ["zh-CN", "en-US"]) {
    it(`matches Chinese names by full pinyin and initials in ${locale}`, () => {
      for (const query of ["feishu", " FEI SHU ", "fs", "飞书", "LARK", "official"]) {
        expect(storeItemMatches(item, query, locale), query).toBe(true);
        expect(filterPluginsByQuery([plugin], query, items, locale), query).toEqual([plugin]);
      }
    });
  }
  it("does not add fuzzy typos, description initials, or cross-market aliases", () => {
    for (const query of ["feisuh", "wdxz", "nonesuch"])
      expect(storeItemMatches(item, query, "zh-CN")).toBe(false);
    const other = { ...plugin, id: "lark@other", marketplace: "other" };
    expect(filterPluginsByQuery([other], "fs", items, "zh-CN")).toEqual([]);
    expect(
      filterPluginsByQuery(
        [plugin],
        "fs",
        new Map([[plugin.id, { ...item, id: other.id }]]),
        "zh-CN",
      ),
    ).toEqual([]);
  });
  it("supports Chinese raw names without listing metadata", () => {
    expect(
      storeItemMatches({ ...item, name: "文档助手", listing: undefined }, "wdzs", "en-US"),
    ).toBe(true);
  });
});
