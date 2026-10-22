import type { ComponentType, RefAttributes } from "react";
import type { DocKind } from "#office/contract.ts";
import type { ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";
// One line per format, tagged `kind:<format>`: scripts/build.mjs keeps only the plugin's formats,
// so a plugin bundles only the renderers it uses.
import { DocxView } from "#ui/viewers/DocxView.tsx"; // kind:docx
import { PdfView } from "#ui/viewers/PdfView.tsx"; // kind:pdf
import { prepareCjkFonts } from "#ui/cjkFontRuntime.ts"; // kind:pdf
import { PptxView } from "#ui/viewers/PptxView.tsx"; // kind:pptx
import { XlsxView, loadXlsxWasm } from "#ui/viewers/XlsxView.tsx"; // kind:xlsx

export interface ViewerEntry {
  view: ComponentType<ViewerProps & RefAttributes<ViewerHandle>>;
  /** Loads what the viewer needs besides the file (fetched alongside the file's bytes). */
  prepare?: () => Promise<unknown>;
}

export const VIEWERS: Partial<Record<DocKind, ViewerEntry>> = {
  docx: { view: DocxView }, // kind:docx
  pdf: { view: PdfView, prepare: prepareCjkFonts }, // kind:pdf
  pptx: { view: PptxView }, // kind:pptx
  xlsx: { view: XlsxView, prepare: loadXlsxWasm }, // kind:xlsx
};
