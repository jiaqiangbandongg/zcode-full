import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  collectSites,
  compileWorkflowScript,
  createWorkflowProgram,
  lowerWorkflow,
  lowerWorkflowScript,
  synthesizeAskSchemas,
  synthesizeWorkflowSchemas,
} from "../src/index.js";
import { collectDiagnostics } from "../src/compiler/compile.js";

// Script-shaped cases live in tests/workflows/ (fixture suite with `// error`
// markers); this file covers the CompileResult API shape itself.
describe("compileWorkflowScript API", () => {
  it("returns ok with no diagnostics for a clean script", () => {
    const result = compileWorkflowScript(`return await agent("a").ask("do it");`);
    expect(result).toEqual({ diagnostics: [], ok: true });
  });

  it("positions diagnostics on the author's 1-based script lines", () => {
    const result = compileWorkflowScript(`const x: number = "not a number";`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.line).toBe(1);
    expect(result.diagnostics[0]?.column).toBeGreaterThan(0);
  });

  it("carries the compiler message and code", () => {
    const result = compileWorkflowScript(`process.exit(1);`);
    expect(result.diagnostics[0]?.message).toContain("Cannot find name 'process'");
    expect(result.diagnostics[0]?.code).toBeGreaterThan(0);
  });
});

// Models reach for `declare interface R { ... }` often enough that the raw TS1184
// text ("Modifiers cannot appear here.") became the self-repair loop's main dead
// end: it never names the offending modifier. These pin the rewrite — the message
// must name `declare` / `export` and say to remove it, while the code and the
// script-mapped position stay untouched so the model can still find the line.
describe("ambient-modifier diagnostics", () => {
  const declareForms = [
    ["declare interface", `declare interface R { a: number }\nreturn 1;`],
    ["declare const", `declare const x: number;\nreturn 1;`],
    ["declare function", `declare function f(): void;\nreturn 1;`],
  ] as const;

  for (const [form, script] of declareForms) {
    it(`names \`declare\` and says to remove it for ${form}`, () => {
      const result = compileWorkflowScript(script);
      expect(result.ok).toBe(false);
      const diagnostic = result.diagnostics[0];
      expect(diagnostic?.message).toContain("`declare`");
      expect(diagnostic?.message).toMatch(/Remove `declare`/);
      expect(diagnostic?.message).not.toContain("Modifiers cannot appear here");
      // Code and position are the model's only handle on *where*: keep both.
      expect(diagnostic?.code).toBe(1184);
      expect(diagnostic?.line).toBe(1);
      expect(diagnostic?.column).toBe(1);
    });
  }

  it("keeps the mapped line when the offending statement is not first", () => {
    const result = compileWorkflowScript(
      `const before = 1;\n  declare interface R { a: number }\nreturn before;`,
    );
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe(1184);
    expect(diagnostic?.line).toBe(2);
    expect(diagnostic?.column).toBe(3);
    expect(diagnostic?.message).toContain("`declare`");
  });

  it("names `export` and points at the final return instead", () => {
    const result = compileWorkflowScript(`export const y = 1;\nreturn y;`);
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.message).toContain("`export`");
    expect(diagnostic?.message).toMatch(/Remove `export`/);
    expect(diagnostic?.message).toContain("return");
    expect(diagnostic?.message).not.toContain("Modifiers cannot appear here");
    expect(diagnostic?.code).toBe(1184);
    expect(diagnostic?.line).toBe(1);
  });

  it("leaves a plain interface script diagnostic-free", () => {
    const result = compileWorkflowScript(
      `interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;`,
    );
    expect(result).toEqual({ diagnostics: [], ok: true });
  });

  it("keeps the original message for other misplaced modifiers", () => {
    // Fallback: only the exact `declare` / `export` spans are rewritten, so an
    // unrelated TS1184 still reads as the compiler wrote it.
    const result = compileWorkflowScript(`public const z = 1;\nreturn z;`);
    const misplaced = result.diagnostics.find((d) => d.code === 1184);
    expect(misplaced?.message).toBe("Modifiers cannot appear here.");
  });
});

