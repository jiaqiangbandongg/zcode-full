import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPromptHistoryStorageKey,
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "../src/lib/promptHistoryStorage.js";

function createStorageMock(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));

  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

describe("prompt history storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("会按 workspace 分开持久化历史", () => {
    const storage = createStorageMock();

    persistPromptHistoryEntries("/tmp/workspace-a", ["first"], storage);
    persistPromptHistoryEntries("/tmp/workspace-b", ["second"], storage);

    expect(storage.getItem(getPromptHistoryStorageKey("/tmp/workspace-a"))).toBe(
      JSON.stringify(["first"]),
    );
    expect(storage.getItem(getPromptHistoryStorageKey("/tmp/workspace-b"))).toBe(
      JSON.stringify(["second"]),
    );
  });

  it("会从 localStorage 读回当前 workspace 的历史", () => {
    const storage = createStorageMock({
      [getPromptHistoryStorageKey("/tmp/workspace-a")]: JSON.stringify(["first", "second"]),
    });
    vi.stubGlobal("window", { localStorage: storage });

    expect(readPromptHistoryEntries("/tmp/workspace-a")).toEqual(["first", "second"]);
  });

  it("读取旧历史时不会清理或回写连续重复项", () => {
    const storage = createStorageMock({
      [getPromptHistoryStorageKey("/tmp/workspace-duplicates")]: JSON.stringify(["same", "same"]),
    });

    expect(readPromptHistoryEntries("/tmp/workspace-duplicates", storage)).toEqual([
      "same",
      "same",
    ]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("会忽略手工污染的空白项，并裁剪到最近 30 条", () => {
    const entries = Array.from({ length: 35 }, (_, index) => ` message-${index + 1} `);
    entries.splice(3, 0, "   ");
    const storage = createStorageMock();

    persistPromptHistoryEntries("/tmp/workspace-limit", entries, storage);

    expect(readPromptHistoryEntries("/tmp/workspace-limit", storage)).toHaveLength(30);
    expect(readPromptHistoryEntries("/tmp/workspace-limit", storage)[0]).toBe("message-6");
    expect(readPromptHistoryEntries("/tmp/workspace-limit", storage).at(-1)).toBe("message-35");
  });

  it("localStorage 里是坏数据时会安全回退为空数组", () => {
    const storage = createStorageMock({
      [getPromptHistoryStorageKey("/tmp/workspace-bad")]: "{broken json",
    });

    expect(readPromptHistoryEntries("/tmp/workspace-bad", storage)).toEqual([]);
  });
});
