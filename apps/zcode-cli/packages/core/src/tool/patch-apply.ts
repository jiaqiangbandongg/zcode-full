import { normalizeLineEndings } from "./edit-matchers.js";
import type { PatchChunk } from "./patch-parser.js";

interface PatchApplyResult {
  content: string;
}

type Replacement = [startIndex: number, oldLineCount: number, newLines: string[]];
type Comparator = (actual: string, expected: string) => boolean;

export function derivePatchedContent(content: string, chunks: PatchChunk[]): PatchApplyResult {
  const originalLines = splitLogicalLines(normalizeLineEndings(content));
  const replacements = computeReplacements(originalLines, chunks);
  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines.length === 0 || nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }
  return { content: nextLines.join("\n") };
}

function computeReplacements(lines: string[], chunks: PatchChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex);
      if (contextIndex === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}'`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile === true);
    if (found === -1 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      replacement =
        replacement[replacement.length - 1] === "" ? replacement.slice(0, -1) : replacement;
      found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile === true);
    }

    if (found === -1) {
      throw new Error(`Failed to find expected lines:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  return replacements.sort((left, right) => left[0] - right[0]);
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const [startIndex, oldLineCount, newLines] = replacements[index]!;
    result.splice(startIndex, oldLineCount, ...newLines);
  }
  return result;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;
  for (const compare of [exactCompare, trimEndCompare, trimCompare, normalizedCompare]) {
    const index = tryMatch(lines, pattern, startIndex, compare, eof);
    if (index !== -1) return index;
  }
  return -1;
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && linesMatch(lines, pattern, fromEnd, compare)) return fromEnd;
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    if (linesMatch(lines, pattern, index, compare)) return index;
  }
  return -1;
}

function linesMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (!compare(lines[startIndex + offset] ?? "", pattern[offset] ?? "")) return false;
  }
  return true;
}

function exactCompare(actual: string, expected: string): boolean {
  return actual === expected;
}

function trimEndCompare(actual: string, expected: string): boolean {
  return actual.trimEnd() === expected.trimEnd();
}

function trimCompare(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

function normalizedCompare(actual: string, expected: string): boolean {
  return normalizeUnicode(actual.trim()) === normalizeUnicode(expected.trim());
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function splitLogicalLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
