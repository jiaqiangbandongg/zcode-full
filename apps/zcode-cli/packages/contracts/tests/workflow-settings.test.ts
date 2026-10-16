import { describe, expect, it } from "vitest";
import {
  AmendWorkflowInputJsonSchema,
  AmendWorkflowInputSchema,
  CreateWorkflowInputJsonSchema,
  CreateWorkflowInputSchema,
  parseWorkflowSettingsAdjustment,
} from "../src/index.js";

// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」

describe("adjustable_settings on the workflow tools' input", () => {
  const block = { subagent_model: true, concurrency_ceiling: 13 };

  it("is accepted by both runtime schemas and strict about its own keys", () => {
    expect(
      CreateWorkflowInputSchema.safeParse({ script: "x", adjustable_settings: block }).success,
    ).toBe(true);
    expect(
      AmendWorkflowInputSchema.safeParse({ run_id: "r", adjustable_settings: block }).success,
    ).toBe(true);
    expect(
      CreateWorkflowInputSchema.safeParse({
        script: "x",
        adjustable_settings: { ...block, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it("is never offered to the model", () => {
    const createProps = (CreateWorkflowInputJsonSchema as { properties?: object }).properties ?? {};
    const amendProps = (AmendWorkflowInputJsonSchema as { properties?: object }).properties ?? {};
    expect(createProps).not.toHaveProperty("adjustable_settings");
    expect(amendProps).not.toHaveProperty("adjustable_settings");
  });
});

describe("parseWorkflowSettingsAdjustment", () => {
  it("keeps the two known fields in the tool's tri-state", () => {
    expect(
      parseWorkflowSettingsAdjustment({ subagent_model: "a/b$high", max_concurrency: 4 }),
    ).toEqual({
      subagent_model: "a/b$high",
      max_concurrency: 4,
    });
    expect(
      parseWorkflowSettingsAdjustment({ subagent_model: null, max_concurrency: null }),
    ).toEqual({
      subagent_model: null,
      max_concurrency: null,
    });
  });

  it("drops unknown keys, and answers nothing when no known key is left", () => {
    expect(parseWorkflowSettingsAdjustment({ max_concurrency: 2, color: "red" })).toEqual({
      max_concurrency: 2,
    });
    expect(parseWorkflowSettingsAdjustment({ color: "red" })).toBeUndefined();
    expect(parseWorkflowSettingsAdjustment(undefined)).toBeUndefined();
  });

  it("has no upper limit on the bound: the default parallelism is a starting point, not a cap", () => {
    expect(parseWorkflowSettingsAdjustment({ max_concurrency: 50_000 })).toEqual({
      max_concurrency: 50_000,
    });
  });

  it("rejects a malformed value as a whole", () => {
    expect(parseWorkflowSettingsAdjustment({ max_concurrency: 0 })).toBeUndefined();
    expect(parseWorkflowSettingsAdjustment({ subagent_model: "  " })).toBeUndefined();
  });
});

// docs/dynamic-workflow/launch.md「Models the script names」
describe("model_bindings on the workflow tools' input (never in the window's answer)", () => {
  const bindings = { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash", " spaced ": "acme/gpt-5" };

  it("is accepted by both runtime schemas, keys kept verbatim, and never offered to the model", () => {
    const create = CreateWorkflowInputSchema.safeParse({ script: "x", model_bindings: bindings });
    expect(create.success).toBe(true);
    expect(create.data?.model_bindings).toEqual(bindings);
    expect(
      AmendWorkflowInputSchema.safeParse({ run_id: "r", model_bindings: bindings }).success,
    ).toBe(true);
    expect(JSON.stringify(CreateWorkflowInputJsonSchema)).not.toContain("model_bindings");
    expect(JSON.stringify(AmendWorkflowInputJsonSchema)).not.toContain("model_bindings");
  });

  it("is bounded: empty names, blank models and oversized tables are rejected", () => {
    expect(
      CreateWorkflowInputSchema.safeParse({ script: "x", model_bindings: { "": "a/b" } }).success,
    ).toBe(false);
    expect(
      CreateWorkflowInputSchema.safeParse({ script: "x", model_bindings: { a: "  " } }).success,
    ).toBe(false);
    const huge = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`m${index}`, "a/b"]));
    expect(CreateWorkflowInputSchema.safeParse({ script: "x", model_bindings: huge }).success).toBe(
      false,
    );
  });

  it("an answer cannot carry model_bindings: the window never offers them, so the key is dropped", () => {
    expect(
      parseWorkflowSettingsAdjustment({ model_bindings: { a: "zhipu/GLM-5.3" } }),
    ).toBeUndefined();
    expect(
      parseWorkflowSettingsAdjustment({
        max_concurrency: 3,
        model_bindings: { a: "zhipu/GLM-5.3" },
      }),
    ).toEqual({ max_concurrency: 3 });
  });
});
