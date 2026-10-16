import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript } from "../src/index.js";

/**
 * Smoke corpus: real, production-scale workflow scripts that must ANALYZE CLEAN — no throw,
 * every projection produced — within a budget. No goldens: these scripts are large (2,500+
 * trace regions each) and their exact graphs are not the point; the point is that the
 * analyzer scales to what authors actually write. Each file records where it came from.
 *
 * Add a script here when it breaks the analyzer in production (ITERATION_CAP, a stack
 * overflow, a pathological runtime) and the minimal shape has ALSO been pinned in a unit
 * test next to the fix — the smoke file guards the whole shape, the unit test explains it.
 */
const smokeDir = join(dirname(fileURLToPath(import.meta.url)), "smoke");
const BUDGET_MS = 10_000;

describe("smoke corpus", () => {
  const scripts = readdirSync(smokeDir)
    .filter((name) => name.endsWith(".dwf.ts"))
    .sort();

  it("finds scripts", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const script of scripts) {
    it(`${script} analyzes clean within ${BUDGET_MS} ms`, () => {
      const source = readFileSync(join(smokeDir, script), "utf8");
      const started = Date.now();
      const result = analyzeWorkflowScript(source);
      const elapsed = Date.now() - started;
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.core).toBeDefined();
      expect(result.causality).toBeDefined();
      expect(result.flow).toBeDefined();
      expect(result.handoff).toBeDefined();
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });
  }
});
