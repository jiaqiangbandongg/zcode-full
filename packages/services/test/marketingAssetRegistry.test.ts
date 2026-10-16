import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import { parseMarketingTouchResponse } from "@zcode/shared";

describe("published marketing assets", () => {
  it("authorizes banner ZIP and fallback only from a validated delivery", () => {
    const registry = createMarketingAssetRegistry();
    const bundle = { src: "https://cdn.example.com/banner.zip", sha256: "a".repeat(64) };
    const fallback = { src: "https://cdn.example.com/banner.png", sha256: "b".repeat(64) };
    expect(registry.allows(bundle)).toBe(false);
    registry.accept(
      parseMarketingTouchResponse({
        code: 0,
        data: {
          server_time: 1,
          language: "en-US",
          deliveries: [
            {
              campaign_id: "bundle",
              priority: 1,
              resource_position: "banner",
              banner: {
                background: { type: "bundle", bundle: { bundle, fallback, entry: "index.html" } },
                buttons: [],
              },
            },
          ],
        },
      }),
    );
    expect(registry.allows(bundle)).toBe(true);
    expect(registry.allows(fallback)).toBe(true);
    expect(registry.allows({ ...bundle, sha256: "0".repeat(64) })).toBe(false);
  });
  it("requires a published URL/digest, validates bytes and reuses verified media", async () => {
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const asset = {
      src: "https://cdn.example.com/a.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const fetcher = vi.fn(async () => new Response(bytes));
    const registry = createMarketingAssetRegistry({ fetch: fetcher });
    await expect(registry.readMedia(asset, "image")).rejects.toThrow(/source/);
    registry.allow(asset);
    expect(await registry.readMedia(asset, "image")).toContain("data:image/png;base64,");
    await registry.readMedia(asset, "image");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(registry.readMedia({ ...asset, sha256: "0".repeat(64) }, "image")).rejects.toThrow(
      /source/,
    );
  });
  it("rejects changed bytes and redirects instead of following unapproved destinations", async () => {
    const asset = { src: "https://cdn.example.com/a.png", sha256: "0".repeat(64) };
    const fetcher = vi.fn(async () => new Response("bad"));
    const registry = createMarketingAssetRegistry({ fetch: fetcher });
    registry.allow(asset);
    await expect(registry.readMedia(asset, "image")).rejects.toThrow(/integrity/);
    fetcher.mockImplementation(
      async () => new Response(null, { status: 302, headers: { Location: "http://localhost" } }),
    );
    await expect(registry.readMedia(asset, "image")).rejects.toThrow(/download/);
  });
});
