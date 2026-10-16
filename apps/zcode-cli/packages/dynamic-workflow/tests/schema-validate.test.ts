import { describe, expect, it } from "vitest";
import { formatViolation, formatViolations, validate, type JsonSchema } from "../src/index.js";

// 校验器单测：逐个覆盖我们发射的每种 schema 构造，外加违规格式化（path/expected/got）、
// 嵌套路径、以及一次校验多条违规。

describe("validate: primitives", () => {
  it("accepts matching primitive types", () => {
    expect(validate({ type: "string" }, "hi")).toEqual([]);
    expect(validate({ type: "number" }, 3.5)).toEqual([]);
    expect(validate({ type: "boolean" }, true)).toEqual([]);
    expect(validate({ type: "null" }, null)).toEqual([]);
  });

  it("flags a type mismatch at the root path", () => {
    expect(validate({ type: "string" }, 3)).toEqual([{ expected: "string", got: "number 3", path: "$" }]);
  });

  it("rejects NaN / non-finite as a number", () => {
    expect(validate({ type: "number" }, Number.NaN)).toHaveLength(1);
  });
});

describe("validate: const and enum", () => {
  it("checks const via deep equality", () => {
    expect(validate({ const: "ready" }, "ready")).toEqual([]);
    expect(validate({ const: "ready" }, "done")).toEqual([
      { expected: 'string "ready"', got: 'string "done"', path: "$" },
    ]);
  });

  it("checks enum membership including null and booleans", () => {
    const schema: JsonSchema = { enum: ["a", "b", null] };
    expect(validate(schema, "b")).toEqual([]);
    expect(validate(schema, null)).toEqual([]);
    expect(validate(schema, "c")).toEqual([
      { expected: 'one of string "a", string "b", null', got: 'string "c"', path: "$" },
    ]);
  });
});

describe("validate: object", () => {
  const schema: JsonSchema = {
    additionalProperties: false,
    properties: { age: { type: "number" }, name: { type: "string" } },
    required: ["name"],
    type: "object",
  };

  it("accepts a valid object (optional prop absent)", () => {
    expect(validate(schema, { name: "x" })).toEqual([]);
  });

  it("flags a missing required property", () => {
    expect(validate(schema, { age: 3 })).toEqual([{ expected: "present", got: "missing", path: "$.name" }]);
  });

  it("flags an additional property when additionalProperties is false", () => {
    expect(validate(schema, { extra: 1, name: "x" })).toEqual([
      { expected: "no additional property", got: "number 1", path: "$.extra" },
    ]);
  });

  it("validates a string index signature (Record)", () => {
    const record: JsonSchema = { additionalProperties: { type: "number" }, type: "object" };
    expect(validate(record, { a: 1, b: 2 })).toEqual([]);
    expect(validate(record, { a: "no" })).toEqual([{ expected: "number", got: 'string "no"', path: "$.a" }]);
  });

  it("recurses into nested object paths", () => {
    const nested: JsonSchema = {
      additionalProperties: false,
      properties: { inner: { additionalProperties: false, properties: { flag: { type: "boolean" } }, required: ["flag"], type: "object" } },
      required: ["inner"],
      type: "object",
    };
    expect(validate(nested, { inner: { flag: 1 } })).toEqual([
      { expected: "boolean", got: "number 1", path: "$.inner.flag" },
    ]);
  });
});

