import type { ICloudContentService } from "@zcode/services";
import type { MarketingAsset, MarketingVisual } from "@zcode/shared";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import { logger } from "@/logger.js";

export async function prepareMarketingImage(asset: MarketingAsset, service: ICloudContentService) {
  const src = await service.readPublishedMedia({ asset, kind: "image" });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      img.src = "";
      reject(new Error("marketing_image_timeout"));
    }, 10_000);
    img.onload = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      reject(new Error("marketing_image_decode"));
    };
    img.src = src;
  });
  return src;
}

export interface PreparedMarketingHero {
  hero: CloudDialogHero | null;
  release: () => Promise<void>;
}
const empty = (): PreparedMarketingHero => ({ hero: null, release: async () => {} });

function heroData(args: Record<string, unknown> | undefined, locale: string) {
  const raw = args?.zcode_plan;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return args ?? {};
  const plan = raw as Record<string, unknown>;
  const entitlements = Array.isArray(plan.entitlements) ? plan.entitlements : [];
  const benefits: string[] = [];
  let maximum = 0;
  for (const rawEntry of entitlements.slice(0, 32)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    if (entry.meter !== "model_usage") continue;
    const units =
      typeof entry.grant_units === "number" && Number.isFinite(entry.grant_units)
        ? entry.grant_units
        : 0;
    maximum = Math.max(maximum, units);
    if (typeof entry.show_name === "string")
      benefits.push(
        `${entry.show_name} · ${new Intl.NumberFormat(locale).format(units)} ${typeof entry.unit_type === "string" ? entry.unit_type : ""}`,
      );
  }
  return {
    ...args,
    planName: typeof plan.name === "string" ? plan.name : "",
    amountValue: new Intl.NumberFormat(locale).format(maximum),
    amountUnit: "tokens",
    benefits,
    endsAtLabel:
      typeof plan.ends_at === "number" ? new Date(plan.ends_at * 1000).toLocaleString(locale) : "",
    endsAtPrefix: locale === "zh-CN" ? "有效期至" : "Valid until",
    replayLabel: locale === "zh-CN" ? "重播" : "Replay",
  };
}

export async function prepareMarketingHero(
  visual: MarketingVisual | null | undefined,
  service: ICloudContentService | undefined,
  locale: "zh-CN" | "en-US",
  desktop: boolean,
): Promise<PreparedMarketingHero> {
  if (!visual || !service) return empty();
  const fallback =
    visual.type === "bundle"
      ? visual.bundle.fallback
      : visual.type === "video"
        ? visual.video.fallback
        : null;
  let fallbackSrc: string | undefined;
  if (fallback) {
    try {
      fallbackSrc = await prepareMarketingImage(fallback, service);
    } catch {
      /* 主资源仍可独立成功。 */
    }
  }
  try {
    if (visual.type === "image") {
      const src = await prepareMarketingImage(visual.image.default, service);
      const darkSrc = visual.image.dark
        ? await prepareMarketingImage(visual.image.dark, service).catch(() => undefined)
        : undefined;
      return { hero: { type: "image", src, darkSrc, alt: "" }, release: async () => {} };
    }
    if (visual.type === "video") {
      const src = await service.readPublishedMedia({ asset: visual.video.src, kind: "video" });
      const video = document.createElement("video");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          video.onloadeddata = null;
          video.onerror = null;
          video.removeAttribute("src");
          video.load();
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("marketing_video_timeout"));
        }, 10_000);
        video.onloadeddata = () => {
          cleanup();
          resolve();
        };
        video.onerror = () => {
          cleanup();
          reject(new Error("marketing_video_decode"));
        };
        video.preload = "auto";
        video.muted = true;
        video.src = src;
      });
      return {
        hero: {
          type: "video",
          src,
          poster: fallbackSrc ?? "",
          muted: true,
          autoplay: true,
          loop: true,
        },
        release: async () => {},
      };
    }
    if (!desktop) throw new Error("marketing_web_bundle_unavailable");
    const bundle = {
      format: "zip" as const,
      url: visual.bundle.bundle.src,
      sha256: visual.bundle.bundle.sha256,
      entry: visual.bundle.entry,
    };
    const lease = await service.prepare({ bundle });
    let released = false;
    return {
      hero: {
        type: "interactive_bundle",
        runtime: "zcode-hero-sandbox-v1",
        bundle,
        resolvedUrl: lease.url,
        viewport: { aspectRatio: "4:3" },
        data: heroData(visual.args, locale),
        events: { replay: "replay" },
        ...(fallbackSrc ? { fallback: { type: "image" as const, src: fallbackSrc, alt: "" } } : {}),
      },
      release: async () => {
        if (!released) {
          released = true;
          await service.release({ leaseId: lease.leaseId });
        }
      },
    };
  } catch (error) {
    logger.warn("[marketing-touch] hero degraded", {
      reason: error instanceof Error ? error.message : "resource_failed",
    });
    return {
      hero: fallbackSrc ? { type: "image", src: fallbackSrc, alt: "" } : null,
      release: async () => {},
    };
  }
}