// 脚本以 `strict` 编译但**关闭** `noUncheckedIndexedAccess`（决策记录：docs/dynamic-workflow/
// authoring.md「Compiler options」）。模型按该开关关闭的世界书写——训练语料几乎全是关闭的——
// 开着时 `items[i]` 上的 TS2532/TS18048 是编译失败的最大单一来源，且几乎全落在周围逻辑已经
// 证明了边界的索引上。这里钉住两侧：索引读取不再报 undefined；而 `strictNullChecks` 覆盖的
// 真实风险（`.find()`、`match()`、可选属性、可选参数）仍然照旧报错。
describe("undefined diagnostics under the chosen strictness", () => {
  it("accepts an unguarded array index", () => {
    const result = compileWorkflowScript(
      `const xs: number[] = [1, 2, 3];\nreturn xs[0].toFixed(0);`,
    );
    expect(result).toEqual({ diagnostics: [], ok: true });
  });

  it("accepts an unguarded record index and a computed 2-D index", () => {
    const result = compileWorkflowScript(
      [
        `const m: Record<string, number> = {};`,
        `const b: string[][] = [["."]];`,
        `let n = 0;`,
        `for (let r = 0; r < b.length; r++) for (let c = 0; c < b[r].length; c++) n += b[r][c].length;`,
        `return m["k"].toFixed(n);`,
      ].join("\n"),
    );
    expect(result).toEqual({ diagnostics: [], ok: true });
  });

  it("still reports a dereferenced `.find()` result", () => {
    const result = compileWorkflowScript(
      `const xs: string[] = [];\nconst hit = xs.find((x) => x.length > 0);\nreturn hit.length;`,
    );
    expect(result.diagnostics[0]?.code).toBe(18048);
    expect(result.diagnostics[0]?.message).toContain("'hit' is possibly 'undefined'");
  });

  it("still reports a dereferenced `match()` result", () => {
    const result = compileWorkflowScript(`const m = "a1".match(/\\d/);\nreturn m[0];`);
    expect(result.diagnostics[0]?.code).toBe(18047);
    expect(result.diagnostics[0]?.message).toContain("possibly 'null'");
  });

  it("still reports an optional property and an optional parameter", () => {
    const property = compileWorkflowScript(
      `interface R { a?: string }\nconst r: R = {};\nreturn r.a.length;`,
    );
    expect(property.diagnostics[0]?.code).toBe(18048);
    const parameter = compileWorkflowScript(`const f = (x?: string) => x.length;\nreturn f("a");`);
    expect(parameter.diagnostics[0]?.code).toBe(18048);
  });
});

// The submit path compiles once and shares the one `ts.Program` across all four
// consumers (diagnostics / site table / schema synthesis / lowering); see the
// 「编译一次」 boundary in docs/dynamic-workflow/presentation.md. These assertions pin the
// promotion of `createWorkflowProgram` + `collectSites` onto the public surface, and
// that one program yields byte-identical site ids to the three-program convenience
// entries. Site ids are journal keys: a drift here surfaces as a `script_hash` /
// `inputHash` mismatch at resume, a long way from its cause.
describe("public one-program chain", () => {
  const script = [
    `const paths = await files.glob("src/**/*.ts");`,
    `const lead = agent("lead");`,
    `const plan = await lead.ask<{ steps: string[] }>("Plan the work.");`,
    `const notes = await agent("scribe").ask("Summarize.");`,
    `return { plan, notes, count: paths.length };`,
  ].join("\n");

  it("shares one program across site collection, schema synthesis and lowering", () => {
    const workflow = createWorkflowProgram(script);
    expect(collectDiagnostics(workflow.program)).toEqual([]);

    const table = collectSites(workflow);
    const { diagnostics, schemas } = synthesizeAskSchemas(workflow, table);
    const lowered = lowerWorkflow(workflow, table);

    expect(diagnostics).toEqual([]);
    expect(table.asks.map((a) => a.id)).toEqual(["ask#1", "ask#2"]);
    // A typed ask gets a schema, an untyped one does not: the keys of `schemas` ARE the
    // typed-ask predicate.
    expect(Object.keys(schemas)).toEqual(["ask#1"]);
    expect(lowered.siteIds).toContain("ask#1");
  });

  it("produces the same site ids as the separate script-level entries", () => {
    const workflow = createWorkflowProgram(script);
    const table = collectSites(workflow);

    // analyze / synthesize / lower each build their own program; one compile must agree
    // with them verbatim.
    const analyzed = analyzeWorkflowScript(script);
    expect(analyzed.ok).toBe(true);
    // The graph's ask / world-read nodes are exactly the table's sites (source / sink are
    // virtual endpoints and have none).
    const graphSiteIds = (analyzed.graph?.nodes ?? [])
      .filter((n) => n.kind === "ask" || n.kind === "world-read")
      .map((n) => n.id)
      .sort();
    const tableSiteIds = [...table.asks.map((a) => a.id), ...table.worldReads.map((w) => w.id)].sort();
    expect(graphSiteIds).toEqual(tableSiteIds);
    expect(tableSiteIds).toEqual(["ask#1", "ask#2", "world-read#1"]);

    expect(Object.keys(synthesizeAskSchemas(workflow, table).schemas)).toEqual(
      Object.keys(synthesizeWorkflowSchemas(script).schemas),
    );
    expect(lowerWorkflow(workflow, table)).toEqual(lowerWorkflowScript(script).lowered);
  });

  it("leaves site ids untouched when the same program is walked twice", () => {
    // Site ids come from independent per-kind counters, reset on every collectSites call:
    // walking one program twice must not drift the numbering. A newly collected construct
    // that consumed the global `order` counter would fail this.
    const workflow = createWorkflowProgram(script);
    const first = collectSites(workflow);
    const second = collectSites(workflow);
    expect(second.asks.map((a) => a.id)).toEqual(first.asks.map((a) => a.id));
    expect(second.worldReads.map((w) => w.id)).toEqual(first.worldReads.map((w) => w.id));
    expect(second.asks.map((a) => a.order)).toEqual(first.asks.map((a) => a.order));
  });
});
