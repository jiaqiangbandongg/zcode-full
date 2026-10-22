import {
  OfficeError,
  TEXT_BUDGET,
  type DocKind,
  type DocxBlockKey,
  type OutlineItem,
} from "#office/contract.ts";
import type { Locator } from "#office/domain/anchor.ts";
import { cut } from "#office/domain/text.ts";

/** One search hit: a locator in the document and a short snippet around the match. */
export interface Hit {
  at: string;
  snippet: string;
}

/** A page of model-facing text. `next` is the cursor for the following page, or null at the end. */
export interface ReadPage {
  text: string;
  next: number | null;
}

/** A parsed document, independent of its format. */
export interface ParsedDocument {
  kind: DocKind;
  title: string | null;
  units: number;
  outline: OutlineItem[];
  /** Model-facing text for a location (null = the whole document), paged by `cursor`. */
  read(locator: Locator | null, cursor: number): ReadPage;
  search(query: string, limit: number): Hit[];
  /** Check that a locator points inside this document and return its canonical form; throws invalid_anchor otherwise. */
  check(locator: Locator): Locator;
  /** docx only: body block keys the panel uses to map rendered elements back to locators. */
  blocks?: DocxBlockKey[];
}

export const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

/** Case-insensitive search that returns match positions in `text`. */
export function matchAll(text: string, query: string): number[] {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];
  if (!needle) return positions;
  for (
    let i = haystack.indexOf(needle);
    i >= 0 && positions.length < 50;
    i = haystack.indexOf(needle, i + needle.length)
  )
    positions.push(i);
  return positions;
}

export function snippet(text: string, index: number, length: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? "…" : ""}${normalise(cut(text, start, end))}${end < text.length ? "…" : ""}`;
}

/**
 * Join units into a budgeted page. A unit larger than the budget is cut with a note, so a single
 * page always makes progress.
 */
export function paginate(units: string[], cursor: number, budget = TEXT_BUDGET): ReadPage {
  const parts: string[] = [];
  let used = 0;
  let index = Math.max(0, cursor);
  for (; index < units.length; index++) {
    const unit = units[index];
    const size = Buffer.byteLength(unit);
    if (parts.length && used + size > budget) break;
    if (size > budget) {
      parts.push(
        `${truncateBytes(unit, budget)}\n[… truncated; read a narrower location to see the rest]`,
      );
      index++;
      break;
    }
    parts.push(unit);
    used += size + 2;
  }
  return { text: parts.join("\n\n"), next: index < units.length ? index : null };
}

export function truncateBytes(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  let end = Math.min(text.length, budget);
  while (end > 0 && Buffer.byteLength(cut(text, 0, end)) > budget) end = Math.floor(end * 0.9);
  return cut(text, 0, end);
}

const cellText = (value: string) => normalise(value).replace(/\|/g, "\\|") || " ";

/** Render rows as a GitHub-flavoured markdown table (first row as header). */
export function markdownTable(rows: string[][]): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => cellText(row[i] ?? ""));
  const [head, ...body] = rows.map(pad);
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** Clamp a 1-based range to `count` units, throwing a helpful error when it starts past the end. */
export function clampRange(from: number, to: number, count: number, noun: string) {
  if (from > count)
    throw new OfficeError(
      "invalid_anchor",
      `${noun} ${from} does not exist; the document has ${count} ${noun}s.`,
    );
  return { from, to: Math.min(to, count) };
}
