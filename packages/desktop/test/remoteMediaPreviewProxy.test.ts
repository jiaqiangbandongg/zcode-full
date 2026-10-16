import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IFileService } from "@zcode/services";
import {
  createRemoteMediaPreviewProxy,
  waitForDrainOrDisconnect,
} from "../src/host/remoteMediaPreviewProxy.js";

function createFileService(): IFileService {
  const content = Buffer.from("0123456789", "utf8");
  return {
    resolvePath: vi.fn(async ({ path }: { path: string }) => path),
    stat: vi.fn(async ({ path }: { path: string }) => ({
      path,
      type: "file" as const,
      size: content.length,
    })),
    readFileRange: vi.fn(
      async ({ offset, length }: { offset: number; length: number }) =>
        new Uint8Array(content.subarray(offset, offset + length)),
    ),
    readMediaPreview: vi.fn(),
  } as unknown as IFileService;
}

describe("remote media preview range proxy", () => {
  it("settles a backpressure wait when the client closes before drain", async () => {
    const request = Object.assign(new EventEmitter(), { aborted: false });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });

    const pending = waitForDrainOrDisconnect(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    response.emit("close");

    await expect(pending).resolves.toBe("closed");
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("settles immediately when the request was already aborted", async () => {
    const request = Object.assign(new EventEmitter(), { aborted: true });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });

    await expect(
      waitForDrainOrDisconnect(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      ),
    ).resolves.toBe("closed");
  });

  it("serves a scoped remote file with native HTTP Range semantics", async () => {
    const fileService = createFileService();
    const proxy = createRemoteMediaPreviewProxy({
      fileService,
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });

    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    if (!("previewId" in prepared)) throw new Error("expected host range preview");
    expect(prepared.kind).toBe("host-range-url");
    expect(prepared.url).toMatch(/^http:\/\/127\.0\.0\.1:/u);

    const response = await fetch(prepared.url, {
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
    const head = await fetch(prepared.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    expect(fileService.readMediaPreview).not.toHaveBeenCalled();

    await proxy.dispose();
  });

  it("rejects paths outside the attached remote workspace before creating a lease", async () => {
    const proxy = createRemoteMediaPreviewProxy({
      fileService: createFileService(),
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });

    await expect(
      proxy.service.prepare({
        path: "/remote/other/video.mp4",
        expectedKind: "video",
      }),
    ).rejects.toThrow(/outside remote workspace/);

    await proxy.dispose();
  });

  it("returns 416 for malformed or multi-range requests", async () => {
    const proxy = createRemoteMediaPreviewProxy({
      fileService: createFileService(),
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });

    await expect(
      fetch(prepared.url, { headers: { Range: "bytes=0-1,4-5" } }),
    ).resolves.toMatchObject({ status: 416 });
    await proxy.dispose();
  });

  it("rotates the playback token on refresh and releases the lease", async () => {
    const proxy = createRemoteMediaPreviewProxy({
      fileService: createFileService(),
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    if (!("previewId" in prepared) || !proxy.service.refreshPlaybackUrl || !proxy.service.release) {
      throw new Error("host range preparation did not expose lifecycle operations");
    }
    const refreshed = await proxy.service.refreshPlaybackUrl({ previewId: prepared.previewId });
    expect(refreshed.url).not.toBe(prepared.url);
    await proxy.service.release({ previewId: prepared.previewId });
    await expect(fetch(refreshed.url)).resolves.toMatchObject({ status: 404 });
    await proxy.dispose();
  });

  it("invalidates a lease when the remote file size changes", async () => {
    const fileService = createFileService();
    const stat = vi.mocked(fileService.stat);
    const proxy = createRemoteMediaPreviewProxy({
      fileService,
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    stat.mockResolvedValueOnce({ path: prepared.path, type: "file", size: 11 });
    await expect(fetch(prepared.url)).resolves.toMatchObject({ status: 409 });
    await proxy.dispose();
  });

  it("reserves the per-lease request slot before awaiting remote stat", async () => {
    const fileService = createFileService();
    const stat = vi.mocked(fileService.stat);
    let releaseFirstStat: ((value: { path: string; type: "file"; size: number }) => void) | null =
      null;
    stat.mockImplementationOnce(async ({ path }) => ({ path, type: "file", size: 10 }));
    stat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstStat = resolve;
        }),
    );
    stat.mockImplementation(async ({ path }) => ({ path, type: "file", size: 10 }));
    const proxy = createRemoteMediaPreviewProxy({
      fileService,
      maxConcurrentRequests: 1,
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });

    const firstRequest = fetch(prepared.url);
    await vi.waitFor(() => expect(releaseFirstStat).not.toBeNull());
    const secondResponse = await fetch(prepared.url);
    expect(secondResponse.status).toBe(429);
    releaseFirstStat?.({ path: prepared.path, type: "file", size: 10 });
    await expect(firstRequest).resolves.toMatchObject({ status: 200 });
    await proxy.dispose();
  });

  it("stats once at range start and once at range completion", async () => {
    const fileService = createFileService();
    const stat = vi.mocked(fileService.stat);
    const proxy = createRemoteMediaPreviewProxy({
      fileService,
      chunkBytes: 2,
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    const response = await fetch(prepared.url);
    await response.arrayBuffer();

    expect(stat).toHaveBeenCalledTimes(3);
    await proxy.dispose();
  });

  it("releases the Host slot when the client closes during backpressure", async () => {
    let active = 0;
    let disconnectFirstWrite = true;
    const requestLimiter = {
      tryAcquire: vi.fn(() => {
        if (active >= 1) return false;
        active += 1;
        return true;
      }),
      release: vi.fn(() => {
        active -= 1;
      }),
      getState: () => ({ active, limit: 1 }),
    };
    const proxy = createRemoteMediaPreviewProxy({
      fileService: createFileService(),
      requestLimiter,
      writeChunk: (response, chunk) => {
        if (disconnectFirstWrite) {
          disconnectFirstWrite = false;
          queueMicrotask(() => response.destroy());
          return false;
        }
        return response.write(chunk);
      },
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });

    const interrupted = await fetch(prepared.url).catch(() => null);
    await interrupted?.arrayBuffer().catch(() => undefined);
    await vi.waitFor(() => expect(active).toBe(0));
    expect(requestLimiter.release).toHaveBeenCalledTimes(1);

    const next = await fetch(prepared.url);
    expect(next.status).toBe(200);
    expect(Buffer.from(await next.arrayBuffer()).toString("utf8")).toBe("0123456789");
    expect(requestLimiter.release).toHaveBeenCalledTimes(2);
    await proxy.dispose();
  });

  it("releases the Host slot when the proxy is disposed during backpressure", async () => {
    let active = 0;
    let notifyWriteStarted: (() => void) | null = null;
    const writeStarted = new Promise<void>((resolve) => {
      notifyWriteStarted = resolve;
    });
    const requestLimiter = {
      tryAcquire: () => {
        active += 1;
        return true;
      },
      release: vi.fn(() => {
        active -= 1;
      }),
    };
    const proxy = createRemoteMediaPreviewProxy({
      fileService: createFileService(),
      requestLimiter,
      writeChunk: () => {
        notifyWriteStarted?.();
        return false;
      },
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    const pendingRequest = fetch(prepared.url).catch(() => null);
    await writeStarted;
    await proxy.dispose();
    await pendingRequest;

    expect(active).toBe(0);
    expect(requestLimiter.release).toHaveBeenCalledTimes(1);
  });

  it("records low-frequency busy, stale and expired diagnostics without paths or tokens", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fileService = createFileService();
    const stat = vi.mocked(fileService.stat);
    let allowRequest = false;
    const proxy = createRemoteMediaPreviewProxy({
      fileService,
      logger,
      requestLimiter: {
        tryAcquire: () => allowRequest,
        release: vi.fn(),
        getState: () => ({ active: 2, limit: 2 }),
      },
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-a",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:host-a:/remote/workspace",
      },
    });
    const prepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    if (!("previewId" in prepared)) throw new Error("expected host range preview");
    expect((await fetch(prepared.url)).status).toBe(429);
    expect(logger.warn).toHaveBeenCalledWith(
      "media-preview.range BUSY",
      expect.objectContaining({ active: 2, limit: 2, owner: "host" }),
    );

    await proxy.service.release?.({ previewId: prepared.previewId });
    expect((await fetch(prepared.url)).status).toBe(404);
    expect(logger.debug).toHaveBeenCalledWith(
      "media-preview.lease EXPIRED",
      expect.objectContaining({ scopeKey: expect.any(String) }),
    );

    allowRequest = true;
    const stalePrepared = await proxy.service.prepare({
      path: "/remote/workspace/video.mp4",
      expectedKind: "video",
    });
    if (!("previewId" in stalePrepared)) throw new Error("expected host range preview");
    stat.mockResolvedValueOnce({ path: stalePrepared.path, type: "file", size: 11 });
    expect((await fetch(stalePrepared.url)).status).toBe(409);
    expect(logger.warn).toHaveBeenCalledWith(
      "media-preview.range STALE",
      expect.objectContaining({ previewId: stalePrepared.previewId }),
    );
    await proxy.dispose();
  });
});
