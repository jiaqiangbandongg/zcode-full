import { describe, expect, it } from "vitest";
import {
  parseReplCode,
  collectTopLevelBindingNames,
  instrumentForContextPersistence,
  rewriteDynamicImports,
  rewriteDynamicImportsForRepl,
} from "../src/repl/instrument.js";

/** 解析 + 收集顶层绑定名的便捷断言：parse 成功后取名字数组。 */
function names(code: string): string[] {
  const parsed = parseReplCode(code);
  if ("parseError" in parsed) {
    throw parsed.parseError;
  }
  return collectTopLevelBindingNames(parsed.ast);
}

/** 解析 + instrument 的便捷断言。 */
function instrument(code: string): string {
  const parsed = parseReplCode(code);
  if ("parseError" in parsed) {
    throw parsed.parseError;
  }
  return instrumentForContextPersistence(code, parsed.ast);
}

describe("collectTopLevelBindingNames", () => {
  it("const single", () => {
    expect(names("const a = 1;")).toEqual(["a"]);
  });

  it("let multiple declarators", () => {
    expect(names("let a, b;")).toEqual(["a", "b"]);
  });

  it("var single", () => {
    expect(names("var c = 1;")).toEqual(["c"]);
  });

  it("object pattern", () => {
    expect(names("const { x, y } = o;")).toEqual(["x", "y"]);
  });

  it("object pattern with rename and rest", () => {
    expect(names("const { x: xx, ...rest } = o;")).toEqual(["xx", "rest"]);
  });

  it("nested array pattern", () => {
    expect(names("const [p, [q]] = arr;")).toEqual(["p", "q"]);
  });

  it("array pattern with rest", () => {
    expect(names("const [a, ...r] = arr;")).toEqual(["a", "r"]);
  });

  it("array pattern with elision (holes)", () => {
    expect(names("const [, b] = arr;")).toEqual(["b"]);
  });

  it("assignment pattern (default value)", () => {
    expect(names("const { x = 1 } = o;")).toEqual(["x"]);
  });

  it("function declaration", () => {
    expect(names("function f(){}")).toEqual(["f"]);
  });

  it("class declaration", () => {
    expect(names("class C {}")).toEqual(["C"]);
  });

  it("does NOT collect block-scoped declarations", () => {
    expect(names("{ const z = 1; }")).toEqual([]);
  });

  it("does NOT collect declarations inside function bodies", () => {
    expect(names("function f(){ const inner = 1; }")).toEqual(["f"]);
  });

  it("dedupes repeated names", () => {
    expect(names("var a = 1; var a = 2;")).toEqual(["a"]);
  });

  it("mixes declarations and other statements", () => {
    expect(names("const a = 1; console.log(a); function f(){}")).toEqual(["a", "f"]);
  });
});

describe("instrumentForContextPersistence", () => {
  it("appends globalThis assignment after a const", () => {
    const out = instrument("const a = 1;");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("globalThis.a=a;");
  });

  it("appends one assignment per declared name", () => {
    const out = instrument("let a, b;");
    expect(out).toContain("globalThis.a=a;");
    expect(out).toContain("globalThis.b=b;");
  });

  it("handles destructuring names", () => {
    const out = instrument("const { x: xx, ...rest } = o;");
    expect(out).toContain("globalThis.xx=xx;");
    expect(out).toContain("globalThis.rest=rest;");
  });

  it("instruments function and class declarations", () => {
    const out = instrument("function f(){} class C {}");
    expect(out).toContain("globalThis.f=f;");
    expect(out).toContain("globalThis.C=C;");
  });

  it("preserves ordering with interleaved plain statements", () => {
    const out = instrument("const a = 1; foo(); const b = 2;");
    const idxA = out.indexOf("globalThis.a=a;");
    const idxFoo = out.indexOf("foo()");
    const idxB = out.indexOf("globalThis.b=b;");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxFoo).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxFoo);
  });

  it("returns the last top-level expression statement as completion value", () => {
    // Bugfix 回归：末尾表达式语句要转成 return，让外层 async-IIFE 回传其值（REPL 回显）。
    const out = instrument("foo(); bar();");
    expect(out).toBe("foo(); return (bar());");
  });

  it("wraps a trailing await expression as returned completion value", () => {
    const out = instrument("await tab.snapshot();");
    expect(out).toBe("return (await tab.snapshot());");
  });

  it("returns a parenthesized object without inserting return inside its parens", () => {
    expect(instrument("({ value: 1 });")).toBe("return (({ value: 1 }));");
  });

  it("does NOT return when the last statement is a declaration", () => {
    const out = instrument("const tab = await open();");
    expect(out).not.toContain("return (");
    expect(out).toContain("globalThis.tab=tab;");
  });

  it("does NOT inject for block-scoped declarations", () => {
    const out = instrument("{ const z = 1; }");
    expect(out).not.toContain("globalThis.z");
  });
});

describe("parseReplCode", () => {
  it("returns ast for valid code", () => {
    const parsed = parseReplCode("const x = 1;");
    expect("ast" in parsed).toBe(true);
  });

  it("returns parseError for invalid code", () => {
    const parsed = parseReplCode("const x = (");
    expect("parseError" in parsed).toBe(true);
    if ("parseError" in parsed) {
      expect(parsed.parseError).toBeInstanceOf(Error);
    }
  });
});

describe("rewriteDynamicImports", () => {
  it("rewrites import expressions without touching strings or import.meta", () => {
    const code = 'const word = "import(ignored)"; const mod = await import("node:path");';
    const parsed = parseReplCode(code);
    if ("parseError" in parsed) throw parsed.parseError;

    const rewritten = rewriteDynamicImports(code, parsed.ast);

    expect(rewritten).toContain('"import(ignored)"');
    expect(rewritten).toContain('await importModule("node:path")');
  });

  it("rewrites import when the REPL cell also contains a top-level return", () => {
    expect(
      rewriteDynamicImportsForRepl('const mod = await import("node:path"); return mod.sep;'),
    ).toContain('await importModule("node:path")');
  });
});
