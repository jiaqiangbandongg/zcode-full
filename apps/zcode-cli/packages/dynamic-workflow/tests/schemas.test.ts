import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeSchema, synthesizeWorkflowSchemas } from "../src/index.js";

// Fixture-driven schema-synthesis snapshots: every tests/schemas/*.ts file must
// typecheck + synthesize clean, and each typed ask site's JSON Schema is snapshotted
// under tests/schemas/expected/<base>.<siteId>.json (siteId `ask#1` -> `ask-1` on disk,
// to stay cross-platform). Run `pnpm test -- -u` to (re)generate, then review by hand.
const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "schemas");

describe("schema synthesis fixtures", () => {
  const fixtures = readdirSync(schemasDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(fixture, async () => {
      const source = readFileSync(join(schemasDir, fixture), "utf8");
      const result = synthesizeWorkflowSchemas(source);
      expect(result.diagnostics).toEqual([]);
      const ids = Object.keys(result.schemas).sort(bySiteOrdinal);
      expect(ids.length).toBeGreaterThan(0);
      const base = fixture.replace(/\.ts$/, "");
      for (const id of ids) {
        const fileId = id.replace("#", "-");
        await expect(serializeSchema(result.schemas[id]!)).toMatchFileSnapshot(
          join(schemasDir, "expected", `${base}.${fileId}.json`),
        );
      }
    });
  }
});

/** `ask#2` < `ask#10`：按尾部序号数值排序，snapshot 顺序稳定。 */
function bySiteOrdinal(a: string, b: string): number {
  const ordinal = (id: string): number => Number(id.slice(id.indexOf("#") + 1));
  return ordinal(a) - ordinal(b);
}
