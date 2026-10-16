import { createServer } from "node:http";
import { extname } from "node:path";
import { rm } from "node:fs/promises";
import { contentBundleSchema } from "@zcode/shared";
import type { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
import type { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";

const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

export function createCloudContentService(options: {
  cacheRoot: string;
  publishedAssets?: ReturnType<typeof createMarketingAssetRegistry>;
}): ICloudContentService & { disposeAllAndWait(): Promise<void> } {
  let disposed = false;
  let usedCache = false;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const leases = new Set<string>();
  const trusted = (url: URL) => options.publishedAssets?.allowsUrl(url) === true;
  const cache = createContentBundleCache({
    cacheRoot: options.cacheRoot,
    isTrustedUrl: trusted,
    signal: lifetime.signal,
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (disposed || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const [, leaseId, ...segments] = url.pathname.split("/");
      if (!leaseId || !leases.has(leaseId)) {
        response.writeHead(404).end();
        return;
      }
      const path = decodeURIComponent(segments.join("/"));
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) {
        response.writeHead(404).end();
        return;
      }
      const content = await cache.read(leaseId, path);
      response
        .writeHead(200, {
          "Content-Type": mime,
          "Content-Length": content.length,
          "Content-Security-Policy": CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "cross-origin",
        })
        .end(content);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
  let listening: Promise<string> | undefined;
  function resourceOrigin() {
    listening ??= new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("cloud_content_address"));
          return;
        }
        server.unref();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return listening;
  }
  return {
    async readPublishedMedia({ asset, kind }) {
      if (disposed || !options.publishedAssets) throw new Error("cloud_content_disabled");
      return options.publishedAssets.readMedia(asset, kind);
    },
    async prepare({ bundle }) {
      const parsed = contentBundleSchema.parse(bundle);
      if (disposed) throw new Error("cloud_content_disposed");
      if (!options.publishedAssets?.allows({ src: parsed.url, sha256: parsed.sha256 }))
        throw new Error("cloud_content_source");
      const operation = (async () => {
        usedCache = true;
        const result = await cache.acquire(parsed);
        leases.add(result.leaseId);
        if (disposed) {
          await cache.release(result.leaseId);
          leases.delete(result.leaseId);
          throw new Error("cloud_content_disposed");
        }
        try {
          const base = await resourceOrigin();
          return {
            leaseId: result.leaseId,
            cacheHit: result.cacheHit,
            url: `${base}/${result.leaseId}/${result.entry.split("/").map(encodeURIComponent).join("/")}`,
          };
        } catch (error) {
          leases.delete(result.leaseId);
          await cache.release(result.leaseId);
          throw error;
        }
      })();
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    },
    async release({ leaseId }) {
      leases.delete(leaseId);
      await cache.release(leaseId);
    },
    async disposeAllAndWait() {
      disposed = true;
      lifetime.abort();
      await Promise.allSettled(pending);
      if (listening) {
        await listening.catch(() => undefined);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      await Promise.all([...leases].map((leaseId) => cache.release(leaseId)));
      leases.clear();
      if (usedCache) await rm(options.cacheRoot, { recursive: true, force: true });
    },
  };
}