describe("validate: arrays and tuples", () => {
  it("validates array items", () => {
    const schema: JsonSchema = { items: { type: "string" }, type: "array" };
    expect(validate(schema, ["a", "b"])).toEqual([]);
    expect(validate(schema, ["a", 2])).toEqual([{ expected: "string", got: "number 2", path: "$[1]" }]);
  });

  it("validates tuple prefixItems and length bounds", () => {
    const schema: JsonSchema = { maxItems: 2, minItems: 2, prefixItems: [{ type: "string" }, { type: "number" }], type: "array" };
    expect(validate(schema, ["x", 1])).toEqual([]);
    expect(validate(schema, ["x"])).toEqual([{ expected: "at least 2 items", got: "array(1)", path: "$" }]);
    expect(validate(schema, ["x", 1, 2])).toEqual([{ expected: "at most 2 items", got: "array(3)", path: "$" }]);
    expect(validate(schema, [1, "x"])).toEqual([
      { expected: "string", got: "number 1", path: "$[0]" },
      { expected: "number", got: 'string "x"', path: "$[1]" },
    ]);
  });

  it("validates a tuple rest tail via items", () => {
    const schema: JsonSchema = { items: { type: "number" }, minItems: 1, prefixItems: [{ type: "string" }], type: "array" };
    expect(validate(schema, ["x", 1, 2, 3])).toEqual([]);
    expect(validate(schema, ["x", 1, "no"])).toEqual([{ expected: "number", got: 'string "no"', path: "$[2]" }]);
  });
});

describe("validate: anyOf", () => {
  const schema: JsonSchema = { anyOf: [{ type: "string" }, { type: "number" }] };

  it("passes when any branch matches", () => {
    expect(validate(schema, "x")).toEqual([]);
    expect(validate(schema, 3)).toEqual([]);
  });

  it("flags when no branch matches", () => {
    expect(validate(schema, true)).toEqual([{ expected: "one of 2 variants", got: "boolean true", path: "$" }]);
  });
});

describe("validate: string and number constraints", () => {
  it("checks string length, pattern", () => {
    expect(validate({ minLength: 2, type: "string" }, "a")).toEqual([
      { expected: "string length >= 2", got: "length 1", path: "$" },
    ]);
    expect(validate({ pattern: "^a", type: "string" }, "ba")).toEqual([
      { expected: "match /^a/", got: 'string "ba"', path: "$" },
    ]);
  });

  it("checks numeric bounds inclusive and exclusive", () => {
    expect(validate({ minimum: 0, type: "number" }, -1)).toEqual([{ expected: ">= 0", got: "number -1", path: "$" }]);
    expect(validate({ exclusiveMaximum: 10, type: "number" }, 10)).toEqual([
      { expected: "< 10", got: "number 10", path: "$" },
    ]);
    expect(validate({ type: "integer" }, 1.5)).toEqual([{ expected: "integer", got: "number 1.5", path: "$" }]);
  });
});

describe("validate: $ref / $defs and permissive empty schema", () => {
  it("resolves $ref against the root $defs (recursive)", () => {
    const root: JsonSchema = {
      $defs: {
        Tree: {
          additionalProperties: false,
          properties: { children: { items: { $ref: "#/$defs/Tree" }, type: "array" }, value: { type: "number" } },
          required: ["value", "children"],
          type: "object",
        },
      },
      $ref: "#/$defs/Tree",
    };
    expect(validate(root, { children: [{ children: [], value: 2 }], value: 1 })).toEqual([]);
    expect(validate(root, { children: [{ children: [], value: "no" }], value: 1 })).toEqual([
      { expected: "number", got: 'string "no"', path: "$.children[0].value" },
    ]);
  });

  it("empty schema accepts any JSON (unknown)", () => {
    expect(validate({}, { anything: [1, "two", null] })).toEqual([]);
    expect(validate({}, null)).toEqual([]);
  });
});

describe("violation formatting", () => {
  it("formats one violation as a single line", () => {
    expect(formatViolation({ expected: "string", got: "number 3", path: "$.name" })).toBe(
      "$.name: expected string, got number 3",
    );
  });

  it("joins multiple violations one per line", () => {
    const text = formatViolations([
      { expected: "string", got: "number 1", path: "$[0]" },
      { expected: "present", got: "missing", path: "$.name" },
    ]);
    expect(text).toBe("$[0]: expected string, got number 1\n$.name: expected present, got missing");
  });
});
