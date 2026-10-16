import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudContentService } from "#src/cloud-content/cloudContentService.js";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import { createCloudContentMockServer } from "../../desktop/scripts/cloud-content-mock.mjs";

describe("cloud content host service", () => {
  it("runs HTTP JSON -> ZIP -> cache -> sandbox resource URL and expires released leases", async () => {
    const mock = await createCloudContentMockServer();
    const cacheRoot = await mkdtemp(join(tmpdir(), "cloud-content-service-"));
    const assets = createMarketingAssetRegistry({ allowLoopback: true });
    const service = createCloudContentService({ cacheRoot, publishedAssets: assets });
    try {
      const payload = await (
        await fetch(`${mock.url}/dialog?type=interactive_bundle&locale=en-US`)
      ).json();
      assets.allow({
        src: payload.dialog.hero.bundle.url,
        sha256: payload.dialog.hero.bundle.sha256,
      });
      expect(payload.dialog.hero.type).toBe("interactive_bundle");
      if (payload.dialog.hero.type !== "interactive_bundle") throw new Error("fixture type");
      const first = await service.prepare({ bundle: payload.dialog.hero.bundle });
      const second = await service.prepare({ bundle: payload.dialog.hero.bundle });
      expect(first.cacheHit).toBe(false);
      expect(second.cacheHit).toBe(true);
      const response = await fetch(first.url);
      expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("zcode-cloud-hero-v1");
      expect((await fetch(second.url)).status).toBe(200);
      await service.release({ leaseId: first.leaseId });
      expect((await fetch(first.url)).status).toBe(404);
      expect(mock.requests.filter((path: string) => path.startsWith("/bundles/")).length).toBe(1);
      const changed = { ...payload.dialog.hero.bundle, url: "https://untrusted.example/hero.zip" };
      await expect(service.prepare({ bundle: changed })).rejects.toThrow(/source/);
    } finally {
      await service.disposeAllAndWait();
      await mock.close();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
  it("does not expose temporary mock or debug RPC methods", async () => {
    const service = createCloudContentService({
      cacheRoot: join(tmpdir(), "unused-cloud-content"),
    });
    expect(service).not.toHaveProperty("status");
    expect(service).not.toHaveProperty("load");
    expect(service).not.toHaveProperty("clear");
    await service.disposeAllAndWait();
  });
  it("permits only delivery-authorized bundles", async () => {
    const mock = await createCloudContentMockServer();
    const cacheRoot = await mkdtemp(join(tmpdir(), "marketing-published-service-"));
    const assets = createMarketingAssetRegistry({ allowLoopback: true });
    const service = createCloudContentService({
      cacheRoot,
      publishedAssets: assets,
    });
    try {
      const payload = await (
        await fetch(`${mock.url}/dialog?type=interactive_bundle&locale=en-US`)
      ).json();
      const bundle = payload.dialog.hero.bundle;
      await expect(service.prepare({ bundle })).rejects.toThrow(/source/);
      assets.allow({ src: bundle.url, sha256: bundle.sha256 });
      const { sizeBytes: _size, ...published } = bundle;
      const prepared = await service.prepare({ bundle: published });
      expect((await fetch(prepared.url)).status).toBe(200);

      await service.release({ leaseId: prepared.leaseId });
    } finally {
      await service.disposeAllAndWait();
      await mock.close();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
