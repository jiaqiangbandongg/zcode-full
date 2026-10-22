import { describe, expect, it } from "vitest";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import {
  importLegacyCliConfiguredDefault,
  importLegacyCliPersonalProviderConfig,
} from "../src/app/legacy-cli-personal-provider-config-importer.js";

function encoded(update: { providers: ProviderConfigMap; models: ModelConfigRules }): any {
  return {
    schemaVersion: 1,
    providers: update.providers.toJSON(),
    models: update.models.toJSON(),
  };
}

// 新存储格式按规则种类分桶，Provider 名称与配置分离；不再断言已退场的扁平 DTO。
const emptyModelRules = {
  builtinProviderModelRules: [],
  manualProviderModelRules: [],
  modelApiRules: [],
  modelRules: [],
  providerSiteRules: [],
  templateModelRules: [],
};

describe("importLegacyCliPersonalProviderConfig", () => {
  it("Standalone 与 Desktop 一样丢弃内置套餐配置，API 只迁 Key", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          "builtin:bigmodel-coding-plan": {
            kind: "anthropic",
            source: "custom",
            options: { apiKey: "discard", apiKeyRequired: false },
            models: { old: {} },
          },
          "builtin:bigmodel": {
            kind: "anthropic",
            source: "custom",
            name: "old",
            options: { apiKey: " kept ", baseURL: "https://old.test" },
            models: { old: {} },
          },
          "builtin:zai": { kind: "anthropic", source: "builtin", options: { apiKey: "" } },
          "account:zai-start-plan": {
            kind: "anthropic",
            source: "custom",
            options: { apiKey: "discard" },
          },
          "legacy-builtin": {
            kind: "anthropic",
            source: "builtin",
            options: { apiKey: "discard" },
          },
        },
      },
    });
    expect(update.providers.keys()).toEqual(["bigmodel-api"]);
    expect(update.providers.get("bigmodel-api")?.toJSON()).toEqual({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "kept" },
    });
  });

  it("只把旧用户文件显式声明的 Provider 投影为 Personal Config", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        model: "custom/model-a",
        provider: {
          custom: {
            kind: "openai-compatible",
            name: "Custom API",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
              includeUsage: false,
            },
            models: {
              "model-a": {
                headers: { "X-Model-Route": "legacy" },
                limit: { context: 128_000, output: 16_000 },
                modalities: { input: ["text", "image", "video"] },
                reasoning: {
                  enabled: true,
                  levels: ["low", "high"],
                  defaultLevel: "high",
                  providerOptionsByLevel: {
                    low: { openaiCompatible: { reasoningEffort: "low" } },
                    high: { openaiCompatible: { reasoningEffort: "high" } },
                  },
                },
                structured_output: true,
                tool_call: true,
              },
            },
          },
        },
      },
    });

    expect(encoded(update)).toEqual({
      schemaVersion: 1,
      providers: [
        {
          providerId: "custom",
          providerName: "Custom API",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://custom.example.com/v1",
            },
            personalModelIds: ["model-a"],
            modelOrder: ["model-a"],
          },
        },
      ],
      models: {
        ...emptyModelRules,
        builtinProviderModelRules: [
          {
            providerId: "custom",
            modelId: "model-a",
            config: {
              properties: {
                contextWindow: 128_000,
              },
              optionSpecs: { maxOutputTokens: { max: 16_000 } },
            },
          },
        ],
      },
    });
  });

  it("不把只有 model 选择、没有 provider 定义的内容迁成 Provider", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: { model: "missing/model-a" },
    });

    expect(encoded(update)).toEqual({
      schemaVersion: 1,
      providers: [],
      models: emptyModelRules,
    });
  });

  it("不把旧 CLI 中已退出产品的 ZAPI 迁成 Personal Provider", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          "builtin:zapi": {
            kind: "anthropic",
            options: { baseURL: "https://retired.example.com", apiKey: "retired" },
            models: { retired: {} },
          },
          custom: {
            kind: "openai-compatible",
            options: { baseURL: "https://custom.example.com", apiKey: "current" },
            models: { current: {} },
          },
        },
      },
    });

    expect(update.providers.keys()).toEqual(["custom"]);
  });

  it("忽略旧 model options 中没有正式语义的任意字段", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
            },
            models: {
              "model-a": {
                limit: { context: 128_000, output: 16_000 },
                options: {
                  openaiCompatible: {
                    reasoningSummary: "auto",
                    metadata: { source: "legacy" },
                  },
                },
              },
              "model-b": {
                options: { reasoningSummary: "concise" },
              },
            },
          },
        },
      },
    });

    expect(encoded(update).models.builtinProviderModelRules[0]?.config).not.toHaveProperty(
      "requestParameters",
    );
    expect(encoded(update).models.builtinProviderModelRules).toHaveLength(1);
  });

  it("迁移 options.max_tokens，但不扩展任意 extra_body 字段", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
            },
            models: {
              direct: {
                options: { max_tokens: 24_000 },
              },
              wrapped: {
                options: {
                  extra_body: { max_tokens: 12_000, reasoning_format: "parsed" },
                },
              },
            },
          },
        },
      },
    });

    expect(update.models.getExact("custom", "direct")?.toJSON()).toEqual({
      optionSpecs: { maxOutputTokens: { max: 24_000 } },
    });
    expect(update.models.getExact("custom", "wrapped")).toBeUndefined();
  });

  it("忽略没有生产消费方的 reasoning replay 元数据", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
            },
            models: {
              "model-a": {
                interleaved: { field: "reasoning_content" },
                reasoningContentField: "reasoning_content",
              },
            },
          },
        },
      },
    });

    expect(update.providers.get("custom")).toBeDefined();
    expect(encoded(update).models).toEqual(emptyModelRules);
  });

  it("无 API Key Provider 在正式类型建立前继续留在兼容链路", () => {
    expect(() =>
      importLegacyCliPersonalProviderConfig({
        input: {
          provider: {
            local: {
              kind: "openai-compatible",
              options: {
                apiKeyRequired: false,
                baseURL: "http://127.0.0.1:11434/v1",
              },
              models: { "model-a": {} },
            },
          },
        },
      }),
    ).toThrow(/local/);
  });
});

describe("importLegacyCliConfiguredDefault", () => {
  it("把旧用户文件的 main model 迁移为 Environment Configured Default", () => {
    expect({
      schemaVersion: 1,
      configuredDefault: importLegacyCliConfiguredDefault({
        model: {
          main: "custom/model-a",
          lite: "custom/model-b",
        },
      }),
    }).toEqual({
      schemaVersion: 1,
      configuredDefault: {
        providerId: "custom",
        modelId: "model-a",
      },
    });
  });

  it("没有显式 model 时不产生迁移文档", () => {
    expect(importLegacyCliConfiguredDefault({ provider: {} })).toBeNull();
  });

  it("不把已退出产品的 ZAPI 迁成 Environment Configured Default", () => {
    expect(importLegacyCliConfiguredDefault({ model: "builtin:zapi/retired" })).toBeNull();
  });
});
