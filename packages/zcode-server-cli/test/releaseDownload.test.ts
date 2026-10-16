import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ReleaseDownloader, fetchReleaseCatalog, fetchReleaseJson } from "../src/runtime/releaseDownload.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("release downloader", () => {
  it("fetches a catalog and verifies an archive checksum", async () => {
    const payload = Buffer.from("release-payload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const server = createServer((request, response) => {
      if (request.url === "/catalog.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ schemaVersion: 1, releases: [{ version: "2.0.0", target: "linux-x64", archiveUrl: "http://127.0.0.1/archive.tar.gz", archiveSha256: sha256 }] }));
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
    await new ReleaseDownloader().download({ url: `http://127.0.0.1:${address.port}/archive.tar.gz`, destination, sha256, expectedSizeBytes: payload.byteLength, timeoutMs: 2_000 });
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
    await expect(new ReleaseDownloader().download({ url: `http://127.0.0.1:${address.port}/archive.tar.gz`, destination, sha256: "0".repeat(64), timeoutMs: 2_000 })).rejects.toThrow(/checksum/i);
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
    await expect(new ReleaseDownloader().download({
      url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
      destination,
      sha256,
      expectedSizeBytes: payload.byteLength + 1,
    })).rejects.toThrow(/size mismatch/i);
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

    await expect(fetchReleaseJson(
      `http://127.0.0.1:${address.port}/manifest.json`,
      z.object({ answer: z.number() }),
      // 留出本地 fetch 建连和 CI 调度余量，避免 25ms 下先得到连接错误而不是 AbortError。
      1_000,
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps an active archive stream alive past the idle timeout", async () => {
    const payload = Buffer.from("abcdefgh");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const server = createServer((_request, response) => {
      let index = 0;
      const timer = setInterval(() => {
        response.write(payload.subarray(index, index + 1));
        index += 1;
        if (index === payload.length) {
          clearInterval(timer);
          response.end();
        }
      }, 30);
      response.once("close", () => clearInterval(timer));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-idle-"));

    await new ReleaseDownloader().download({
      url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
      destination: join(dir, "release.tar.gz"),
      sha256,
      expectedSizeBytes: payload.byteLength,
      timeoutMs: 50,
      overallTimeoutMs: 1_000,
      maxAttempts: 1,
    });
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
