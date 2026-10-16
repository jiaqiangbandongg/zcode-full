import { describe, expect, it } from "vitest";
import {
  LIST_MODELS_TOOL_NAME,
  ListModelsInputJsonSchema,
  ListModelsInputSchema,
  ListModelsOutputSchema,
} from "../src/tools/list-models.js";

// docs/dynamic-workflow/launch.md：dwf 选型的发现面。只读、无入参、输出的每一行都能逐字
// 填进 `subagent_model`。
describe("ListModels contract", () => {
  it("names the tool exactly as it registers and takes no input", () => {
    expect(LIST_MODELS_TOOL_NAME).toBe("ListModels");
    expect(ListModelsInputSchema.parse({})).toEqual({});
    // 没有过滤 / 分页旋钮：多一个就多一处让模型以为「没列全」的地方。
    expect(ListModelsInputSchema.safeParse({ provider: "zhipu" }).success).toBe(false);
    const schema = ListModelsInputJsonSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("round-trips a catalog with a current model and keeps optional facts absent", () => {
    const output = {
      current: "zhipu/glm-5.3",
      models: [
        {
          id: "zhipu/glm-5.3",
          providerId: "zhipu",
          modelId: "glm-5.3",
          providerLabel: "Zhipu",
          reasoningLevels: ["low", "high"],
          defaultReasoningLevel: "high",
          contextWindow: 200_000,
        },
        // 没有推理档位的模型是**空数组**而不是缺席：读侧据此知道接 `$level` 是错的。
        { id: "anthropic/haiku", providerId: "anthropic", modelId: "haiku", reasoningLevels: [] },
      ],
    };
    const parsed = ListModelsOutputSchema.parse(output);
    expect(parsed).toEqual(output);
    expect("providerLabel" in parsed.models[1]!).toBe(false);
    expect("disabledReason" in parsed.models[1]!).toBe(false);
  });

  it("keeps current absent when nothing in the catalog matches the session model", () => {
    const parsed = ListModelsOutputSchema.parse({ models: [] });
    expect("current" in parsed).toBe(false);
  });

  it("stays strict about unknown keys on an entry", () => {
    expect(
      ListModelsOutputSchema.safeParse({
        models: [{ id: "a/b", providerId: "a", modelId: "b", reasoningLevels: [], tier: "lite" }],
      }).success,
    ).toBe(false);
  });
});
