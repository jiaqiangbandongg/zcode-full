import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectDiagnostics, createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import { synthesizeAskSchemas } from "../src/index.js";
import { diffAgainstMarkers, parseExpectedErrors } from "./helpers/markers.js";

// Fixture-driven schema-REJECTION suite. A sibling of tests/workflows/, but driven by
// schema synthesis rather than by compileWorkflowScript (which only typechecks and never
// runs synthesis). Every tests/schema-errors/*.ts file must typecheck clean (so T
// resolves) and its trailing `// error` markers state the schema-rejection diagnostics
// expected at the ask site. Matching is strict and bidirectional (see helpers/markers.ts).
const errorsDir = join(dirname(fileURLToPath(import.meta.url)), "schema-errors");

describe("schema rejection fixtures", () => {
  const fixtures = readdirSync(errorsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(fixture, () => {
      const source = readFileSync(join(errorsDir, fixture), "utf8");
      const workflow = createWorkflowProgram(source);
      // 前置：脚本必须 typecheck 通过，否则是 fixture 自身的问题，而非 schema 拒绝。
      expect(collectDiagnostics(workflow.program)).toEqual([]);
      const { diagnostics } = synthesizeAskSchemas(workflow, collectSites(workflow));
      const expected = parseExpectedErrors(source);
      expect(diffAgainstMarkers(expected, diagnostics)).toEqual([]);
    });
  }
});
