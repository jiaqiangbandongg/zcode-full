import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ReleaseDownloader,
  fetchReleaseCatalog,
  fetchReleaseJson,
} from "../src/runtime/releaseDownload.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

// 30ms 发包与 50ms 空闲截止只有 20ms 墙钟余量，繁忙 worker 会先执行截止回调。
// 只控制网络输入和时钟；每次等待真实 Node data 事件后再推进，落盘与校验仍走真实实现。
async function controlledArchiveDownload(overallTimeoutMs = 1_000) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const payload = Buffer.from("abcdefgh");
  const root = await mkdtemp(join(tmpdir(), "zcode-release-download-clock-"));
  const destination = join(root, "release.tar.gz");
  let input!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let signal: AbortSignal | null | undefined;
  let consumed = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
      },
      cancel() {
        closed = true;
      },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, options) => {
      signal = options?.signal;
      return response;
    }),
  );
  const fromWeb = Readable.fromWeb;
  vi.spyOn(Readable, "fromWeb").mockImplementation((...args) => {
    const body = fromWeb(...args);
    body.on("data", () => consumed.resolve());
    connected.resolve();
    return body;
  });
  const outcome = new ReleaseDownloader()
    .download({
      url: "https://release.example.com/archive.tar.gz",
      destination,
      sha256: createHash("sha256").update(payload).digest("hex"),
      expectedSizeBytes: payload.byteLength,
      timeoutMs: 50,
      overallTimeoutMs,
      maxAttempts: 1,
    })
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
  await connected.promise;
  const close = () => {
    if (!closed) {
      closed = true;
      input.close();
    }
  };
  return {
    payload,
    root,
    destination,
    outcome,
    close,
    isAborted: () => signal?.aborted,
    async send(index: number) {
      consumed = Promise.withResolvers<void>();
      input.enqueue(payload.subarray(index, index + 1));
      await Promise.race([
        consumed.promise,
        outcome.then(({ error }) => {
          throw error ?? new Error("download ended before consuming data");
        }),
      ]);
    },
    async dispose() {
      close();
      await outcome;
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("release downloader", () => {
  it("fetches a catalog and verifies an archive checksum", async () => {
    const payload = Buffer.from("release-payload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const server = createServer((request, response) => {
      if (request.url === "/catalog.json") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            releases: [
              {
                version: "2.0.0",
                target: "linux-x64",
                archiveUrl: "http://127.0.0.1/archive.tar.gz",
                archiveSha256: sha256,
              },
            ],
          }),
        );
        return;
      }
      response.end(payload);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    const catalog = await fetchReleaseCatalog(`http://127.0.0.1:${address.port}/catalog.json`);
    expect(catalog.releases[0]?.version).toBe("2.0.0");
    const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
    const destination = join(dir, "release.tar.gz");
    await new ReleaseDownloader().download({
      url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
      destination,
      sha256,
      expectedSizeBytes: payload.byteLength,
      timeoutMs: 2_000,
    });
    await expect(readFile(destination)).resolves.toEqual(payload);
  });

  it("removes a partial file after checksum failure", async () => {
    const server = createServer((_request, response) => response.end("bad"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
    const destination = join(dir, "release.tar.gz");
    await expect(
      new ReleaseDownloader().download({
        url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
        destination,
        sha256: "0".repeat(64),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/checksum/i);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a response with an unexpected declared archive size", async () => {
    const payload = Buffer.from("release-payload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const server = createServer((_request, response) => response.end(payload));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-size-"));
    const destination = join(dir, "release.tar.gz");
    await expect(
      new ReleaseDownloader().download({
        url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
        destination,
        sha256,
        expectedSizeBytes: payload.byteLength + 1,
      }),
    ).rejects.toThrow(/size mismatch/i);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts a JSON request at the application timeout", async () => {
    const server = createServer((_request, _response) => {
      // 保持请求打开，确保测试验证的是 AbortSignal 而不是服务端返回错误。
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");

    await expect(
      fetchReleaseJson(
        `http://127.0.0.1:${address.port}/manifest.json`,
        z.object({ answer: z.number() }),
        // 留出本地 fetch 建连和 CI 调度余量，避免 25ms 下先得到连接错误而不是 AbortError。
        1_000,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps an active archive stream alive past the idle timeout", async () => {
    const download = await controlledArchiveDownload();
    try {
      for (let index = 0; index < download.payload.length; index += 1) {
        await vi.advanceTimersByTimeAsync(30);
        expect(download.isAborted()).toBe(false);
        await download.send(index);
      }
      download.close();
      expect((await download.outcome).error).toBeUndefined();
      await expect(readFile(download.destination)).resolves.toEqual(download.payload);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await download.dispose();
    }
  });

  it("aborts a stalled archive at the idle deadline and removes partial data", async () => {
    const download = await controlledArchiveDownload();
    try {
      await download.send(0);
      await vi.advanceTimersByTimeAsync(49);
      expect(download.isAborted()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(download.isAborted()).toBe(true);
      expect((await download.outcome).error).toMatchObject({ name: "AbortError" });
      expect(await readdir(download.root)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await download.dispose();
    }
  });

  it("does not extend the overall deadline when archive data remains active", async () => {
    const download = await controlledArchiveDownload(100);
    try {
      for (let index = 0; index < 3; index += 1) {
        await vi.advanceTimersByTimeAsync(30);
        expect(download.isAborted()).toBe(false);
        await download.send(index);
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(download.isAborted()).toBe(true);
      expect((await download.outcome).error).toMatchObject({ name: "AbortError" });
      expect(await readdir(download.root)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await download.dispose();
    }
  });

  it("retries transient release HTTP failures with bounded attempts", async () => {
    const payload = Buffer.from("release-payload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.statusCode = 503;
        response.end("temporarily unavailable");
        return;
      }
      response.end(payload);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-retry-"));

    await new ReleaseDownloader().download({
      url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
      destination: join(dir, "release.tar.gz"),
      sha256,
      timeoutMs: 1_000,
      maxAttempts: 2,
      retryDelayMs: 1,
    });
    expect(attempts).toBe(2);
  });
});
