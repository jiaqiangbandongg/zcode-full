import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ProviderLogoSourceManifest {
  logos: Array<{ file: string }>;
}

const assetDirectory = new URL("../src/assets/provider-icons/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("model-provider-logo-sources.json", assetDirectory), "utf8"),
) as ProviderLogoSourceManifest;

function readPngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readSvgSize(source: string): { width: number; height: number } {
  const viewBox = source.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/u);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  const width = source.match(/\bwidth=["']([\d.]+)/u)?.[1];
  const height = source.match(/\bheight=["']([\d.]+)/u)?.[1];
  if (!width || !height) throw new Error("SVG 缺少可机械验证的固有尺寸");
  return { width: Number(width), height: Number(height) };
}

describe("Provider built-in logo assets", () => {
  it("Z.AI PNG 原样复用无额外留白的应用图标，不再误用同名旧 SVG", () => {
    const source = readFileSync(new URL("../../desktop/build/icons/128x128.png", import.meta.url));
    const packaged = readFileSync(new URL("model-provider-zai-app.png", assetDirectory));
    expect(packaged.equals(source)).toBe(true);
    expect(readPngSize(packaged)).toEqual({ width: 128, height: 128 });
  });
  it("来源清单中的每个内置 Logo 素材本身都是方形", () => {
    for (const { file } of manifest.logos) {
      const assetUrl = new URL(file, assetDirectory);
      const size = file.endsWith(".png")
        ? readPngSize(readFileSync(assetUrl))
        : readSvgSize(readFileSync(assetUrl, "utf8"));
      expect(size, file).toEqual({ width: size.width, height: size.width });
    }
  });
});
