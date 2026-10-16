import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY,
  persistGroupedTaskCollapsedGroupIds,
  readGroupedTaskCollapsedGroupIds,
} from "../src/lib/groupedTaskExpansionPreference.js";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function installThrowingLocalStorageGetter() {
  const windowStub = {};
  Object.defineProperty(windowStub, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  vi.stubGlobal("window", windowStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("groupedTaskExpansionPreference", () => {
  it("persists collapsed grouped task ids as local user display preference", () => {
    const storage = createMemoryStorage();

    persistGroupedTaskCollapsedGroupIds(new Set(["group-a", "group-b"]), storage);

    expect(storage.getItem(GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY)).toBe(
      JSON.stringify({ "group-a": true, "group-b": true }),
    );
    expect([...readGroupedTaskCollapsedGroupIds(storage)].sort()).toEqual([
      "group-a",
      "group-b",
    ]);
  });

  it("ignores malformed or expanded entries when restoring collapsed grouped task ids", () => {
    const storage = createMemoryStorage({
      [GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY]: JSON.stringify({
        "group-a": true,
        "group-b": false,
        "": true,
      }),
    });

    expect([...readGroupedTaskCollapsedGroupIds(storage)]).toEqual(["group-a"]);
  });

  it("falls back to no collapsed grouped task ids when storage contains invalid json", () => {
    const storage = createMemoryStorage({
      [GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY]: "{",
    });

    expect([...readGroupedTaskCollapsedGroupIds(storage)]).toEqual([]);
  });

  it("localStorage getter 抛错时读取空集合且写入不抛错", () => {
    installThrowingLocalStorageGetter();

    expect([...readGroupedTaskCollapsedGroupIds()]).toEqual([]);
    expect(() => persistGroupedTaskCollapsedGroupIds(new Set(["group-a"]))).not.toThrow();
  });
});
