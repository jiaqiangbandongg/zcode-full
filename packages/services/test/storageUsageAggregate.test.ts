import { describe, expect, it } from "vitest";
import { createStorageUsageAccumulator } from "../src/storage/domain/usageAggregate.js";
import { STORAGE_CATEGORY_IDS, STORAGE_MORE_ENTRIES_PATH } from "@zcode/shared";

const spec = { id: "home" as const, path: "/h/.zcode", hasCustomDataBaseDir: false };

describe("createStorageUsageAccumulator", () => {
  it("folds entries into every category with stable ordering and totals", () => {
    const acc = createStorageUsageAccumulator(spec);
    acc.add({ relativePath: "cli/debug/model-io-a.jsonl", bytes: 30, mtimeMs: 0 });
    acc.add({ relativePath: "cli/debug/model-io-b.jsonl", bytes: 70, mtimeMs: 0 });
    acc.add({ relativePath: "backup/one/x", bytes: 5, mtimeMs: 0 });
    acc.add({ relativePath: "backup/one/y", bytes: 5, mtimeMs: 0 });
    const usage = acc.snapshot(null);
    expect(usage.bytes).toBe(110);
    expect(usage.fileCount).toBe(4);
    expect(usage.categories.map((category) => category.id)).toEqual([...STORAGE_CATEGORY_IDS]);
    const trajectory = usage.categories.find((category) => category.id === "modelTrajectory");
    expect(trajectory).toMatchObject({ bytes: 100, fileCount: 2, cleanability: "safe" });
    expect(trajectory?.entries).toEqual([
      { relativePath: "cli/debug/model-io-b.jsonl", bytes: 70, fileCount: 1 },
      { relativePath: "cli/debug/model-io-a.jsonl", bytes: 30, fileCount: 1 },
    ]);
    const backups = usage.categories.find((category) => category.id === "backups");
    expect(backups?.entries).toEqual([{ relativePath: "backup/one", bytes: 10, fileCount: 2 }]);
    expect(usage.categories.find((category) => category.id === "logs")).toMatchObject({
      bytes: 0,
      fileCount: 0,
      entries: [],
    });
  });

  it("caps entries per category and folds the remainder", () => {
    const acc = createStorageUsageAccumulator(spec, { maxEntriesPerCategory: 2 });
    for (let index = 0; index < 5; index += 1) {
      acc.add({ relativePath: `cli/debug/model-io-${index}.jsonl`, bytes: index + 1, mtimeMs: 0 });
    }
    const entries = acc.snapshot(null).categories.find((c) => c.id === "modelTrajectory")?.entries;
    expect(entries).toEqual([
      { relativePath: "cli/debug/model-io-4.jsonl", bytes: 5, fileCount: 1 },
      { relativePath: "cli/debug/model-io-3.jsonl", bytes: 4, fileCount: 1 },
      { relativePath: STORAGE_MORE_ENTRIES_PATH, bytes: 6, fileCount: 3 },
    ]);
  });

  it("carries root spec and volume into the snapshot", () => {
    const volume = { deviceId: "9", mountPoint: "/", totalBytes: 10, freeBytes: 1 };
    expect(createStorageUsageAccumulator(spec).snapshot(volume)).toMatchObject({
      id: "home",
      path: "/h/.zcode",
      volume,
      bytes: 0,
    });
  });
});
