import assert from "node:assert/strict";
import test from "node:test";
import { executableSourceLines } from "../marketing-executable-lines.mjs";

test("type-only syntax and imports do not inflate executable lines", () => {
  const result = executableSourceLines(
    'import { x } from "x";\ninterface A { x: number }\ntype B = string;\n\nexport const f = () => 1;',
    "sample.ts",
  );
  assert.equal(result.status, "mapped");
  assert.equal(result.unmappedStatements, 0);
  assert.deepEqual(result.lines, [5]);
});
test("runtime enums and namespace bodies survive the canonical transform", () => {
  const result = executableSourceLines(
    "type A = string;\nenum E { A, B }\nnamespace N { export const x = 1; }",
    "sample.ts",
  );
  assert.equal(result.status, "mapped");
  assert.ok(result.lines.includes(2));
  assert.ok(result.lines.includes(3));
  assert.equal(result.lines.includes(1), false);
});
test("JSX callbacks and unreachable function bodies remain in scope", () => {
  const result = executableSourceLines(
    "export const view = <button onClick={() => {\n  return 1;\n}} />;\nfunction unused() {\n  throw new Error('unused');\n}",
    "sample.tsx",
  );
  assert.equal(result.status, "mapped");
  for (const line of [1, 2, 5]) assert.ok(result.lines.includes(line));
});
test("invalid source is unknown, not an empty successful denominator", () => {
  const result = executableSourceLines("export const = ;", "bad.ts");
  assert.equal(result.status, "unknown");
});
