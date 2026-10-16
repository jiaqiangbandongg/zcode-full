import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  analyzeCoverage,
  changedLines,
  isBusinessSource,
  readReport,
  verifySourceEvidence,
} from "../marketing-touch-coverage-audit.mjs";

test("source identity requires a fresh stable build, matching hash and explicit domain", () => {
  const manifest = {
    schemaVersion: 1,
    status: "fresh-stable",
    domains: ["renderer", "host", "main"],
    changedFiles: [],
    sources: { "a.ts": "source" },
    outputs: { "index.js": "a".repeat(64) },
  };
  assert.equal(verifySourceEvidence("a.ts", "source", "renderer", manifest), "matched");
  assert.equal(verifySourceEvidence("a.ts", "changed", "renderer", manifest), "mismatch");
  assert.equal(
    verifySourceEvidence("missing.ts", "source", "renderer", manifest),
    "missing-source",
  );
  assert.equal(verifySourceEvidence("a.ts", "source", "cli", manifest), "unverified");
  assert.equal(
    verifySourceEvidence("a.ts", "source", "renderer", {
      ...manifest,
      status: "unverified-reused-build",
    }),
    "unverified",
  );
  assert.equal(verifySourceEvidence("a.ts", "source", "renderer", null), "unverified");
});

test("compressed reports are readable and corrupt reports are not treated as missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketing-coverage-audit-"));
  try {
    const file = join(directory, "coverage-final.json");
    assert.equal(await readReport(file), null);
    await writeFile(`${file}.gz`, gzipSync(JSON.stringify({ fixture: true })));
    assert.deepEqual(await readReport(file), { fixture: true });
    await writeFile(file, "not-json");
    await assert.rejects(readReport(file), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const coverage = {
  path: "/repo/packages/services/src/demo.ts",
  statementMap: {
    0: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
    1: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } },
  },
  s: { 0: 1, 1: 0 },
  fnMap: {},
  f: {},
  branchMap: {},
  b: {},
};
test("diff hunks retain additions and exclude pure deletions", () => {
  assert.deepEqual([...changedLines("@@ -1,4 +1,0 @@\n@@ -8 +5,2 @@\n@@ -20 +19 @@")], [5, 6, 19]);
});
test("business scope excludes declarations, translations and tests", () => {
  assert.equal(isBusinessSource("packages/ui/src/a.tsx"), true);
  for (const p of [
    "docs/a.md",
    "packages/ui/src/a.d.ts",
    "packages/ui/src/a.test.ts",
    "packages/ui/src/i18n/locales/en-US.ts",
  ])
    assert.equal(isBusinessSource(p), false);
});
test("missing file coverage is unknown, not zero or fully covered", () => {
  assert.deepEqual(analyzeCoverage("packages/ui/src/a.ts", "renderer", new Set([1]), undefined), {
    status: "unknown",
    warnings: ["missing-file-coverage"],
  });
});
test("Node line-shaped maps remain raw and unexpected domains are flagged", () => {
  const result = analyzeCoverage(
    "packages/services/src/demo.ts",
    "main",
    new Set([1, 2]),
    coverage,
  );
  assert.deepEqual(result.lines, { covered: 1, total: 2 });
  assert.ok(result.warnings.includes("unexpected-runtime-domain"));
  assert.ok(result.warnings.includes("node-physical-line-map"));
  assert.ok(result.warnings.includes("no-function-records"));
  assert.equal(result.basis, "node-raw-mapped-lines");
});
test("Renderer counts only changed lines without adding another domain", () => {
  const result = analyzeCoverage("packages/ui/src/demo.ts", "renderer", new Set([2, 9]), coverage);
  assert.deepEqual(result.lines, { covered: 0, total: 1 });
  assert.deepEqual(result.unmappedChangedLines, [9]);
  assert.equal(result.basis, "renderer-istanbul-lines");
});
