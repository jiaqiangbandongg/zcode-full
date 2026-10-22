import { describe, expect, it } from "vitest";
import { isAssetName } from "#office/adapters/assets.ts";

describe("isAssetName", () => {
  it("serves bundle parts and the pdf.js data the panel reads", () => {
    for (const name of [
      "assets.json",
      "bundle-0.txt",
      "panel.css",
      "pdf-worker.js",
      "sheets.wasm",
      "pdfjs/cmaps/UniGB-UCS2-H.bcmap",
      "pdfjs/standard_fonts/FoxitSans.pfb",
      // pdf.js 解 JPEG 2000（openjpeg）与 ICC 颜色（qcms）的 wasm。
      "pdfjs/wasm/openjpeg.wasm",
      "pdfjs/wasm/qcms_bg.wasm",
      "cjk-fallback.json",
      "fonts/noto-sans-sc-12-400-normal.woff2",
    ])
      expect(isAssetName(name), name).toBe(true);
  });

  it("refuses anything else", () => {
    for (const name of [
      "../server.mjs",
      "pdfjs/../../server.mjs",
      "pdfjs/wasm/openjpeg_nowasm_fallback.js",
      "fonts/x.ttf",
      "fonts/sub/x.woff2",
      "panel.html",
      "LICENSE",
    ])
      expect(isAssetName(name), name).toBe(false);
  });
});
