import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCommandCenterSearchHistory,
  pushCommandCenterSearchHistory,
  readCommandCenterSearchHistory,
} from "@/command-center/commandCenterSearchHistory.js";

function createLocalStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
}

describe("commandCenterSearchHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageMock(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dedupes entries by query text across scopes", () => {
    pushCommandCenterSearchHistory({
      workspaceKey: "workspace-a",
      query: " auth ",
      scope: "files",
    });
    pushCommandCenterSearchHistory({
      workspaceKey: "workspace-a",
      query: "AUTH",
      scope: "files",
    });
    pushCommandCenterSearchHistory({
      workspaceKey: "workspace-a",
      query: "auth",
      scope: "commands",
    });

    expect(
      readCommandCenterSearchHistory("workspace-a").map((entry) => ({
        query: entry.query,
        scope: entry.scope,
      })),
    ).toEqual([{ query: "auth", scope: "commands" }]);
  });

  it("keeps at most 20 entries per workspace key", () => {
    for (let index = 0; index < 25; index += 1) {
      pushCommandCenterSearchHistory({
        workspaceKey: "workspace-a",
        query: `query-${index}`,
        scope: "all",
      });
    }

    const entries = readCommandCenterSearchHistory("workspace-a");
    expect(entries).toHaveLength(20);
    expect(entries[0]?.query).toBe("query-24");
    expect(entries.at(-1)?.query).toBe("query-5");
  });

  it("isolates and clears history by workspace key", () => {
    pushCommandCenterSearchHistory({
      workspaceKey: "workspace-a",
      query: "open settings",
      scope: "commands",
    });
    pushCommandCenterSearchHistory({
      workspaceKey: "workspace-b",
      query: "readme",
      scope: "files",
    });

    clearCommandCenterSearchHistory("workspace-a");

    expect(readCommandCenterSearchHistory("workspace-a")).toEqual([]);
    expect(readCommandCenterSearchHistory("workspace-b").map((entry) => entry.query)).toEqual([
      "readme",
    ]);
  });
});
