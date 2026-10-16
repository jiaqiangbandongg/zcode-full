import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeBundledOfficialMarketplacePartitionSync,
  writeCdnOfficialMarketplacePartitionSync,
  updateMarketplace,
} from "../src/plugins/index.js";

describe("ZCode official marketplace partitions", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  async function makeStorageRoot(): Promise<string> {
    const storageRoot = await mkdtemp(join(tmpdir(), "zcode-official-marketplace-"));
    cleanups.push(storageRoot);
    return storageRoot;
  }

  it("merges bundled and CDN entries under one marketplace with CDN entries taking precedence", async () => {
    const storageRoot = await makeStorageRoot();

    writeBundledOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [
          { name: "shared", source: "filesystem", version: "1.0.0" },
          { name: "bundled-only", source: "filesystem", version: "1.0.0" },
        ],
        version: 1,
      },
      storageRoot,
    });
    writeCdnOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        featured: ["remote"],
        plugins: [
          { name: "shared", source: { source: "url", type: "zip" }, version: "9.0.0" },
          { name: "remote", source: { source: "url", type: "zip" }, version: "2.0.0" },
        ],
      },
      storageRoot,
    });

    const merged = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { featured?: string[]; name: string; plugins: Array<Record<string, unknown>> };
    expect(merged.name).toBe("zcode-plugins-official");
    expect(merged.featured).toEqual(["remote"]);
    expect(merged.plugins.map((plugin) => plugin.name)).toEqual([
      "shared",
      "remote",
      "bundled-only",
    ]);
    expect(merged.plugins[0]).toMatchObject({
      source: { source: "url", type: "zip" },
      version: "9.0.0",
    });
  });

  it("preserves the CDN partition when the application reseeds bundled plugins", async () => {
    const storageRoot = await makeStorageRoot();

    writeCdnOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
      },
      storageRoot,
    });
    writeBundledOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "bundled-v2", source: "sea", version: "2.0.0" }],
        version: 1,
      },
      storageRoot,
    });

    const merged = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    expect(merged.plugins.map((plugin) => plugin.name)).toEqual(["remote", "bundled-v2"]);
  });

  it("does not rewrite unchanged official marketplace files", async () => {
    const storageRoot = await makeStorageRoot();
    const bundledManifest = {
      name: "zcode-plugins-official",
      plugins: [{ name: "bundled", source: "filesystem", version: "1.0.0" }],
    };
    const cdnManifest = {
      name: "zcode-plugins-official",
      plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
    };
    const marketplaceRoot = join(storageRoot, "marketplaces", "zcode-plugins-official");

    writeBundledOfficialMarketplacePartitionSync({
      manifest: bundledManifest,
      storageRoot,
    });
    writeCdnOfficialMarketplacePartitionSync({
      manifest: cdnManifest,
      storageRoot,
    });
    const paths = [
      join(marketplaceRoot, "bundled-marketplace.json"),
      join(marketplaceRoot, "cdn-marketplace.json"),
      join(marketplaceRoot, "marketplace.json"),
    ];
    const firstMtimes = await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs));
    await delay(30);

    writeBundledOfficialMarketplacePartitionSync({
      manifest: bundledManifest,
      storageRoot,
    });
    writeCdnOfficialMarketplacePartitionSync({
      manifest: cdnManifest,
      storageRoot,
    });

    expect(await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs))).toEqual(
      firstMtimes,
    );
  });

  it("rejects the retired CDN marketplace id instead of creating a compatibility alias", async () => {
    const storageRoot = await makeStorageRoot();

    expect(() =>
      writeCdnOfficialMarketplacePartitionSync({
        manifest: { name: "zcode-plugins", plugins: [] },
        storageRoot,
      }),
    ).toThrow("Official marketplace manifest must be named zcode-plugins-official");
  });

  it("refreshes the registered official source and returns the merged plugin count", async () => {
    const storageRoot = await makeStorageRoot();
    writeBundledOfficialMarketplacePartitionSync({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "bundled", source: "filesystem" }],
      },
      storageRoot,
    });

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "zcode-plugins-official",
          plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address missing");
      await writeFile(
        join(storageRoot, "known_marketplaces.json"),
        JSON.stringify({
          version: 1,
          marketplaces: [
            {
              id: "zcode-plugins-official",
              source: { source: "url", url: `http://127.0.0.1:${address.port}/marketplace.json` },
              name: "zcode-plugins-official",
              addedAt: "2026-01-01T00:00:00.000Z",
              pluginCount: 1,
            },
          ],
        }),
      );

      const [updated] = await updateMarketplace({
        marketplace: "zcode-plugins-official",
        storageRoot,
      });
      expect(updated).toMatchObject({
        id: "zcode-plugins-official",
        pluginCount: 2,
      });

      const merged = JSON.parse(
        await readFile(
          join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
          "utf8",
        ),
      ) as { plugins: Array<{ name: string }> };
      expect(merged.plugins.map((plugin) => plugin.name)).toEqual(["remote", "bundled"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
