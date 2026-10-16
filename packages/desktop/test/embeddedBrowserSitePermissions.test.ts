import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbeddedBrowserSitePermissions,
  getEmbeddedBrowserSitePermission,
  getEmbeddedBrowserSitePermissionSnapshot,
  initEmbeddedBrowserSitePermissions,
  removeEmbeddedBrowserSitePermission,
  removeEmbeddedBrowserSitePermissionOrigin,
  resetEmbeddedBrowserSitePermissionsForTest,
  writeEmbeddedBrowserSitePermission,
} from "../src/main/embeddedBrowserSitePermissions.js";

function createStore() {
  const persisted: unknown[] = [];
  let loadResult: unknown = {};
  return {
    persisted,
    setLoadResult(value: unknown) {
      loadResult = value;
    },
    failPersist: false,
    store: {
      load: async () => loadResult,
      persist: async (record: unknown) => {
        if (createStoreFailFlag) throw new Error("disk full");
        persisted.push(record);
      },
    },
  };
}

let createStoreFailFlag = false;

describe("embeddedBrowserSitePermissions 管理器", () => {
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    resetEmbeddedBrowserSitePermissionsForTest();
    createStoreFailFlag = false;
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    resetEmbeddedBrowserSitePermissionsForTest();
  });

  it("init 加载 store 记录，get 支持同步读取（check handler 路径）", async () => {
    const harness = createStore();
    harness.setLoadResult({ "https://example.com": { media: "allow" } });
    await initEmbeddedBrowserSitePermissions({ store: harness.store, logger });

    expect(getEmbeddedBrowserSitePermission("https://example.com", "media")).toBe("allow");
    expect(getEmbeddedBrowserSitePermission("https://example.com", "geolocation")).toBeUndefined();
    expect(getEmbeddedBrowserSitePermission("https://other.com", "media")).toBeUndefined();
  });

  it("write 更新内存并落盘；remove 回到询问；clear 清空", async () => {
    const harness = createStore();
    await initEmbeddedBrowserSitePermissions({ store: harness.store, logger });

    await writeEmbeddedBrowserSitePermission("https://example.com", "media", "deny");
    expect(getEmbeddedBrowserSitePermission("https://example.com", "media")).toBe("deny");
    expect(harness.persisted).toHaveLength(1);

    await removeEmbeddedBrowserSitePermission("https://example.com", "media");
    expect(getEmbeddedBrowserSitePermission("https://example.com", "media")).toBeUndefined();
    expect(getEmbeddedBrowserSitePermissionSnapshot()).toEqual({});

    await writeEmbeddedBrowserSitePermission("https://a.com", "midi", "allow");
    await writeEmbeddedBrowserSitePermission("https://b.com", "midi", "deny");
    await clearEmbeddedBrowserSitePermissions();
    expect(getEmbeddedBrowserSitePermissionSnapshot()).toEqual({});
    // write(deny) + remove + write(a) + write(b) + clear 各落盘一次
    expect(harness.persisted).toHaveLength(5);
  });

  it("persist 失败不影响内存记录，仅 warn（重启回退到每次询问）", async () => {
    const harness = createStore();
    await initEmbeddedBrowserSitePermissions({ store: harness.store, logger });

    createStoreFailFlag = true;
    await writeEmbeddedBrowserSitePermission("https://example.com", "media", "allow");
    expect(getEmbeddedBrowserSitePermission("https://example.com", "media")).toBe("allow");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("init 不带 store 时纯内存运行", async () => {
    await initEmbeddedBrowserSitePermissions({ logger });
    await writeEmbeddedBrowserSitePermission("https://example.com", "media", "allow");
    expect(getEmbeddedBrowserSitePermission("https://example.com", "media")).toBe("allow");
    // 再次 init（带 store）时重置内存并加载持久记录
    const harness = createStore();
    harness.setLoadResult({ "https://persisted.com": { notifications: "deny" } });
    await initEmbeddedBrowserSitePermissions({ store: harness.store, logger });
    expect(getEmbeddedBrowserSitePermission("https://example.com", "media")).toBeUndefined();
    expect(getEmbeddedBrowserSitePermission("https://persisted.com", "notifications")).toBe("deny");
  });

  it("removeOrigin 清空单个站点全部决定，不影响其他站点", async () => {
    const harness = createStore();
    await initEmbeddedBrowserSitePermissions({ store: harness.store, logger });

    await writeEmbeddedBrowserSitePermission("https://a.com", "media", "allow");
    await writeEmbeddedBrowserSitePermission("https://a.com", "geolocation", "deny");
    await writeEmbeddedBrowserSitePermission("https://b.com", "media", "allow");
    await removeEmbeddedBrowserSitePermissionOrigin("https://a.com");

    expect(getEmbeddedBrowserSitePermissionSnapshot()).toEqual({ "https://b.com": { media: "allow" } });
    // 站点记录删空后 origin 键一并移除，快照不残留空对象
    expect(getEmbeddedBrowserSitePermission("https://a.com", "media")).toBeUndefined();
  });
});
