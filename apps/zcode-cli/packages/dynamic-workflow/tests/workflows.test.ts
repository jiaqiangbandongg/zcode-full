import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileWorkflowScript } from "../src/index.js";
import { diffAgainstMarkers, parseExpectedErrors } from "./helpers/markers.js";

// Fixture-driven compiler tests: every tests/workflows/*.ts file is compiled;
// trailing `// error` markers state the expected diagnostics (see helpers/markers.ts).
const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), "workflows");

describe("workflow fixtures", () => {
  const fixtures = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(fixture, () => {
      const source = readFileSync(join(workflowsDir, fixture), "utf8");
      const expected = parseExpectedErrors(source);
      const result = compileWorkflowScript(source);
      expect(diffAgainstMarkers(expected, result.diagnostics)).toEqual([]);
      expect(result.ok).toBe(expected.size === 0);
    });
  }
});
