import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
} from "../src/index.js";

describe("Todo 21 resolver", () => {
  it("Builtin-wins，单数组重复保留第一个，不创建冲突身份", () => {
    const result = resolve({
      builtinModelIds: ["a", "a", "b"],
      personalModelIds: ["b", "c", "c"],
    });

    expect(result.resolvedProviders[0]?.models.map((model) => model.modelId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.resolvedProviders[0]?.models.map((model) => model.kind)).toEqual([
      "candidate",
      "candidate",
      "candidate",
    ]);
    expect(result.resolvedProviders[0]?.models.map((model) => model.source)).toEqual([
      "builtin",
      "builtin",
      "personal",
    ]);
    expect(result.issues.some((issue) => issue.code === "duplicate-model")).toBe(false);
  });

  it("按未排序 Built-in + modelOrder 有效成员 + 未排序 Personal 生成唯一顺序", () => {
    const result = resolve({
      builtinModelIds: ["new-builtin", "builtin-a"],
      personalModelIds: ["personal-a", "manual-personal"],
      modelOrder: ["stale", "personal-a", "builtin-a", "personal-a"],
    });

    expect(result.resolvedProviders[0]?.models.map((model) => model.modelId)).toEqual([
      "new-builtin",
      "personal-a",
      "builtin-a",
      "manual-personal",
    ]);
    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual([
      "new-builtin",
      "personal-a",
      "builtin-a",
      "manual-personal",
    ]);
  });

  it("Model enabled 是唯一模型执行门禁，Provider hidden 只影响 selectable", () => {
    const result = resolve({ visibility: "hidden", disabledModelId: "b" });

    expect(result.resolvedProviders[0]?.models).toMatchObject([
      { modelId: "a", enabled: true, executable: true, selectable: false },
      { modelId: "b", enabled: false, executable: false, selectable: false },
    ]);
    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual(["a"]);
  });
});

function resolve(input: {
  readonly builtinModelIds?: readonly string[];
  readonly modelIds?: readonly string[];
  readonly modelOrder?: readonly string[];
  readonly visibility?: "visible" | "hidden";
  readonly disabledModelId?: string;
}) {
  const builtinModelIds = input.builtinModelIds ?? ["a", "b"];
  const modelIds = input.personalModelIds ?? [];
  return new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "provider-a",
        new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
          api: new ProviderApiConfig({
            type: "anthropic-messages",
            baseUrl: "https://example.com",
          }),
          builtinModelIds,
          visibility: input.visibility ?? "visible",
        }),
      ],
    ]),
    accountProviders: ProviderConfigMap.empty(),
    personalProviders: new ProviderConfigMap([
      [
        "provider-a",
        new ProviderConfig({ personalModelIds: modelIds, modelOrder: input.modelOrder }),
      ],
    ]),
    zcodeBuiltinModelRules: new ModelConfigRules([
      { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ...(input.disabledModelId
        ? [
            {
              type: "provider-model" as const,
              providerId: "provider-a",
              modelId: input.disabledModelId,
              config: new ModelConfig({ enabled: false }),
            },
          ]
        : []),
    ]),
    personalModels: ModelConfigRules.empty(),
  });
}

function completeModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 16_384,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
  });
}
