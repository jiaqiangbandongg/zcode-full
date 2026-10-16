import { describe, expect, it, vi } from "vitest";
import {
  buildLocalMediaPreviewUrl,
  createLocalMediaPreviewPathRegistry,
  installLocalMediaPreviewProtocol,
  registerLocalMediaPreviewScheme,
} from "../src/main/localMediaPreviewProtocol.js";

describe("localMediaPreviewProtocol", () => {
  it("registers a standard streaming secure scheme before app ready", () => {
    const protocol = { registerSchemesAsPrivileged: vi.fn() };
    registerLocalMediaPreviewScheme(protocol);
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "zcode-media",
        privileges: { standard: true, secure: true, stream: true },
      },
    ]);
  });

  it.each([
    "/Users/test/.zcode/cli/video-cache/session/demo.mov",
    "C:\\Users\\test\\.zcode\\cli\\video-cache\\session\\demo.mp4",
    "\\\\server\\share\\demo.avi",
  ])("passes an exactly authorized media path to Electron's file loader: %s", async (path) => {
    let handler:
      | ((request: { url: string }, callback: (response: unknown) => void) => void)
      | undefined;
    const protocol = {
      registerFileProtocol: vi.fn(
        (
          _scheme: string,
          next: (request: { url: string }, callback: (response: unknown) => void) => void,
        ) => {
          handler = next;
          return true;
        },
      ),
    };
    const registry = createLocalMediaPreviewPathRegistry({
      isAbsolutePath: () => true,
      realpath: async (value) => value,
      realpathSync: (value) => value,
      isRegularFileSync: () => true,
    });
    const authorizedPath = await registry.authorize(path);
    installLocalMediaPreviewProtocol(protocol, {
      isPathAuthorized: registry.isAuthorized,
    });

    const callback = vi.fn();
    handler?.({ url: buildLocalMediaPreviewUrl(authorizedPath) }, callback);
    expect(callback).toHaveBeenCalledWith(authorizedPath);
  });

  it("canonicalizes a Host-authorized path and rejects the original alias", async () => {
    const registry = createLocalMediaPreviewPathRegistry({
      isAbsolutePath: () => true,
      realpath: async () => "/real/video.mp4",
      realpathSync: () => "/real/video.mp4",
      isRegularFileSync: () => true,
    });

    await expect(registry.authorize("/linked/video.mp4")).resolves.toBe("/real/video.mp4");
    expect(registry.isAuthorized("/real/video.mp4")).toBe(true);
    expect(registry.isAuthorized("/linked/video.mp4")).toBe(false);
  });

  it("rejects malformed and unauthorized absolute preview URLs", () => {
    let handler:
      | ((request: { url: string }, callback: (response: unknown) => void) => void)
      | undefined;
    const protocol = {
      registerFileProtocol: vi.fn(
        (
          _scheme: string,
          next: (request: { url: string }, callback: (response: unknown) => void) => void,
        ) => {
          handler = next;
          return true;
        },
      ),
    };
    installLocalMediaPreviewProtocol(protocol, { isPathAuthorized: () => false });

    for (const url of [
      "zcode-media://local/not-absolute",
      buildLocalMediaPreviewUrl("/etc/passwd"),
      "zcode-media://other/value",
    ]) {
      const callback = vi.fn();
      handler?.({ url }, callback);
      expect(callback).toHaveBeenCalledWith({ error: -300 });
    }
  });

  it("rejects relative paths before registering them", async () => {
    const registry = createLocalMediaPreviewPathRegistry({
      isAbsolutePath: (path) => path.startsWith("/"),
      realpath: async (path) => path,
    });

    await expect(registry.authorize("relative/demo.mp4")).rejects.toThrow(
      "Local media preview path must be absolute",
    );
  });

  it("expires authorized paths and supports explicit clear", async () => {
    let now = 1_000;
    const registry = createLocalMediaPreviewPathRegistry({
      isAbsolutePath: () => true,
      now: () => now,
      ttlMs: 100,
      realpath: async (path) => path,
      realpathSync: (path) => path,
      isRegularFileSync: () => true,
    });
    await registry.authorize("/workspace/video.mp4");
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(true);
    now += 90;
    await registry.authorize("/workspace/video.mp4");
    now += 20;
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(true);
    now += 81;
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(false);

    await registry.authorize("/workspace/video.mp4");
    registry.clear();
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(false);
  });

  it("evicts the least recently used authorization at capacity", async () => {
    let now = 1_000;
    const registry = createLocalMediaPreviewPathRegistry({
      isAbsolutePath: () => true,
      now: () => now,
      ttlMs: 10_000,
      maxEntries: 2,
      realpath: async (path) => path,
      realpathSync: (path) => path,
      isRegularFileSync: () => true,
    });
    await registry.authorize("/workspace/a.mp4");
    now += 1;
    await registry.authorize("/workspace/b.mp4");
    now += 1;
    expect(registry.isAuthorized("/workspace/a.mp4")).toBe(true);
    now += 1;
    await registry.authorize("/workspace/c.mp4");

    expect(registry.isAuthorized("/workspace/a.mp4")).toBe(true);
    expect(registry.isAuthorized("/workspace/b.mp4")).toBe(false);
    expect(registry.isAuthorized("/workspace/c.mp4")).toBe(true);
  });

  it("rejects an authorized path whose real target or file type changed", async () => {
    let currentRealpath = "/workspace/video.mp4";
    let regularFile = true;
    const registry = createLocalMediaPreviewPathRegistry({
      isAbsolutePath: () => true,
      realpath: async () => "/workspace/video.mp4",
      realpathSync: () => currentRealpath,
      isRegularFileSync: () => regularFile,
    });
    await registry.authorize("/workspace/video.mp4");
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(true);

    currentRealpath = "/private/sensitive.txt";
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(false);

    currentRealpath = "/workspace/video.mp4";
    regularFile = false;
    await registry.authorize("/workspace/video.mp4");
    expect(registry.isAuthorized("/workspace/video.mp4")).toBe(false);
  });
});
