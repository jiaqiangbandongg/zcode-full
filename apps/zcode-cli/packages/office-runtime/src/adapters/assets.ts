/**
 * Names served from `${ASSET_PREFIX}{name}`: bundle chunks, styles, wasm, pdf.js data and the
 * bundled CJK fallback font. pdf.js wasm decodes JPEG 2000 images (openjpeg) and ICC colours (qcms).
 */
const ASSET_NAME =
  /^(?:[\w-]+\.(?:txt|css|json|js|wasm)|pdfjs\/(?:cmaps\/[\w-]+\.bcmap|standard_fonts\/[\w-]+\.(?:pfb|ttf)|wasm\/[\w-]+\.wasm)|fonts\/[\w-]+\.woff2)$/;

export function isAssetName(name: string): boolean {
  return ASSET_NAME.test(name) && !name.includes("..");
}
