import { OfficeError, type OutlineItem } from "#office/contract.ts";
import type { Locator } from "#office/domain/anchor.ts";
import {
  clampRange,
  matchAll,
  normalise,
  paginate,
  snippet,
  type Hit,
  type ParsedDocument,
} from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";
import { installDomMatrix } from "#office/adapters/parse/dommatrix.ts";

/** Directory with pdf.js `cmaps/` and `standard_fonts/`, ending in a slash. */
export interface PdfAssets {
  cMapUrl: string;
  standardFontDataUrl: string;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | undefined;

async function loadPdfJs(): Promise<PdfJs> {
  return (pdfjs ??= (async () => {
    installDomMatrix();
    // Run the worker code on the main thread: a stdio server has no use for a separate worker,
    // and bundling keeps the worker module available without a file path.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })());
}

const MAX_PAGES_INDEXED = 3000;

export async function parsePdf(
  bytes: Uint8Array,
  label: string,
  assets: PdfAssets,
): Promise<ParsedDocument> {
  const { getDocument } = await loadPdfJs();
  let doc;
  try {
    doc = await getDocument({
      data: bytes.slice(),
      cMapUrl: assets.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: assets.standardFontDataUrl,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const name = (error as Error).name;
    throw new OfficeError(
      "corrupt_file",
      name === "PasswordException"
        ? `${label} is password protected.`
        : `${label} could not be read as a PDF: ${(error as Error).message}`,
    );
  }
  try {
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES_INDEXED); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      pages.push(normalizeCjkCompat(text.replace(/[ \t]+\n/g, "\n").trim()));
      page.cleanup();
    }

    const outline: OutlineItem[] = [];
    const walk = async (items: Awaited<ReturnType<typeof doc.getOutline>>, level: number) => {
      for (const item of items ?? []) {
        if (outline.length >= 200) return;
        let pageNumber: number | null = null;
        try {
          const dest =
            typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
          const ref = Array.isArray(dest) ? dest[0] : null;
          if (ref && typeof ref === "object") pageNumber = (await doc.getPageIndex(ref)) + 1;
          else if (typeof ref === "number") pageNumber = ref + 1;
        } catch {
          pageNumber = null;
        }
        if (pageNumber)
          outline.push({
            at: `page:${pageNumber}`,
            label: cut(normalise(item.title), 0, 120),
            level,
          });
        if (level < 3) await walk(item.items, level + 1);
      }
    };
    await walk(await doc.getOutline(), 1);
    const info = (await doc.getMetadata().catch(() => null))?.info as
      | { Title?: string }
      | undefined;
    const numPages = doc.numPages;

    const render = (n: number) =>
      `## Page ${n}\n${pages[n - 1] || "(no extractable text; the page may be scanned)"}`;
    const select = (locator: Locator | null) => {
      if (!locator) return pages.map((_, i) => render(i + 1));
      if (locator.kind !== "pdf") throw new OfficeError("invalid_anchor", "Not a PDF location.");
      const { from, to } = clampRange(locator.from, locator.to, numPages, "page");
      return Array.from({ length: Math.min(to, pages.length) - from + 1 }, (_, i) =>
        render(from + i),
      );
    };

    return {
      kind: "pdf",
      title: info?.Title?.trim() || null,
      units: numPages,
      outline,
      read: (locator, cursor) => paginate(select(locator), cursor),
      check: (locator) => (select(locator), locator),
      search(query, limit) {
        const hits: Hit[] = [];
        pages.forEach((text, i) => {
          for (const index of matchAll(text, query)) {
            if (hits.length >= limit) return;
            hits.push({ at: `page:${i + 1}`, snippet: snippet(text, index, query.length) });
          }
        });
        return hits;
      },
    };
  } finally {
    await doc.destroy();
  }
}
