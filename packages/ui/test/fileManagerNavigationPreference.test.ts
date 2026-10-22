import type { IBroadcastService } from "@zcode/services";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createZCodeStore,
  FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
} from "@/store/index.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        contains: () => false,
        toggle: () => {},
      },
    },
  },
});

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

function isNavigationOpen(
  store: ReturnType<typeof createZCodeStore>,
  workspaceKey: string,
): boolean {
  return store.getState().fileManagerNavigationOpenByWorkspace[workspaceKey] ?? true;
}

describe("file manager navigation preference", () => {
  beforeEach(() => {
    localStorageState.clear();
  });

  it("同一 workspace 跨 store 重建恢复最后显隐状态", () => {
    const firstStore = createZCodeStore(mockBroadcastService);

    firstStore.getState().setFileManagerNavigationOpen("workspace-a", false);

    expect(isNavigationOpen(firstStore, "workspace-a")).toBe(false);
    expect(isNavigationOpen(createZCodeStore(mockBroadcastService), "workspace-a")).toBe(false);
  });

  it("不同 workspace 各自保存显隐状态", () => {
    const store = createZCodeStore(mockBroadcastService);

    store.getState().setFileManagerNavigationOpen("workspace-a", false);

    expect(isNavigationOpen(store, "workspace-a")).toBe(false);
    expect(isNavigationOpen(store, "workspace-b")).toBe(true);

    store.getState().setFileManagerNavigationOpen("workspace-b", false);
    store.getState().setFileManagerNavigationOpen("workspace-a", true);

    expect(isNavigationOpen(store, "workspace-a")).toBe(true);
    expect(isNavigationOpen(store, "workspace-b")).toBe(false);
  });

  it("损坏或非法持久化数据回退为默认展开", () => {
    localStorageState.set(FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY, "not-json");
    expect(isNavigationOpen(createZCodeStore(mockBroadcastService), "workspace-a")).toBe(true);

    localStorageState.set(
      FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ "workspace-a": "false", "workspace-b": false }),
    );
    const store = createZCodeStore(mockBroadcastService);

    expect(isNavigationOpen(store, "workspace-a")).toBe(true);
    expect(isNavigationOpen(store, "workspace-b")).toBe(false);
  });
});
