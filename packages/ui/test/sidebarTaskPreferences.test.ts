import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_TASK_PREFERENCES_STORAGE_KEY,
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
} from "@/lib/sidebarTaskPreferences.js";

function createStorageMock(initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
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

describe("sidebarTaskPreferences", () => {
  it("默认使用 project 和 updated", () => {
    expect(readSidebarTaskPreferences(createStorageMock())).toEqual({
      organizeBy: "project",
      sortBy: "updated",
    });
  });

  it("持久化并恢复 timeline 和排序设置", () => {
    const storage = createStorageMock();

    persistSidebarTaskPreferences(
      { organizeBy: "chronological", sortBy: "created" },
      storage,
    );

    expect(readSidebarTaskPreferences(storage)).toEqual({
      organizeBy: "chronological",
      sortBy: "created",
    });
  });

  it("坏数据安全回退默认值", () => {
    const storage = createStorageMock({
      [SIDEBAR_TASK_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        organizeBy: "bad",
        sortBy: "wat",
      }),
    });

    expect(readSidebarTaskPreferences(storage)).toEqual({
      organizeBy: "project",
      sortBy: "updated",
    });
  });

  it("localStorage getter 抛错时读取默认值且写入不抛错", () => {
    installThrowingLocalStorageGetter();

    expect(readSidebarTaskPreferences()).toEqual({
      organizeBy: "project",
      sortBy: "updated",
    });
    expect(() =>
      persistSidebarTaskPreferences({ organizeBy: "chronological", sortBy: "created" }),
    ).not.toThrow();
  });
});
