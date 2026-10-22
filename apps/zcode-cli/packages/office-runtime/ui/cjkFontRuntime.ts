import { readBinary, readText } from "#ui/assets.ts";
import {
  CJK_UNICODE_RANGE,
  FALLBACK_FAMILY,
  FALLBACK_MANIFEST,
  LOCAL_FONTS,
  cjkFamilies,
  familyOf,
  withCjkFamilies,
  type FaceKey,
  type PdfFontLike,
} from "#ui/cjkFonts.ts";

/**
 * Registers the `zcode-cjk-*` faces and the bundled fallback for the PDF canvas. scripts/build.mjs
 * patches pdf.js so the canvas asks `pdfTypeface` for every font it sets.
 */

let prepared: Promise<void> | undefined;
let fallbackReady = false;

/**
 * Look up the installed fonts behind every `zcode-cjk-*` face (local() only, nothing is
 * downloaded); with no CJK font installed at all, load the bundled fallback instead. Runs before a
 * PDF opens: the canvas never waits for a font, so every face must be ready before the first page
 * is drawn.
 */
export function prepareCjkFonts(): Promise<void> {
  return (prepared ??= (async () => {
    const found = await Promise.all(
      Object.entries(LOCAL_FONTS).map(async ([key, names]) => {
        const face = new FontFace(
          familyOf(key as FaceKey),
          names.map((name) => `local("${name}")`).join(", "),
          { unicodeRange: CJK_UNICODE_RANGE },
        );
        try {
          await face.load();
          document.fonts.add(face);
          return true;
        } catch {
          return false;
        }
      }),
    );
    // 在首次绘制前决定并加载兜底字体：画布不会等字体，事后加载就得重画页面。
    if (!found.some(Boolean)) fallbackReady = await loadFallback();
  })());
}

/** Register the bundled Noto Sans SC slices as `zcode-cjk-fallback`; false when that failed. */
async function loadFallback(): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readText(FALLBACK_MANIFEST)) as {
      faces: { file: string; unicodeRange: string }[];
    };
    await Promise.all(
      manifest.faces.map(async ({ file, unicodeRange }) => {
        const face = new FontFace(FALLBACK_FAMILY, await readBinary(file), { unicodeRange });
        await face.load();
        document.fonts.add(face);
      }),
    );
    return true;
  } catch (error) {
    console.warn("CJK fallback font", error);
    return false;
  }
}

/**
 * The CSS font-family list for a font the PDF canvas sets. `css` is pdf.js's own list; fonts pdf.js
 * has no file for get the `zcode-cjk-*` faces before its generic family.
 */
export function pdfTypeface(font: PdfFontLike, css: string): string {
  return withCjkFamilies(css, cjkFamilies(font, fallbackReady));
}
