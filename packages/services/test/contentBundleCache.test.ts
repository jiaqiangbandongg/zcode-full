import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yazl from "yazl";
import {
  createContentBundleCache,
  validateContentBundlePath,
} from "#src/cloud-content/contentBundleCache.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  entries: Record<string, string> = { "index.html": "<h1>Hello</h1>", "assets/main.js": "void 0" },
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-bundle-test-"));
  directories.push(root);
  const zip = new yazl.ZipFile();
  for (const [path, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), path);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const bundle = {
    format: "zip" as const,
    url: "https://cdn.example.com/hero.zip",
    entry: "index.html",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fetcher = vi.fn(async () => new Response(bytes));
  const cache = createContentBundleCache({
    cacheRoot: root,
    isTrustedUrl: (url) => url.origin === "https://cdn.example.com",
    fetch: fetcher,
  });
  return { root, bytes, bundle, cache, fetcher };
}

describe("content bundle cache", () => {
  it("accepts a server bundle without declared size but still verifies its digest", async () => {
    const { cache, bundle } = await fixture();
    const { sizeBytes: _sizeBytes, ...published } = bundle;
    const lease = await cache.acquire(published);
    expect((await cache.read(lease.leaseId, "index.html")).toString()).toContain("Hello");
    await cache.release(lease.leaseId);
    await expect(cache.acquire({ ...published, sha256: "0".repeat(64) })).rejects.toThrow(
      /integrity/,
    );
  });
  it("aborts in-flight download when its owning host is disposed", async () => {
    const { root, bundle } = await fixture();
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cache = createContentBundleCache({
      cacheRoot: root,
      isTrustedUrl: () => true,
      signal: controller.signal,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
            once: true,
          });
          started();
        }),
    });
    const result = cache.acquire(bundle);
    const rejected = expect(result).rejects.toThrow();
    await entered;
    controller.abort();
    await rejected;
    expect((await readdir(root)).filter((name) => name === bundle.sha256)).toEqual([]);
  });
  it("runs the HTTP download-to-cache path with the real fetch implementation", async () => {
    const { root, bytes, bundle } = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "application/zip" }).end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const cache = createContentBundleCache({
      cacheRoot: root,
      isTrustedUrl: (url) => url.origin === origin,
    });
    try {
      const first = await cache.acquire({ ...bundle, url: `${origin}/hero.zip` });
      const second = await cache.acquire({ ...bundle, url: `${origin}/hero.zip` });
      expect((await cache.read(first.leaseId, first.entry)).toString()).toBe("<h1>Hello</h1>");
      expect(second.cacheHit).toBe(true);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    }
  });
  it("downloads, verifies, extracts, deduplicates and protects leased resources", async () => {
    const { root, bundle, cache, fetcher } = await fixture();
    const [first, second] = await Promise.all([cache.acquire(bundle), cache.acquire(bundle)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(await readFile(join(root, bundle.sha256, "index.html"), "utf8")).toBe("<h1>Hello</h1>");
    expect((await cache.read(first.leaseId, "assets/main.js")).toString()).toBe("void 0");
    await expect(cache.read(first.leaseId, "../secret")).rejects.toThrow();
    await cache.clear();
    expect((await cache.read(first.leaseId, "index.html")).length).toBeGreaterThan(0);
    await cache.release(first.leaseId);
    await cache.release(second.leaseId);
    await cache.clear();
    await expect(cache.read(first.leaseId, "index.html")).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name !== "staging")).toEqual([]);
  });

  it("rejects integrity failures without publishing partial cache", async () => {
    const { root, bundle, cache } = await fixture();
    await expect(cache.acquire({ ...bundle, sha256: "0".repeat(64) })).rejects.toThrow(/integrity/);
    expect(await readdir(join(root, "staging"))).toEqual([]);
    await expect(cache.acquire({ ...bundle, sizeBytes: bundle.sizeBytes + 1 })).rejects.toThrow(
      /size/,
    );
  });

  it("rejects missing entry and case-colliding ZIP files", async () => {
    for (const entries of [
      { "other.html": "hello" },
      { "index.html": "hello", "INDEX.HTML": "bad" },
    ]) {
      const { cache, bundle } = await fixture(entries);
      await expect(cache.acquire(bundle)).rejects.toThrow();
    }
  });

  it("rejects path traversal in ZIP metadata and removes staging", async () => {
    const { cache, bundle, bytes, fetcher, root } = await fixture();
    const malicious = Buffer.from(bytes);
    let index = malicious.indexOf("index.html");
    while (index !== -1) {
      malicious.write("../xx.html", index, "utf8");
      index = malicious.indexOf("index.html", index + 10);
    }
    fetcher.mockImplementation(async () => new Response(malicious));
    await expect(
      cache.acquire({ ...bundle, sha256: createHash("sha256").update(malicious).digest("hex") }),
    ).rejects.toThrow();
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("checks trust before fetching and never follows an untrusted redirect", async () => {
    const { cache, bundle, fetcher } = await fixture();
    await expect(cache.acquire({ ...bundle, url: "http://127.0.0.1/private" })).rejects.toThrow(
      /source/,
    );
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example/hero.zip" },
        }),
    );
    await expect(cache.acquire(bundle)).rejects.toThrow(/source/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe cross-platform archive paths", () => {
    for (const path of [
      "../x",
      "/x",
      "C:/x",
      "a\\b",
      "a/../b",
      "a//b",
      "a/./b",
      "CON",
      "a/NUL.txt",
      "a.",
      "a ",
      ".bundle.json",
    ]) {
      expect(() => validateContentBundlePath(path)).toThrow();
    }
    expect(validateContentBundlePath("assets/main.js")).toBe("assets/main.js");
  });

  it("detects tampering on reads and rebuilds corrupt unleased cache", async () => {
    const { cache, bundle, root, fetcher } = await fixture();
    const lease = await cache.acquire(bundle);
    await writeFile(join(root, bundle.sha256, "index.html"), "tampered");
    await expect(cache.read(lease.leaseId, "index.html")).rejects.toThrow(/cache/);
    await expect(cache.acquire(bundle)).rejects.toThrow(/active_cache_corrupt/);
    await cache.release(lease.leaseId);
    const next = await cache.acquire(bundle);
    expect(next.cacheHit).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await cache.read(next.leaseId, "index.html")).toString()).toBe("<h1>Hello</h1>");
  });

  // Windows 普通用户无符号链接权限（需开发者模式），fs.symlink EPERM；覆盖由 CI Linux 承担。
  it.skipIf(process.platform === "win32")(
    "rejects symlink replacement and files outside the published manifest",
    async () => {
      const { cache, bundle, root } = await fixture();
      const lease = await cache.acquire(bundle);
      await writeFile(join(root, "secret"), "secret");
      await rm(join(root, bundle.sha256, "index.html"));
      await symlink(join(root, "secret"), join(root, bundle.sha256, "index.html"));
      await expect(cache.read(lease.leaseId, "index.html")).rejects.toThrow(/symlink/);
      await expect(cache.read(lease.leaseId, ".bundle.json")).rejects.toThrow();
      await expect(cache.read(lease.leaseId, "unknown.js")).rejects.toThrow(/missing/);
    },
  );

  it("enforces expanded file size and entry count before publishing", async () => {
    for (const entries of [
      { "index.html": "x".repeat(8 * 1024 * 1024 + 1) },
      Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          index === 0 ? "index.html" : `${index}.txt`,
          "x",
        ]),
      ),
    ]) {
      const { cache, bundle, root } = await fixture(entries);
      await expect(cache.acquire(bundle)).rejects.toThrow(/size|limit/);
      expect(await readdir(join(root, "staging"))).toEqual([]);
    }
  });
});
