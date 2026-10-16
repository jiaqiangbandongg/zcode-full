import { describe, expect, it } from "vitest";
import {
  MAX_UNION_MEMBERS,
  SCHEMA_DIAGNOSTIC_CODE,
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  synthesizeAskSchemas,
  synthesizeWorkflowSchemas,
  type AskSpec,
  type JsonSchema,
} from "../src/index.js";

// 合成侧单测：用便捷入口 synthesizeWorkflowSchemas 从脚本文本一站式合成，精确断言
// 关键行为（快照套件覆盖整体输出，这里锁定语义细节）。

function schemasOf(script: string): Record<string, JsonSchema> {
  const result = synthesizeWorkflowSchemas(script);
  expect(result.diagnostics).toEqual([]);
  return result.schemas;
}

describe("typedness", () => {
  it("skips untyped asks: bare ask() and explicit ask<string>()", () => {
    const script = [
      `const a = agent("a");`,
      `const x = await a.ask("plain");`,
      `const y = await a.ask<string>("still plain");`,
      `log(x + y);`,
    ].join("\n");
    expect(schemasOf(script)).toEqual({});
  });

  it("synthesizes only for typed asks, keyed by site id", () => {
    const script = [
      `interface Plan { done: boolean }`,
      `const a = agent("a");`,
      `const p = await a.ask<Plan>("plan");`,
      `const t = await a.ask("text");`,
      `log(JSON.stringify(p) + t);`,
    ].join("\n");
    expect(Object.keys(schemasOf(script))).toEqual(["ask#1"]);
  });

  it("treats ask<string | null> as typed (not the bare string primitive)", () => {
    const script = [`const a = agent("a");`, `const v = await a.ask<string | null>("maybe");`, `log(String(v));`].join("\n");
    const schema = schemasOf(script)["ask#1"]!;
    expect(schema.anyOf).toHaveLength(2);
    expect(schema.anyOf).toEqual(expect.arrayContaining([{ type: "string" }, { type: "null" }]));
  });

  it("treats an alias of string as untyped (checker resolves it to string)", () => {
    const script = [
      `type Alias = string;`,
      `const a = agent("a");`,
      `const v = await a.ask<Alias>("plain");`,
      `log(v);`,
    ].join("\n");
    expect(schemasOf(script)).toEqual({});
  });
});

describe("unknown is permissive", () => {
  it("emits an empty schema for unknown", () => {
    const script = [`const a = agent("a");`, `const v = await a.ask<unknown>("anything");`, `log(String(v));`].join("\n");
    expect(schemasOf(script)["ask#1"]).toEqual({});
  });
});

