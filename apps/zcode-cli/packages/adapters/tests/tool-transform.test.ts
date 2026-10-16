// ============================================================
// Model Tool Transform Tests
// ============================================================

import { describe, expect, it } from "vitest";
import type { ModelToolContract } from "@zcode/contracts";
import { toAiSdkTools } from "../src/model/index.js";

function createClientToolContract(): ModelToolContract {
  return {
    name: "Read",
    capability: "read_file",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    outputSchema: { type: "object" },
    readOnly: true,
  };
}

function readToolJsonSchema(toolValue: unknown): Record<string, unknown> {
  return (toolValue as { inputSchema: { jsonSchema: Record<string, unknown> } }).inputSchema
    .jsonSchema;
}

describe("model tool transforms", () => {
  it("opts Anthropic client-side tools out of eager input streaming", () => {
    const tools = toAiSdkTools([createClientToolContract()], {
      providerKind: "anthropic",
    });

    expect(tools?.Read).toMatchObject({
      providerOptions: {
        anthropic: {
          eagerInputStreaming: false,
        },
      },
    });
  });

  it("does not add Anthropic tool provider options for non-Anthropic providers", () => {
    const tools = toAiSdkTools([createClientToolContract()], {
      providerKind: "openai",
    });

    expect(
      (tools?.Read as { providerOptions?: unknown } | undefined)?.providerOptions,
    ).toBeUndefined();
  });

  it("hoists Kimi K3 local property refs into root defs without mutating the contract", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      properties: {
        func: {
          type: "object",
          properties: {
            vpc: {
              type: "object",
              properties: { vpcId: { type: "string" } },
              required: ["vpcId"],
            },
            triggers: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
        vpc: { $ref: "#/properties/func/properties/vpc" },
        triggers: {
          type: "array",
          items: { $ref: "#/properties/func/properties/triggers/items" },
        },
      },
    };

    const tools = toAiSdkTools([contract], {
      providerKind: "openai-compatible",
      requiresMfjsToolSchema: true,
    });
    const schema = readToolJsonSchema(tools?.Read);

    expect(schema).toMatchObject({
      $defs: {
        zcode_ref_0: {
          type: "object",
          properties: { vpcId: { type: "string" } },
          required: ["vpcId"],
        },
        zcode_ref_1: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      properties: {
        vpc: { $ref: "#/$defs/zcode_ref_0" },
        triggers: {
          items: { $ref: "#/$defs/zcode_ref_1" },
        },
      },
    });
    expect(contract.inputSchema).toMatchObject({
      properties: {
        vpc: { $ref: "#/properties/func/properties/vpc" },
        triggers: {
          items: { $ref: "#/properties/func/properties/triggers/items" },
        },
      },
    });
    expect(contract.inputSchema).not.toHaveProperty("$defs");
  });

  it("applies Kimi K3 tool schema compatibility to the 256K variant", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        alias: { $ref: "#/properties/source" },
      },
    };

    const tools = toAiSdkTools([contract], {
      providerKind: "openai-compatible",
      requiresMfjsToolSchema: true,
    });

    expect(readToolJsonSchema(tools?.Read)).toMatchObject({
      $defs: {
        zcode_ref_0: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      properties: {
        alias: { $ref: "#/$defs/zcode_ref_0" },
      },
    });
  });

  it("keeps local property refs unchanged when MFJS projection is disabled", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      properties: {
        source: { type: "object", properties: { id: { type: "string" } } },
        alias: { $ref: "#/properties/source" },
      },
    };

    const tools = toAiSdkTools([contract], {
      providerKind: "openai-compatible",
      requiresMfjsToolSchema: false,
    });

    expect(readToolJsonSchema(tools?.Read)).toBe(contract.inputSchema);
  });

  it("rejects an unresolvable local ref before request execution", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      properties: { alias: { $ref: "#/properties/missing" } },
    };

    expect(() =>
      toAiSdkTools([contract], {
        providerKind: "openai-compatible",
        requiresMfjsToolSchema: true,
      }),
    ).toThrowError(/Read.*#\/properties\/missing/u);
  });
});
