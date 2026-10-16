import { describe, expect, it } from "vitest";
import {
  SUBMIT_RESULT_TOOL_NAME,
  SubmitResultInputJsonSchema,
  SubmitResultInputSchema,
  SubmitResultOutputSchema,
  typedSubmitResultInputSchema,
} from "../src/tools/submit-result.js";

describe("submit_result contracts", () => {
  it("names the tool submit_result", () => {
    expect(SUBMIT_RESULT_TOOL_NAME).toBe("submit_result");
  });

  it("accepts arbitrary JSON as the generic result payload", () => {
    // 声明的输入有意通用：具体 per-ask schema 在 ask epilogue 里，不进工具声明。
    for (const result of [
      { any: "object", nested: { ok: true } },
      ["a", 1, null],
      "plain string",
      42,
      true,
      null,
    ]) {
      const parsed = SubmitResultInputSchema.parse({ result });
      expect(parsed.result).toEqual(result);
    }
  });

  it("rejects unknown top-level properties (strict object)", () => {
    const parsed = SubmitResultInputSchema.safeParse({ result: {}, extra: 1 });
    expect(parsed.success).toBe(false);
  });

  it("exposes a permissive JSON schema for result and forbids extra keys", () => {
    expect(SubmitResultInputJsonSchema.type).toBe("object");
    // result 是无约束的任意 JSON：其子 schema 不带类型约束。
    const resultSchema = (SubmitResultInputJsonSchema.properties as Record<string, unknown>).result;
    expect(resultSchema).toBeDefined();
    expect((resultSchema as Record<string, unknown>).type).toBeUndefined();
    expect(SubmitResultInputJsonSchema.additionalProperties).toBe(false);
  });

  it("only accepts the accepted-status output", () => {
    expect(SubmitResultOutputSchema.parse({ status: "accepted" })).toEqual({ status: "accepted" });
    expect(SubmitResultOutputSchema.safeParse({ status: "rejected" }).success).toBe(false);
  });

  // mono 子代理的 typed 声明（docs/execution-engine.md「Typed asks and `submit_result`」）：外层与通用声明同形，
  // `result` 就是该 actor 唯一的 ask 结果 schema。
  it("builds the typed declaration around the ask schema, same outer shape as the generic one", () => {
    const resultSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        points: { type: "array", items: { type: "string" } },
      },
      required: ["title", "points"],
      additionalProperties: false,
    };
    const typed = typedSubmitResultInputSchema(resultSchema);
    expect(typed.type).toBe("object");
    expect(typed.required).toEqual(["result"]);
    expect(typed.additionalProperties).toBe(false);
    expect(typed.$schema).toBe(SubmitResultInputJsonSchema.$schema);
    const result = (typed.properties as Record<string, Record<string, unknown>>).result;
    expect(result).toMatchObject(resultSchema);
    expect(typeof result.description).toBe("string");
  });

  it("keeps the ask schema's own description when it has one", () => {
    const typed = typedSubmitResultInputSchema({ type: "string", description: "A verdict." });
    const result = (typed.properties as Record<string, Record<string, unknown>>).result;
    expect(result.description).toBe("A verdict.");
  });
});