describe("optional vs undefined", () => {
  it("optional property is excluded from required and drops undefined", () => {
    const script = [
      `interface R { a: string; b?: number }`,
      `const g = agent("g");`,
      `const r = await g.ask<R>("go");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    const schema = schemasOf(script)["ask#1"]!;
    expect(schema.required).toEqual(["a"]);
    expect(schema.properties?.b).toEqual({ type: "number" });
  });

  it("rejects a non-optional undefined-typed member", () => {
    const script = [
      `interface R { a: string | undefined }`,
      `const g = agent("g");`,
      `const r = await g.ask<R>("go");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    const result = synthesizeWorkflowSchemas(script);
    expect(result.schemas).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe(SCHEMA_DIAGNOSTIC_CODE);
    expect(result.diagnostics[0]!.message).toContain("undefined");
  });
});

describe("unions", () => {
  it("literal unions become enum", () => {
    const script = [
      `const g = agent("g");`,
      `const r = await g.ask<"low" | "high">("pick");`,
      `log(String(r));`,
    ].join("\n");
    expect(schemasOf(script)["ask#1"]).toEqual({ enum: ["low", "high"] });
  });

  it("general unions become anyOf", () => {
    const script = [
      `interface A { kind: "a" }`,
      `interface B { kind: "b" }`,
      `const g = agent("g");`,
      `const r = await g.ask<A | B>("pick");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    const schema = schemasOf(script)["ask#1"]!;
    expect(schema.anyOf).toHaveLength(2);
  });

  it("rejects a pathologically wide union at the ask site", () => {
    const members = Array.from({ length: MAX_UNION_MEMBERS + 1 }, (_, i) => String(i)).join(" | ");
    const script = [`const g = agent("g");`, `const r = await g.ask<${members}>("pick");`, `log(String(r));`].join("\n");
    const result = synthesizeWorkflowSchemas(script);
    expect(result.schemas).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.line).toBe(2);
    expect(result.diagnostics[0]!.message).toContain("too many members");
  });
});

describe("recursion via $defs/$ref", () => {
  it("hoists a self-referential type into $defs and references it", () => {
    const script = [
      `interface Tree { value: number; children: Tree[] }`,
      `const g = agent("g");`,
      `const r = await g.ask<Tree>("build");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    const schema = schemasOf(script)["ask#1"]!;
    expect(schema.$ref).toBe("#/$defs/Tree");
    const tree = schema.$defs?.Tree;
    expect(tree?.properties?.children).toEqual({ items: { $ref: "#/$defs/Tree" }, type: "array" });
  });

  it("keeps a non-recursive named type inline (no $defs)", () => {
    const script = [
      `interface Plan { step: string }`,
      `const g = agent("g");`,
      `const r = await g.ask<Plan>("plan");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    const schema = schemasOf(script)["ask#1"]!;
    expect(schema.$defs).toBeUndefined();
    expect(schema.type).toBe("object");
  });
});

describe("JSDoc harvest", () => {
  it("harvests description and the constraint-tag subset", () => {
    const script = [
      `interface Form {`,
      `  /**`,
      `   * The user's age.`,
      `   * @minimum 0`,
      `   * @maximum 120`,
      `   */`,
      `  age: number;`,
      `  /** @minLength 1 @pattern ^[a-z]+$ */`,
      `  name: string;`,
      `  /** @minItems 1 @maxItems 3 */`,
      `  tags: string[];`,
      `}`,
      `const g = agent("g");`,
      `const r = await g.ask<Form>("fill");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    const props = schemasOf(script)["ask#1"]!.properties!;
    expect(props.age).toEqual({ description: "The user's age.", maximum: 120, minimum: 0, type: "number" });
    expect(props.name).toEqual({ minLength: 1, pattern: "^[a-z]+$", type: "string" });
    expect(props.tags).toEqual({ items: { type: "string" }, maxItems: 3, minItems: 1, type: "array" });
  });

  it("ignores tags outside the subset", () => {
    const script = [
      `interface F {`,
      `  /**`,
      `   * @deprecated do not use`,
      `   * @minimum 5`,
      `   */`,
      `  n: number;`,
      `}`,
      `const g = agent("g");`,
      `const r = await g.ask<F>("go");`,
      `log(JSON.stringify(r));`,
    ].join("\n");
    expect(schemasOf(script)["ask#1"]!.properties!.n).toEqual({ minimum: 5, type: "number" });
  });
});

describe("buildAskSpecs — 引擎入参的总覆盖", () => {
  // 引擎把「站点缺席」当接线错误硬失败（MissingAskSpec），所以 askSpecs 必须**每个 ask
  // 站点都有一条**。schemas 只含 typed 站点，因此这个 builder 按站点表遍历——它存在的
  // 唯一理由就是把这条规则收在一处，而不是让每个调用点各自实现一遍（其中一处必然写错）。
  function specsOf(script: string): {
    specs: Map<string, AskSpec>;
    siteIds: string[];
    schemas: Record<string, JsonSchema>;
  } {
    const workflow = createWorkflowProgram(script);
    const table = collectSites(workflow);
    const { diagnostics, schemas } = synthesizeAskSchemas(workflow, table);
    expect(diagnostics).toEqual([]);
    return { specs: buildAskSpecs(table, schemas), siteIds: table.asks.map((a) => a.id), schemas };
  }

  it("covers every ask site, typed and untyped alike", () => {
    const script = [
      `interface Plan { done: boolean }`,
      `const a = agent("a");`,
      `const p = await a.ask<Plan>("plan");`,
      `const t = await a.ask("text");`,
      `log(JSON.stringify(p) + t);`,
    ].join("\n");

    const { specs, siteIds, schemas } = specsOf(script);
    expect([...specs.keys()]).toEqual(siteIds);
    expect(specs.size).toBe(2);
    // typed 站点的 schema 原样透传（builder 不加工 schema，只决定 typed 与否）。
    expect(specs.get("ask#1")).toEqual({ typed: true, schema: schemas["ask#1"] });
    expect(specs.get("ask#1")?.schema).toBe(schemas["ask#1"]);
    expect(specs.get("ask#2")).toEqual({ typed: false });
  });

  it("gives an untyped-only script a full table of explicit untyped entries", () => {
    // 这是那条兜底被删掉后真正的回归风险：从前 askSpecs 为空也能跑，现在必须显式记录。
    const script = [`const a = agent("a");`, `const x = await a.ask("one");`, `const y = await a.ask("two");`, `log(x + y);`].join("\n");
    const { specs } = specsOf(script);
    expect([...specs.entries()]).toEqual([
      ["ask#1", { typed: false }],
      ["ask#2", { typed: false }],
    ]);
  });

  it("leaves schema absent (not undefined) on untyped entries", () => {
    // schema 会随 AskMessage 透传给 driver；`schema: undefined` 与"没有 schema"在
    // 序列化与 `in` 判定上不同，untyped 条目必须是后者。
    const { specs } = specsOf([`const a = agent("a");`, `const x = await a.ask("plain");`, `log(x);`].join("\n"));
    const spec = specs.get("ask#1")!;
    expect("schema" in spec).toBe(false);
  });

  it("returns an empty table for a script with no asks", () => {
    const { specs } = specsOf([`const paths = await files.glob("*.ts");`, `log(String(paths.length));`].join("\n"));
    expect(specs.size).toBe(0);
  });

  it("ignores schema keys that no ask site claims", () => {
    // 防御：schemas 若因调用方拼错而带了不存在的站点，结果仍严格由站点表定形——
    // 站点表是身份的唯一真源。
    const script = [`const a = agent("a");`, `const x = await a.ask("plain");`, `log(x);`].join("\n");
    const workflow = createWorkflowProgram(script);
    const table = collectSites(workflow);
    const specs = buildAskSpecs(table, { "ask#42": { type: "string" } });
    expect([...specs.keys()]).toEqual(["ask#1"]);
    expect(specs.get("ask#1")).toEqual({ typed: false });
  });
});
