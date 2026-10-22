import { ALL_KINDS, type DocKind } from "#office/kinds.ts";
import { PROFILE } from "#office/profile.ts";

export { ALL_KINDS, type DocKind };

export const PLUGIN_VERSION = PROFILE.version;
export const SERVER_NAME = PROFILE.name;
export const SURFACE_ID = PROFILE.name;
export const PANEL_URI = `ui://${PROFILE.name}/panel.html`;
export const ASSET_PREFIX = `ui://${PROFILE.name}/assets/`;
export const FILE_PREFIX = `ui://${PROFILE.name}/file/`;
export const HTML_MIME = "text/html;profile=mcp-app";

/** Formats this plugin opens. */
export const DOC_KINDS: readonly DocKind[] = PROFILE.kinds;

/** Files larger than this are refused before any parsing. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Total uncompressed size allowed for a docx / xlsx / pptx package (zip-bomb guard). */
export const MAX_UNZIPPED_BYTES = 512 * 1024 * 1024;
/** Raw bytes per file chunk; base64 stays well inside the host's 8 MiB resource-read limit. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Budget for the text part of one model-facing tool result (the host caps `content` at 32 KiB). */
export const TEXT_BUDGET = 24 * 1024;

/** One entry of a document outline; `at` is a locator inside the same document. */
export interface OutlineItem {
  at: string;
  label: string;
  level: number;
}

/** What the panel and the model learn about a document when it is opened. */
export interface DocumentInfo {
  path: string;
  kind: DocKind;
  title: string | null;
  bytes: number;
  revision: string;
  /** pdf pages, pptx slides, xlsx sheets, docx paragraphs + tables. */
  units: number;
  outline: OutlineItem[];
}

/** File transport for the panel: read `${FILE_PREFIX}${token}/${index}` for each chunk. */
export interface FileHandle {
  token: string;
  chunks: number;
  bytes: number;
}

/** docx body block as the panel needs it to map rendered elements back to locators. */
export interface DocxBlockKey {
  at: string;
  text: string;
}

/** A user selection reported by the panel. `at` is a locator, `text` the selected or quoted text. */
export interface Selection {
  at: string;
  text: string;
}

/** Where the user is in the viewer, reported by the panel. */
export interface ViewState {
  path: string | null;
  kind: DocKind | null;
  /** Visible position, e.g. `page:3`, `slide:2`, `Revenue!A1`. */
  at: string | null;
  selection: Selection | null;
  updatedAt: number;
}

/** One place for the panel to reveal and highlight. */
export interface ShowTarget {
  at: string;
  quote?: string;
}

/** structuredContent of every model / panel tool result that concerns the viewer. */
export interface ViewerSnapshot {
  document: DocumentInfo | null;
  /** Set by open_document / show: where the panel should go and what to highlight. */
  reveal?: { targets: ShowTarget[]; note?: string; seq: number };
}

export type OfficeErrorCode =
  | "invalid_path"
  | "path_outside_workspace"
  | "not_found"
  | "unsupported_type"
  | "file_too_large"
  | "corrupt_file"
  | "invalid_anchor"
  | "no_document"
  | "invalid_token"
  | "invalid_resource";

export class OfficeError extends Error {
  constructor(
    readonly code: OfficeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfficeError";
  }
}

/** The format of `path` if this plugin opens it, else null. */
export function kindOf(path: string): DocKind | null {
  const ext = path.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  return (DOC_KINDS as readonly string[]).includes(ext ?? "") ? (ext as DocKind) : null;
}

const LIST_WORDS = {
  en: { sep: ", ", and: " and ", or: " or " },
  "zh-CN": { sep: "、", and: "和", or: "或" },
} as const;

/** `a, b and c` (or `a, b or c`) in English or Chinese. */
export function joinList(
  items: readonly string[],
  lang: "en" | "zh-CN" = "en",
  joiner: "and" | "or" = "and",
): string {
  const words = LIST_WORDS[lang];
  if (items.length < 2) return items.join("");
  const last = items[items.length - 1];
  // Chinese puts spaces around 和 / 或 only next to Latin words: "PowerPoint 和 PDF", "单元格或幻灯片".
  const word = lang === "zh-CN" && /^[\x20-\x7e]/.test(last) ? ` ${words[joiner]} ` : words[joiner];
  return `${items.slice(0, -1).join(words.sep)}${word}${last}`;
}

/** `.docx, .xlsx, .pptx and .pdf` (or `… or .pdf`) for the formats this plugin opens. */
export function extensionList(lang: "en" | "zh-CN" = "en", joiner: "and" | "or" = "and"): string {
  return joinList(
    DOC_KINDS.map((kind) => `.${kind}`),
    lang,
    joiner,
  );
}
