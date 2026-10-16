import { describe, expect, it } from "vitest";
import {
  normalizeModelSelection,
  completeNewModelSelection,
  resolveInitialModelSelection,
  type ProviderRegistryView,
} from "../src/index.js";
import { ModelConfig, ModelOptionSpecsConfig, ModelPropertiesConfig } from "../src/config/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

describe("resolveInitialModelSelection", () => {
  const registry = registryView();

  it("只接受带合法 reasoning 的持久化 configured default", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      },
      source: "configured-default",
    });
  });

  it("新草稿的 configured default 不可用时使用 Registry 推荐，不写回偏好", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: { providerId: "removed", modelId: "removed" },
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("全新选择没有 configured default 时按可见 Provider 顺序初始化最高档", () => {
    expect(
      resolveInitialModelSelection({
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("失效默认档位使整个默认偏好失效；新草稿重新取 Registry 推荐", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "removed" },
        },
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("reports an empty registry without inventing a model", () => {
    expect(
      resolveInitialModelSelection({
        registry: { revision: 0, providers: [] },
      }),
    ).toEqual({ source: "none" });
  });
});

describe("normalizeModelSelection", () => {
  it("主动选择目标模型取其最高档，不继承来源模型的档位", () => {
    expect(
      completeNewModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
  });
  it("新选择缺少 reasoning 时保留模型并清空 reasoning", () => {
    expect(
      normalizeModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("显式但失效的 reasoning 也清空，不偷偷替换档位", () => {
    expect(
      normalizeModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "removed" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });
});

function registryView(): ProviderRegistryView {
  return {
    revision: 1,
    providers: ["provider-a", "provider-b"].map((providerId) => ({
      providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        apiKey: "test-key",
        baseURL: "https://example.com",
        models: [`model-${providerId.at(-1)}`],
      }),
      models: [
        {
          modelId: `model-${providerId.at(-1)}`,
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 100_000,
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
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                values: ["low", "high"],
                map: "{'reasoning': {'effort': reasoningLevel}}",
              },
              maxOutputTokens: {
                max: 8_000,
                map: "{'max_tokens': maxOutputTokens}",
              },
            }),
          }),
        },
      ],
    })),
  };
}
