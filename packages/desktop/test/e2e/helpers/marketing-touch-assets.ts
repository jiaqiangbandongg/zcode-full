import { readFile } from "node:fs/promises";
import { marketingTouchDecodeAssets } from "./marketing-touch-decode-assets.js";
import {
  createMarketingTouchFaultBundle,
  createMarketingTouchZip,
} from "./marketing-touch-fault-bundle.js";

export async function createMarketingTouchAssets() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  );
  const html = await readFile(
    new URL("../../../../ui/src/assets/cloud-content/weekend-plan-hero.html", import.meta.url),
  );
  const zip = await createMarketingTouchZip(html);
  const faultZip = await createMarketingTouchFaultBundle();
  const invalidMedia = Buffer.from("E2E intentionally invalid resource bytes");
  return {
    png,
    zip,
    assets: {
      ...marketingTouchDecodeAssets,
      image: { path: "/marketing-assets/banner.png", bytes: png, type: "image/png" },
      // 不同 hash 验证主题资源选择，尾部标记不影响解码。
      darkImage: {
        path: "/marketing-assets/banner-dark.png",
        bytes: Buffer.concat([png, Buffer.from("E2E dark resource")]),
        type: "image/png",
      },
      invalidImage: {
        path: "/marketing-assets/invalid.png",
        bytes: invalidMedia,
        type: "image/png",
      },
      invalidZip: {
        path: "/marketing-assets/invalid.zip",
        bytes: invalidMedia,
        type: "application/zip",
      },
      bundle: { path: "/marketing-assets/hero.zip", bytes: zip, type: "application/zip" },
      faultBundle: {
        path: "/marketing-assets/fault-hero.zip",
        bytes: faultZip,
        type: "application/zip",
      },
    },
  };
}
