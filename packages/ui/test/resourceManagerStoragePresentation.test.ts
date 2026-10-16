import { describe, expect, it } from "vitest";
import type { StorageRootUsage } from "@zcode/shared";
import {
  buildStorageLegend,
  joinStoragePath,
  STORAGE_LEGEND_MAX_ITEMS,
  STORAGE_LEGEND_REST_COLOR,
  sumCategoriesAcrossRoots,
} from "@/resource-manager/storage/storageCategoryPresentation.js";

function root(
  id: StorageRootUsage["id"],
  sizes: Partial<Record<string, number>>,
): StorageRootUsage {
  const categories = Object.entries(sizes).map(([categoryId, bytes]) => ({
    id: categoryId as StorageRootUsage["categories"][number]["id"],
    bytes: bytes ?? 0,
    fileCount: bytes ? 1 : 0,
    cleanability: "none" as const,
    entries: [],
  }));
  return { id, path: `/${id}/.zcode`, volume: null, bytes: 0, fileCount: 0, categories };
}

describe("sumCategoriesAcrossRoots", () => {
  it("merges the same category across roots and sorts by bytes", () => {
    const totals = sumCategoriesAcrossRoots([
      root("home", { logs: 5, backups: 100 }),
      root("dataBaseDir", { logs: 7, other: 1 }),
    ]);
    expect(totals.map((item) => [item.id, item.bytes, item.fileCount])).toEqual([
      ["backups", 100, 1],
      ["logs", 12, 2],
      ["other", 1, 1],
    ]);
  });
});

describe("buildStorageLegend", () => {
  it("colors the largest categories and folds the rest into a grey item", () => {
    const sizes = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, index) => [id, 100 - index]),
    );
    const legend = buildStorageLegend(sumCategoriesAcrossRoots([root("home", sizes)]));
    expect(legend).toHaveLength(STORAGE_LEGEND_MAX_ITEMS + 1);
    expect(legend.at(-1)).toMatchObject({
      id: "rest",
      restCount: 2,
      color: STORAGE_LEGEND_REST_COLOR,
      bytes: 94 + 93,
    });
    expect(new Set(legend.slice(0, -1).map((item) => item.color)).size).toBe(
      STORAGE_LEGEND_MAX_ITEMS,
    );
  });

  it("skips empty categories", () => {
    expect(
      buildStorageLegend(sumCategoriesAcrossRoots([root("home", { logs: 0, backups: 3 })])),
    ).toEqual([expect.objectContaining({ id: "backups", bytes: 3 })]);
  });
});

describe("joinStoragePath", () => {
  it("joins with the root's own separator", () => {
    expect(joinStoragePath("/Users/u/.zcode/", "cli/debug")).toBe("/Users/u/.zcode/cli/debug");
    expect(joinStoragePath("C:\\Users\\u\\.zcode", "cli/debug/x.jsonl")).toBe(
      "C:\\Users\\u\\.zcode\\cli\\debug\\x.jsonl",
    );
  });
});
