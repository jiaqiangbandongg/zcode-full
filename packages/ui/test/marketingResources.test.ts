// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMarketingHero } from "@/components/marketing-touch/marketingResources.js";
import type { ICloudContentService } from "@zcode/services";
afterEach(() => vi.unstubAllGlobals());

describe("marketing resource preparation", () => {
  it("uses the verified image fallback when video download fails", async () => {
    vi.stubGlobal(
      "Image",
      class {
        onload?: () => void;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const readPublishedMedia = vi.fn(async ({ kind }: { kind: string }) => {
      if (kind === "video") throw new Error("download failed");
      return "data:image/png;base64,a";
    });
    const result = await prepareMarketingHero(
      {
        type: "video",
        video: {
          src: { src: "https://cdn.example.com/banner.webm", sha256: "a".repeat(64) },
          fallback: { src: "https://cdn.example.com/poster.png", sha256: "b".repeat(64) },
        },
      },
      { readPublishedMedia } as unknown as ICloudContentService,
      "en-US",
      false,
    );
    expect(result.hero).toEqual({ type: "image", src: "data:image/png;base64,a", alt: "" });
    expect(readPublishedMedia.mock.calls.map(([arg]) => arg.kind)).toEqual(["image", "video"]);
  });
  it("prepares a verified fallback on Web without acquiring a bundle", async () => {
    vi.stubGlobal(
      "Image",
      class {
        onload?: () => void;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const prepare = vi.fn();
    const result = await prepareMarketingHero(
      {
        type: "bundle",
        bundle: {
          bundle: { src: "https://cdn.example.com/banner.zip", sha256: "a".repeat(64) },
          entry: "index.html",
          fallback: { src: "https://cdn.example.com/fallback.png", sha256: "b".repeat(64) },
        },
      },
      {
        prepare,
        readPublishedMedia: async () => "data:image/png;base64,a",
      } as unknown as ICloudContentService,
      "en-US",
      false,
    );
    expect(result.hero).toEqual({ type: "image", src: "data:image/png;base64,a", alt: "" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("degrades a bundle on Web without asking for a desktop loopback lease", async () => {
    const prepare = vi.fn();
    const result = await prepareMarketingHero(
      {
        type: "bundle",
        bundle: {
          bundle: { src: "https://cdn.example.com/a.zip", sha256: "a".repeat(64) },
          entry: "index.html",
        },
      },
      { prepare } as unknown as ICloudContentService,
      "en-US",
      false,
    );
    expect(result.hero).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("releases a prepared bundle exactly once", async () => {
    const release = vi.fn(async () => {});
    const service = {
      prepare: async () => ({
        url: "http://127.0.0.1:123/lease/index.html",
        leaseId: "lease",
        cacheHit: false,
      }),
      release,
    } as unknown as ICloudContentService;
    const result = await prepareMarketingHero(
      {
        type: "bundle",
        args: {
          heading: "Banner",
          zcode_plan: {
            name: "Weekend",
            entitlements: [
              {
                meter: "model_usage",
                show_name: "GLM",
                grant_units: 300000000,
                unit_type: "token",
              },
            ],
          },
        },
        bundle: {
          bundle: { src: "https://cdn.example.com/a.zip", sha256: "a".repeat(64) },
          entry: "index.html",
        },
      },
      service,
      "en-US",
      true,
    );
    expect(result.hero?.type).toBe("interactive_bundle");
    expect(result.hero).toMatchObject({
      data: {
        heading: "Banner",
        planName: "Weekend",
        amountValue: "300,000,000",
        zcode_plan: { name: "Weekend" },
      },
    });
    await result.release();
    await result.release();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
