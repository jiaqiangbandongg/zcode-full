import type { CompileDiagnostic } from "../../src/index.js";

// Dotty-style neg-test markers: one trailing `// error` per expected diagnostic
// on that line (`// error // error` = two). Marker-free files must compile clean.
const TRAILING_MARKERS = /(?:[ \t]*\/\/ error)+[ \t]*$/;
const SINGLE_MARKER = /\/\/ error/g;

/** Parse expected diagnostic counts per 1-based line from trailing markers. */
export function parseExpectedErrors(source: string): Map<number, number> {
  const expected = new Map<number, number>();
  source.split(/\r?\n/).forEach((line, index) => {
    const match = TRAILING_MARKERS.exec(line);
    if (!match) return;
    const count = match[0].match(SINGLE_MARKER)?.length ?? 0;
    if (count > 0) expected.set(index + 1, count);
  });
  return expected;
}

/**
 * Strict bidirectional diff: every marker must be hit and every diagnostic must
 * be covered by a marker. Returns human-readable mismatches (empty = pass).
 */
export function diffAgainstMarkers(
  expected: Map<number, number>,
  diagnostics: readonly CompileDiagnostic[],
): string[] {
  const actual = new Map<number, CompileDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const bucket = actual.get(diagnostic.line) ?? [];
    bucket.push(diagnostic);
    actual.set(diagnostic.line, bucket);
  }
  const lines = [...new Set([...expected.keys(), ...actual.keys()])].sort((a, b) => a - b);
  const failures: string[] = [];
  for (const line of lines) {
    const want = expected.get(line) ?? 0;
    const got = actual.get(line) ?? [];
    if (got.length === want) continue;
    const detail = got.length > 0 ? ` — ${got.map((d) => d.message).join(" | ")}` : "";
    failures.push(`line ${line}: expected ${want} error(s), got ${got.length}${detail}`);
  }
  return failures;
}
