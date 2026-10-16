import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
} from "@zcode/provider";
import {
  listRegistryBackedModels,
  resolveRegistryOwnedModelSelection,
} from "../src/app/provider-registry-selection.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

describe("listRegistryBackedModels", () => {
  it("直接把 Registry 事实投影为协议 Model Option，不建立内部 alias DTO", () => {
    const registry = new ProviderRegistry([
      {
        providerId: "provider-a",
        config: createApiKeyProviderConfig({
          label: "Provider A",
          models: ["model-a", "model-b"],
        }),
        models: [
          { modelId: "model-a", config: completeModelConfig() },
          { modelId: "model-b", config: completeModelConfig() },
        ],
      },
    ]);

    const models = listRegistryBackedModels(registry, {
      providerId: "provider-a",
      modelId: "model-b",
      options: {},
    });

    expect(models.map(({ providerLabel, ref }) => [providerLabel, ref])).toEqual([
      ["Provider A", { providerId: "provider-a", modelId: "model-a" }],
      ["Provider A", { providerId: "provider-a", modelId: "model-b" }],
    ]);
  });

  it("主动选择复用 Registry 的 Model Option 校验", () => {
    const registry = new ProviderRegistry([
      {
        providerId: "provider-a",
        config: createApiKeyProviderConfig({ models: ["model-a"] }),
        models: [
          {
            modelId: "model-a",
            config: new ModelConfig({
              properties: completeModelProperties(),
              optionSpecs: new ModelOptionSpecsConfig({
                reasoningLevel: {
                  values: ["low", "high"],
                  map: '{"reasoning_effort":reasoningLevel}',
                },
                maxOutputTokens: {
                  max: 32_000,
                  map: '{"max_completion_tokens":maxOutputTokens}',
                },
              }),
            }),
          },
        ],
      },
    ]);

    expect(() =>
      resolveRegistryOwnedModelSelection(registry, {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "max" },
      }),
    ).toThrow('Reasoning effort "max" is not supported by provider-a/model-a');
  });
});

function completeModelConfig(): ModelConfig {
  return new ModelConfig({
    properties: completeModelProperties(),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: 32_000,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    }),
  });
}

function completeModelProperties(): ModelPropertiesConfig {
  return new ModelPropertiesConfig({
    requiresMfjsToolSchema: false,
    contextWindow: 128_000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  });
}
