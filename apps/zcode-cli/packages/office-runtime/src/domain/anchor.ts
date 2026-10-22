import { OfficeError, kindOf, type DocKind } from "#office/contract.ts";

/**
 * Anchors are the shared address format of the panel, the server and the model:
 * `<workspace-relative path>#<locator>`. Locators depend on the document kind. Indices are 1-based.
 *
 *   docx  p:14 · p:3-9 · t:2 · t:2/r3c1
 *   pptx  slide:3 · slide:2-4 · slide:3/shape:7
 *   pdf   page:5 · page:2-4
 *   xlsx  Revenue · Revenue!B2 · Revenue!B2:F9 · 'Q3 data'!A1
 */
export interface CellRef {
  row: number;
  col: number;
}

export type Locator =
  | { kind: "docx"; type: "paragraph"; from: number; to: number }
  | { kind: "docx"; type: "table"; table: number; cell?: CellRef }
  | { kind: "pptx"; from: number; to: number; shape?: string }
  | { kind: "pdf"; from: number; to: number }
  | { kind: "xlsx"; sheet: string; range?: { start: CellRef; end: CellRef } };

const invalid = (text: string, hint: string) =>
  new OfficeError("invalid_anchor", `Cannot read location "${text}". ${hint}`);

const HINTS: Record<DocKind, string> = {
  docx: "Use p:N, p:N-M, t:N or t:N/rRcC.",
  pptx: "Use slide:N, slide:N-M or slide:N/shape:ID.",
  pdf: "Use page:N or page:N-M.",
  xlsx: "Use Sheet, Sheet!A1 or Sheet!A1:C9 (quote names with spaces: 'My sheet'!A1).",
};

function span(text: string, match: RegExpMatchArray | null, kind: DocKind) {
  if (!match) throw invalid(text, HINTS[kind]);
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!(from >= 1) || !(to >= from) || to > 1_000_000) throw invalid(text, HINTS[kind]);
  return { from, to };
}

export function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function parseCell(text: string): CellRef | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text);
  if (!match) return null;
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  const row = Number(match[2]);
  if (row < 1 || row > 1_048_576 || col > 16_384) return null;
  return { row, col };
}

export const formatCell = (cell: CellRef) => `${columnName(cell.col)}${cell.row}`;

/** Quote a sheet name the way Excel does when it is not a plain identifier. */
export function formatSheet(name: string): string {
  return /^[A-Za-z_À-￿][\w.À-￿]*$/.test(name) && !parseCell(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}

function parseXlsx(text: string): Locator {
  let sheet: string;
  let rest: string;
  if (text.startsWith("'")) {
    let i = 1;
    sheet = "";
    for (; i < text.length; i++) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          sheet += "'";
          i++;
        } else break;
      } else sheet += text[i];
    }
    if (i >= text.length) throw invalid(text, HINTS.xlsx);
    rest = text.slice(i + 1);
    if (rest && !rest.startsWith("!")) throw invalid(text, HINTS.xlsx);
    rest = rest.slice(1);
  } else {
    const bang = text.lastIndexOf("!");
    sheet = bang < 0 ? text : text.slice(0, bang);
    rest = bang < 0 ? "" : text.slice(bang + 1);
  }
  if (!sheet || sheet.length > 64) throw invalid(text, HINTS.xlsx);
  if (!rest) return { kind: "xlsx", sheet };
  const [a, b = a] = rest.split(":");
  const start = parseCell(a);
  const end = parseCell(b);
  if (!start || !end) throw invalid(text, HINTS.xlsx);
  return {
    kind: "xlsx",
    sheet,
    range: {
      start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
      end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
    },
  };
}

export function parseLocator(kind: DocKind, raw: string): Locator {
  const text = raw.trim();
  if (!text || text.length > 300) throw invalid(raw, HINTS[kind]);
  switch (kind) {
    case "docx": {
      const table = /^t:(\d+)(?:\/r(\d+)c(\d+))?$/i.exec(text);
      if (table) {
        const index = Number(table[1]);
        if (index < 1) throw invalid(text, HINTS.docx);
        if (table[2] === undefined) return { kind, type: "table", table: index };
        const cell = { row: Number(table[2]), col: Number(table[3]) };
        if (cell.row < 1 || cell.col < 1) throw invalid(text, HINTS.docx);
        return { kind, type: "table", table: index, cell };
      }
      return {
        kind,
        type: "paragraph",
        ...span(text, /^p:(\d+)(?:-(?:p:)?(\d+))?$/i.exec(text), kind),
      };
    }
    case "pptx": {
      const shape = /^slide:(\d+)\/shape:([\w-]{1,32})$/i.exec(text);
      if (shape) {
        const slide = Number(shape[1]);
        if (slide < 1) throw invalid(text, HINTS.pptx);
        return { kind, from: slide, to: slide, shape: shape[2] };
      }
      return { kind, ...span(text, /^slide:(\d+)(?:-(?:slide:)?(\d+))?$/i.exec(text), kind) };
    }
    case "pdf":
      return { kind, ...span(text, /^page:(\d+)(?:-(?:page:)?(\d+))?$/i.exec(text), kind) };
    case "xlsx":
      return parseXlsx(text);
  }
}

export function formatLocator(locator: Locator): string {
  const range = (prefix: string, from: number, to: number) =>
    from === to ? `${prefix}:${from}` : `${prefix}:${from}-${to}`;
  switch (locator.kind) {
    case "docx":
      if (locator.type === "paragraph") return range("p", locator.from, locator.to);
      return locator.cell
        ? `t:${locator.table}/r${locator.cell.row}c${locator.cell.col}`
        : `t:${locator.table}`;
    case "pptx":
      return locator.shape
        ? `slide:${locator.from}/shape:${locator.shape}`
        : range("slide", locator.from, locator.to);
    case "pdf":
      return range("page", locator.from, locator.to);
    case "xlsx": {
      const sheet = formatSheet(locator.sheet);
      if (!locator.range) return sheet;
      const { start, end } = locator.range;
      const a = formatCell(start);
      const b = formatCell(end);
      return a === b ? `${sheet}!${a}` : `${sheet}!${a}:${b}`;
    }
  }
}

/** Split `<path>#<locator>`; the path ends at the first supported extension followed by `#` or the end. */
export function splitAnchor(anchor: string): { path: string; at: string | null } {
  const match = /^(.*?\.(?:docx|xlsx|pptx|pdf))(?:#(.*))?$/i.exec(anchor.trim());
  if (!match) {
    throw new OfficeError(
      "invalid_anchor",
      `"${anchor}" is not a document anchor. Use <path>.docx|.xlsx|.pptx|.pdf optionally followed by #<location>.`,
    );
  }
  return { path: match[1], at: match[2]?.trim() ? match[2].trim() : null };
}

export function formatAnchor(path: string, at: string | null | undefined): string {
  return at ? `${path}#${at}` : path;
}

/** Parse a full anchor and its locator in one step. */
export function parseAnchor(anchor: string): {
  path: string;
  kind: DocKind;
  locator: Locator | null;
} {
  const { path, at } = splitAnchor(anchor);
  const kind = kindOf(path);
  if (!kind) throw new OfficeError("unsupported_type", `Unsupported document type: ${path}`);
  return { path, kind, locator: at ? parseLocator(kind, at) : null };
}
