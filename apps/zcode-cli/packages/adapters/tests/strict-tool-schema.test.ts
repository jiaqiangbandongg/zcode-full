// ============================================================
// Anthropic strict 工具 schema：资格判定 + 子集折叠
// ============================================================

import { describe, expect, it } from "vitest";
import type { ModelToolContract } from "@zcode/contracts";
import { toAiSdkTools } from "../src/model/index.js";
import { isAnthropicFirstPartyModelId, toStrictToolSchema } from "../src/model/strict-tool-schema.js";

/** dwf 合成器会发射的一份典型 mono 子代理 schema（外层 `{ result }` 由 contracts 包起来）。 */
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    result: {
      type: "object",
      description: "The structured result for this ask.",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "Where it is." },
              line: { type: "number", minimum: 1 },
              severity: { enum: ["low", "high"] },
              evidence: { type: "string", minLength: 3, maxLength: 200 },
            },
            required: ["file", "line", "severity"],
            additionalProperties: false,
          },
        },
        adequate: { type: "boolean" },
        notes: { anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-z]+$" }] },
        when: { type: "string", format: "date-time" },
        slug: { type: "string", format: "kebab-case" },
      },
      required: ["findings", "adequate", "notes"],
      additionalProperties: false,
    },
  },
  required: ["result"],
  additionalProperties: false,
};

function submitContract(inputSchema: Record<string, unknown>, strict = true): ModelToolContract {
  return {
    name: "submit_result",
    capability: "submit",
    description: "Submit the structured result for the current ask.",
    inputSchema,
    outputSchema: { type: "object" },
    ...(strict ? { strict: true } : {}),
  };
}

function schemaOf(toolValue: unknown): Record<string, unknown> {
  return (toolValue as { inputSchema: { jsonSchema: Record<string, unknown> } }).inputSchema
    .jsonSchema;
}

function at(schema: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node: Record<string, unknown> = schema;
  for (const segment of path) node = node[segment] as Record<string, unknown>;
  return node;
}

