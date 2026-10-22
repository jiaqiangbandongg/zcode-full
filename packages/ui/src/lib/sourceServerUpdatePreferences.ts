import { useSyncExternalStore } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const STORAGE_KEY = "zcode-source-update-notifications-v1";

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function sourceServerUpdateKey(sourceServerId: string, version: string): string {
  return JSON.stringify([sourceServerId, version]);
}

/** 持久去重只控制主动提示，不隐藏仍可操作的设备更新状态。 */
export function createSourceServerUpdatePreferences(
  storage: StorageLike | null = browserStorage(),
) {
  const seen = new Set<string>();
  let deferred = new Set<string>();
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      const keys: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") seen.add(key);
    } catch {
      // 偏好损坏或存储不可访问时，本次运行仍保留内存去重。
    }
  };
  read();
  return {
    hasSeen(key: string) {
      read();
      return seen.has(key);
    },
    markSeen(key: string) {
      read();
      seen.add(key);
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify([...seen]));
      } catch {
        /* 存储失败不阻断更新操作。 */
      }
    },
    getDeferred: () => deferred,
    isDeferred: (key: string) => deferred.has(key),
    defer(key: string) {
      deferred = new Set(deferred).add(key);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// UI 偏好唯一 owner；面板挂载/卸载不会清除“稍后”，新运行只恢复持久去重。
export const sourceServerUpdatePreferences = createSourceServerUpdatePreferences();
export function useDeferredSourceServerUpdates(): ReadonlySet<string> {
  return useSyncExternalStore(
    sourceServerUpdatePreferences.subscribe,
    sourceServerUpdatePreferences.getDeferred,
    sourceServerUpdatePreferences.getDeferred,
  );
}
