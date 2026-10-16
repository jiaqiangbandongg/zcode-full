import { createHash } from "node:crypto";
import {
  marketingAssetSchema,
  type MarketingAsset,
  type MarketingTouchSnapshot,
  type MarketingVisual,
} from "@zcode/shared";

/** 下载授权只来自宿主已验证的投放响应；Renderer 不能自行授权地址。 */
export function createMarketingAssetRegistry(
  options: { fetch?: typeof fetch; allowLoopback?: boolean } = {},
) {
  const allowed = new Map<string, Set<string>>();
  const cache = new Map<string, { data: string; size: number }>();
  const pending = new Map<string, Promise<string>>();
  let cacheBytes = 0;
  function allow(asset: MarketingAsset) {
    const parsed = marketingAssetSchema.parse(asset);
    const url = new URL(parsed.src);
    const loopback =
      options.allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) return;
    if (!allowed.has(parsed.src) && allowed.size >= 512)
      allowed.delete(allowed.keys().next().value!);
    const hashes = allowed.get(parsed.src) ?? new Set<string>();
    if (hashes.size >= 8) hashes.delete(hashes.values().next().value!);
    hashes.add(parsed.sha256);
    allowed.set(parsed.src, hashes);
  }
  function allows(asset: MarketingAsset) {
    return allowed.get(asset.src)?.has(asset.sha256) === true;
  }
  function visual(value?: MarketingVisual | null) {
    if (!value) return;
    if (value.type === "image") {
      allow(value.image.default);
      if (value.image.dark) allow(value.image.dark);
    }
    if (value.type === "video") {
      allow(value.video.src);
      allow(value.video.fallback);
    }
    if (value.type === "bundle") {
      allow(value.bundle.bundle);
      if (value.bundle.fallback) allow(value.bundle.fallback);
    }
  }
  async function download(asset: MarketingAsset, kind: "image" | "video") {
    const response = await (options.fetch ?? fetch)(asset.src, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body) throw new Error("marketing_asset_download");
    const limit = (kind === "image" ? 8 : 16) * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("marketing_asset_size");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("marketing_asset_integrity");
    const mime =
      kind === "video"
        ? bytes.toString("ascii", 4, 8) === "ftyp"
          ? "video/mp4"
          : undefined
        : bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          ? "image/png"
          : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? "image/jpeg"
            : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
              ? "image/webp"
              : undefined;
    if (!mime) throw new Error("marketing_asset_type");
    const data = `data:${mime};base64,${bytes.toString("base64")}`;
    while (cacheBytes + data.length > 48 * 1024 * 1024 && cache.size) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.size;
      cache.delete(oldest);
    }
    cache.set(`${kind}:${asset.sha256}`, { data, size: data.length });
    cacheBytes += data.length;
    return data;
  }
  return {
    allow,
    allows,
    allowsUrl: (url: URL) => allowed.has(url.href),
    accept(snapshot: MarketingTouchSnapshot) {
      for (const delivery of snapshot.deliveries) {
        if (delivery.resource_position === "banner") {
          visual(delivery.banner.background);
          visual(delivery.banner.success_popup?.hero);
        } else visual(delivery.popup.hero);
      }
    },
    async readMedia(input: MarketingAsset, kind: "image" | "video") {
      const asset = marketingAssetSchema.parse(input);
      if (!allows(asset)) throw new Error("marketing_asset_source");
      if (kind !== "image" && kind !== "video") throw new Error("marketing_asset_type");
      const key = `${kind}:${asset.sha256}`;
      const cached = cache.get(key);
      if (cached) return cached.data;
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = download(asset, kind);
      pending.set(key, promise);
      try {
        return await promise;
      } finally {
        pending.delete(key);
      }
    },
  };
}
