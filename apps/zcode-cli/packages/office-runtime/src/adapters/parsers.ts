import type { DocKind } from "#office/contract.ts";
import type { ParsedDocument } from "#office/domain/model.ts";
import type { PdfAssets } from "#office/adapters/parse/pdf.ts";
// One line per format, tagged `kind:<format>`: scripts/build.mjs keeps only the plugin's formats,
// so a plugin bundles only the parsers it uses.
import { parseDocx } from "#office/adapters/parse/docx.ts"; // kind:docx
import { parsePdf } from "#office/adapters/parse/pdf.ts"; // kind:pdf
import { parsePptx } from "#office/adapters/parse/pptx.ts"; // kind:pptx
import { parseXlsx } from "#office/adapters/parse/xlsx.ts"; // kind:xlsx

export type ParseFormat = (
  bytes: Uint8Array,
  path: string,
  pdfAssets: PdfAssets,
) => Promise<ParsedDocument>;

export const PARSERS: Partial<Record<DocKind, ParseFormat>> = {
  docx: (bytes, path) => parseDocx(bytes, path), // kind:docx
  pdf: (bytes, path, pdfAssets) => parsePdf(bytes, path, pdfAssets), // kind:pdf
  pptx: (bytes, path) => parsePptx(bytes, path), // kind:pptx
  xlsx: (bytes, path) => parseXlsx(bytes, path), // kind:xlsx
};
