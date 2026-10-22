import { PlatformChannels } from "@zcode/shared";
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  acquire: vi.fn(),
  release: vi.fn(),
  markPrepared: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getLocale: () => "en" },
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  ipcMain: { handle: (name: string, handler: any) => state.handlers.set(name, handler) },
  session: { fromPartition: () => ({}) },
  webContents: { fromId: () => ({ id: 1, isDestroyed: () => false, once: vi.fn() }) },
}));
vi.mock("@desktop/main/pluginSandbox/session.js", () => ({ preparePluginSandboxSession: vi.fn() }));
vi.mock("@desktop/main/pluginSandbox/guestPolicy.js", () => ({
  attachPluginSandboxGuest: () => () => {},
}));
vi.mock("@desktop/main/browserView/browserScreenshotActivityController.js", () => ({
  DesktopBrowserScreenshotActivityController: class {
    acquire = state.acquire;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.handlers.clear();
  state.acquire.mockReturnValue({ release: state.release, markPrepared: state.markPrepared });
});

it.each([false, true])(
  "retains an early execution request through loading; canceled=%s",
  async (cancel) => {
    const { installPluginSandboxHost } = await import("@desktop/main/pluginSandbox/host.js");
    let loading = true;
    const guest = Object.assign(new EventEmitter(), {
      id: 2,
      hostWebContents: { id: 1 },
      isDestroyed: () => false,
      isLoadingMainFrame: () => loading,
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
    const request = (active: boolean) =>
      state.handlers.get(PlatformChannels.PluginSandboxExecutionActive)!(
        { sender: { id: 1 } },
        handle.sandboxId,
        handle.initId,
        active,
      );
    request(true);
    host.attachGuest({ guest: guest as never, hostWebContents: { id: 1 } as never, ...handle });
    guest.emit("dom-ready");
    guest.emit("did-finish-load");
    expect(state.acquire).not.toHaveBeenCalled();
    if (cancel) request(false);
    loading = false;
    guest.emit("did-stop-loading");
    guest.emit("did-stop-loading");
    expect(state.acquire).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(state.markPrepared).toHaveBeenCalledTimes(cancel ? 0 : 1);
    guest.emit("destroyed");
    expect(state.release).toHaveBeenCalledTimes(cancel ? 0 : 1);
  },
);
