import { PlatformChannels } from "@zcode/shared";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => {
  const order: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const storage = {
    clearStorageData: vi.fn(async () => {
      order.push("clear");
    }),
    clearCache: vi.fn(async () => {
      order.push("cache");
    }),
  };
  return { order, handlers, storage };
});
vi.mock("electron", () => ({
  app: { getPath: () => "/fixture", getLocale: () => "en" },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler),
  },
  session: { fromPartition: () => state.storage },
  webContents: { fromId: () => ({ id: 1, isDestroyed: () => false, once: vi.fn() }) },
}));
vi.mock("node:fs/promises", () => ({ readdir: async () => [] }));
vi.mock("./session.js", () => ({ preparePluginSandboxSession: vi.fn() }));
vi.mock("./guestPolicy.js", () => ({
  attachPluginSandboxGuest: () => () => state.order.push("ports closed"),
  configurePluginSandboxGuest: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.order.length = 0;
  state.handlers.clear();
});

async function fixture() {
  const { installPluginSandboxHost } = await import("./host.js");
  const navigation = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  let destroyed = false;
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(() => {
      state.order.push("navigate");
      entered.resolve();
      return navigation.promise;
    }),
    close: vi.fn(() => {
      state.order.push("close");
      requested.resolve();
    }),
  });
  const host = installPluginSandboxHost({
    rendererDir: "/fixture",
    aliasDir: "/fixture",
    preloadPath: "/fixture",
  });
  const handle = host.registerFromHost({
    instance: { runtimeId: "fixture", generation: 1, token: "one", appIdentity: "a".repeat(64) },
    ownerWebContentsId: 1,
    sessionId: "session",
    pluginId: "plugin",
    scopeId: "scope",
    serverName: "server",
    html: "<html></html>",
  });
  host.attachGuest({ guest: guest as never, hostWebContents: { id: 1 } as never, ...handle });
  return {
    host,
    guest,
    navigation,
    entered,
    requested,
    destroy() {
      destroyed = true;
      state.order.push("destroyed");
      guest.emit("destroyed");
    },
    dispose(initId = handle.initId) {
      return state.handlers.get(PlatformChannels.PluginSandboxDispose)!(
        { sender: { id: 1 } },
        handle.sandboxId,
        initId,
      );
    },
  };
}

describe("MCP App browser data clearing order", () => {
  it("waits for the document to stop and the guest to close, while registration stays sealed", async () => {
    const f = await fixture();
    const clearing = f.host.clearBrowserData();
    await f.entered.promise;
    expect(f.guest.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    expect(() => f.host.registerFromHost({} as never)).toThrow("being cleared");
    const preventDefault = vi.fn();
    f.guest.emit("will-prevent-unload", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    f.navigation.resolve();
    await f.requested.promise;
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    f.destroy();
    await clearing;
    expect(state.order).toEqual([
      "ports closed",
      "navigate",
      "close",
      "destroyed",
      "clear",
      "cache",
    ]);
    expect(f.guest.listenerCount("will-prevent-unload")).toBe(0);
    expect(() => f.host.registerFromHost({} as never)).toThrow("being cleared");
  });

  it("joins an in-flight dispose instead of losing the still-running guest", async () => {
    const f = await fixture();
    let disposed = false;
    const disposal = Promise.resolve(f.dispose()).then(() => {
      disposed = true;
    });
    await f.entered.promise;
    const clearing = f.host.clearBrowserData();
    expect(disposed).toBe(false);
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    f.navigation.resolve();
    await f.requested.promise;
    f.destroy();
    await Promise.all([clearing, disposal]);
    expect(f.guest.loadURL).toHaveBeenCalledOnce();
    expect(f.guest.close).toHaveBeenCalledOnce();
    expect(state.storage.clearStorageData).toHaveBeenCalledOnce();
    expect(disposed).toBe(true);
  });

  it("fails clearing if a live document could not be stopped", async () => {
    const f = await fixture();
    const clearing = f.host.clearBrowserData();
    const rejected = expect(clearing).rejects.toThrow("navigation failed");
    await f.entered.promise;
    f.navigation.reject(new Error("navigation failed"));
    await rejected;
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    expect(state.storage.clearCache).not.toHaveBeenCalled();
    expect(f.guest.listenerCount("will-prevent-unload")).toBe(0);
    expect(() => f.host.registerFromHost({} as never)).toThrow("being cleared");
  });

  it("accepts navigation aborted by actual webview removal", async () => {
    const f = await fixture();
    const clearing = f.host.clearBrowserData();
    await f.entered.promise;
    f.destroy();
    f.navigation.reject(new Error("ERR_ABORTED"));
    await clearing;
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(state.storage.clearStorageData).toHaveBeenCalledOnce();
  });

  it("does not start stopping a guest for a stale initId", async () => {
    const f = await fixture();
    await f.dispose(0);
    expect(f.guest.loadURL).not.toHaveBeenCalled();
    expect(f.guest.close).not.toHaveBeenCalled();
    f.destroy();
  });
});
