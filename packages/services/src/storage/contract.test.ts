import { describe, expect, it } from "vitest";
import { Emitter } from "@zcode/rpc";
import { groupStorageRootsByVolume, STORAGE_CATEGORY_IDS } from "@zcode/shared";
import {
  type IStorageService,
  type StorageRootUsage,
  type StorageUsageSnapshot,
} from "./contract.js";
import { useStorageSection } from "./contract.example.js";

function root(overrides: Partial<StorageRootUsage>): StorageRootUsage {
  return {
    id: "home",
    path: "/home/u/.zcode",
    volume: null,
    bytes: 0,
    fileCount: 0,
    categories: [],
    ...overrides,
  };
}

describe("storage contract", () => {
  it("keeps the category list closed with other as the fallback", () => {
    expect(STORAGE_CATEGORY_IDS.at(-1)).toBe("other");
    expect(new Set(STORAGE_CATEGORY_IDS).size).toBe(STORAGE_CATEGORY_IDS.length);
  });

  it("groups roots by device id and keeps unprobed roots separate", () => {
    const volume = { deviceId: "1", mountPoint: "/", totalBytes: 100, freeBytes: 10 };
    const groups = groupStorageRootsByVolume([
      root({ id: "home", bytes: 5, volume }),
      root({ id: "dataBaseDir", path: "/data/.zcode", bytes: 7, volume }),
      root({ id: "dataBaseDir", path: "/x/.zcode", bytes: 1 }),
    ]);
    expect(groups.map((group) => [group.key, group.bytes, group.roots.length])).toEqual([
      ["dev:1", 12, 2],
      ["path:/x/.zcode", 1, 1],
    ]);
  });

  it("example consumer only renders snapshots of the current job and cancels on leave", async () => {
    const emitter = new Emitter<StorageUsageSnapshot>();
    const calls: string[] = [];
    let jobCounter = 0;
    const fake: IStorageService = {
      startScan: async () => ({ jobId: `job-${++jobCounter}` }),
      cancelScan: async (jobId) => {
        calls.push(`cancel:${jobId}`);
      },
      getSnapshot: async () => null,
      onScanProgress: emitter.event,
      clean: async () => ({ freedBytes: 1, deletedCount: 1, skippedCount: 0, failures: [] }),
      dispose: () => {},
    };
    const rendered: string[] = [];
    const section = await useStorageSection(fake, (snapshot) => rendered.push(snapshot.jobId));
    const snapshot = (jobId: string): StorageUsageSnapshot => ({
      jobId,
      status: "scanning",
      startedAt: 0,
      roots: [],
      errors: [],
    });
    emitter.fire(snapshot("job-0"));
    emitter.fire(snapshot("job-1"));
    await section.cleanTrajectories();
    emitter.fire(snapshot("job-1"));
    emitter.fire(snapshot("job-2"));
    await section.leave();
    expect(rendered).toEqual(["job-1", "job-2"]);
    expect(calls).toEqual(["cancel:job-2"]);
  });
});