describe("toStrictToolSchema — folding", () => {
  it("removes the keywords strict cannot take and folds them into descriptions", () => {
    const strict = toStrictToolSchema(REVIEW_SCHEMA);
    expect(strict).toBeDefined();
    const finding = at(strict!, [
      "properties",
      "result",
      "properties",
      "findings",
      "items",
      "properties",
    ]);
    expect(finding.line).toEqual({ type: "number", description: "minimum 1" });
    expect(finding.evidence).toEqual({
      type: "string",
      description: "at least 3 characters; at most 200 characters",
    });
    // 既有 description 保留在前，折叠的约束跟在括号里。
    expect(finding.file).toEqual({ type: "string", description: "Where it is." });
    const result = at(strict!, ["properties", "result", "properties"]);
    expect((result.notes as { anyOf: unknown[] }).anyOf[1]).toEqual({
      type: "string",
      description: "must match /^[a-z]+$/",
    });
    // strict 认识的 format 保留；不认识的折进 description。
    expect(result.when).toEqual({ type: "string", format: "date-time" });
    expect(result.slug).toEqual({ type: "string", description: "format kebab-case" });
  });

  it("leaves an already-strict schema byte-identical and never mutates its input", () => {
    const input = {
      type: "object",
      properties: { ok: { type: "boolean" }, tags: { type: "array", items: { enum: ["a", "b"] } } },
      required: ["ok"],
      additionalProperties: false,
    };
    const snapshot = JSON.stringify(input);
    expect(toStrictToolSchema(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("closes objects that forgot additionalProperties and gives them an empty properties map", () => {
    expect(toStrictToolSchema({ type: "object", required: [] })).toEqual({
      type: "object",
      required: [],
      properties: {},
      additionalProperties: false,
    });
  });

  it("appends folded constraints to an existing description in parentheses", () => {
    expect(
      toStrictToolSchema({ type: "integer", description: "Age.", minimum: 0, maximum: 150 }),
    ).toEqual({
      type: "integer",
      description: "Age. (minimum 0; maximum 150)",
    });
  });
});

describe("toStrictToolSchema — ineligible shapes", () => {
  it.each([
    ["Record<string, T>", { type: "object", additionalProperties: { type: "string" } }],
    [
      "unknown ({})",
      { type: "object", properties: { any: {} }, required: ["any"], additionalProperties: false },
    ],
    [
      "recursive $ref",
      { type: "object", properties: { next: { $ref: "#/$defs/Node" } }, $defs: { Node: {} } },
    ],
    ["tuple", { type: "array", prefixItems: [{ type: "string" }], minItems: 1, maxItems: 1 }],
    [
      "nested Record inside anyOf",
      { anyOf: [{ type: "null" }, { type: "object", additionalProperties: { type: "number" } }] },
    ],
  ])("returns undefined for %s", (_label, schema) => {
    expect(toStrictToolSchema(schema as Record<string, unknown>)).toBeUndefined();
  });
});

describe("isAnthropicFirstPartyModelId", () => {
  it.each(["claude-opus-5", "claude-fable-5-1", "claude-sonnet-4-6"])("accepts %s", (id) => {
    expect(isAnthropicFirstPartyModelId(id)).toBe(true);
  });
  it.each(["glm-5.3", "gpt-5", "anthropic/claude-opus-5", undefined])("rejects %s", (id) => {
    expect(isAnthropicFirstPartyModelId(id)).toBe(false);
  });
});

describe("toAiSdkTools — strict forwarding", () => {
  it("forwards strict with the folded schema for an eligible contract on a first-party Claude model", () => {
    const tools = toAiSdkTools([submitContract(REVIEW_SCHEMA)], {
      providerKind: "anthropic",
      modelId: "claude-opus-5",
    });
    const tool = tools?.submit_result as { strict?: boolean } | undefined;
    expect(tool?.strict).toBe(true);
    const line = at(schemaOf(tool), [
      "properties",
      "result",
      "properties",
      "findings",
      "items",
      "properties",
      "line",
    ]);
    expect(line).toEqual({ type: "number", description: "minimum 1" });
  });

  it("sends the original schema without strict when the model is not first-party Claude", () => {
    const tools = toAiSdkTools([submitContract(REVIEW_SCHEMA)], {
      providerKind: "anthropic",
      modelId: "glm-5.3",
    });
    const tool = tools?.submit_result as { strict?: boolean } | undefined;
    expect(tool?.strict).toBeUndefined();
    expect(schemaOf(tool)).toEqual(REVIEW_SCHEMA);
  });

  it("sends the original schema without strict on non-Anthropic providers", () => {
    const tools = toAiSdkTools([submitContract(REVIEW_SCHEMA)], {
      providerKind: "openai-compatible",
      modelId: "claude-opus-5",
    });
    const tool = tools?.submit_result as { strict?: boolean } | undefined;
    expect(tool?.strict).toBeUndefined();
    expect(schemaOf(tool)).toEqual(REVIEW_SCHEMA);
  });

  it("ignores strict for a contract that never declared eligibility", () => {
    const tools = toAiSdkTools([submitContract(REVIEW_SCHEMA, false)], {
      providerKind: "anthropic",
      modelId: "claude-opus-5",
    });
    expect((tools?.submit_result as { strict?: boolean } | undefined)?.strict).toBeUndefined();
  });

  it("falls back to the full schema without strict when the shape is not expressible", () => {
    const recordSchema = {
      type: "object",
      properties: { result: { type: "object", additionalProperties: { type: "string" } } },
      required: ["result"],
      additionalProperties: false,
    };
    const tools = toAiSdkTools([submitContract(recordSchema)], {
      providerKind: "anthropic",
      modelId: "claude-opus-5",
    });
    const tool = tools?.submit_result as { strict?: boolean } | undefined;
    expect(tool?.strict).toBeUndefined();
    expect(schemaOf(tool)).toEqual(recordSchema);
  });
});
