import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { describe, expect, it } from "vitest";
import type {
  ModelProviderConfig,
  ModelProviderModelConfig,
} from "../src/model-provider/legacyModelProviderSerialized.js";
import { importLegacyPersonalProviderConfig } from "../src/model-provider/legacyPersonalProviderConfigImporter.js";

function completeModelConfig(contextWindow = 200_000): ModelConfig {
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      maxOutputTokens: { max: 32_000 },
    }),
  });
}

function zcodeBuiltinSnapshot(): ProviderConfigLayerSnapshot {
  return {
    revision: "zcodeBuiltin-1",
    providers: new ProviderConfigMap([
      [
        "deepseek",
        new ProviderConfig({
          label: "DeepSeek",
          enabled: false,
          access: new ApiKeyAccessConfig(),
          api: new ProviderApiConfig({
            type: "anthropic-messages",
            baseUrl: "https://api.deepseek.com/anthropic",
          }),
          builtinModelIds: ["deepseek-v4"],
        }),
      ],
      [
        "zai-api",
        new ProviderConfig({
          label: "Z.ai",
          enabled: false,
          access: new ApiKeyAccessConfig(),
          api: new ProviderApiConfig({
            type: "anthropic-messages",
            baseUrl: "https://api.z.ai/api/anthropic",
          }),
          builtinModelIds: ["glm-5.3", "glm-5.2", "glm-5-turbo"],
        }),
      ],
    ]),
    models: new ModelConfigRules([
      {
        providerMatch: "deepseek",
        type: "match",
        modelMatch: "deepseek-v4",
        config: completeModelConfig(),
      },
      {
        providerMatch: "zai-api",
        type: "match",
        modelMatch: "glm-.*",
        config: completeModelConfig(1_000_000),
      },
    ]),
  };
}

function legacyModel(
  id: string,
  overrides: Partial<ModelProviderModelConfig> = {},
): ModelProviderModelConfig {
  return {
    id,
    kinds: ["anthropic"],
    contextWindow: 200_000,
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  };
}

function legacyProvider(
  id: string,
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return {
    id,
    name: id,
    endpoints: { baseURL: "https://api.example.com" },
    apiFormat: "anthropic-messages",
    source: "custom",
    apiKey: "test-key",
    models: [legacyModel("model-a")],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("Legacy Personal Provider Config Importer", () => {
  it("Todo104：已发布导入直接输出最终规则，旧输入与模型身份不改写", () => {
    const legacyProviders = [
      legacyProvider("custom-id", { name: "My API" }),
      legacyProvider("builtin:bigmodel"),
    ];
    const before = structuredClone(legacyProviders);
    const imported = importLegacyPersonalProviderConfig({ legacyProviders });
    expect(imported.providers.getRule("custom-id")?.providerName).toBe("My API");
    expect(imported.providers.getRule("bigmodel-api")?.templateId).toBe("bigmodel-api");
    expect(imported.providers.get("custom-id")?.toJSON()).not.toHaveProperty("label");
    expect(imported.providers.get("bigmodel-api")?.toJSON()).not.toHaveProperty("templateId");
    expect(imported.models.toPersonalJSON().manualProviderModelRules).toEqual([]);
    expect(imported.models.toPersonalJSON().providerModelRules[0]).toMatchObject({
      providerId: "custom-id",
      modelId: "model-a",
    });
    expect(legacyProviders).toEqual(before);
  });
  it.each(["custom", "builtin", undefined] as const)(
    "保留内置身份优先于 source=%s，API 只迁 Key",
    (source) => {
      const document = importLegacyPersonalProviderConfig({
        legacyProviders: [
          ...[
            "builtin:bigmodel-coding-plan",
            "builtin:zai-coding-plan",
            "builtin:bigmodel-start-plan",
            "builtin:zai-start-plan",
            "builtin:zapi",
            "account:bigmodel-team-coding-plan",
          ].map((id) => legacyProvider(id, { source })),
          legacyProvider("builtin:bigmodel", { source, name: "obsolete label", enabled: false }),
          legacyProvider("builtin:zai", { source, apiKey: " zai-key " }),
        ],
      });
      expect(document.providers.keys()).toEqual(["bigmodel-api", "zai-api"]);
      expect(document.providers.getRule("bigmodel-api")?.templateId).toBe("bigmodel-api");
      expect(document.providers.getRule("bigmodel-api")?.enabled).toBeUndefined();
      expect(document.providers.get("bigmodel-api")?.toJSON()).toEqual({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "test-key" },
      });
      expect(document.providers.get("zai-api")?.access).toMatchObject({ apiKey: "zai-key" });
      expect(document.models.getExact("bigmodel-api", "model-a")).toBeUndefined();
    },
  );

  it("空内置 API Key 不覆盖已导入的非空 Key，也不创建空副本", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("builtin:bigmodel", { apiKey: "kept-key" }),
        legacyProvider("builtin:bigmodel", { apiKey: " " }),
        legacyProvider("builtin:zai", { apiKey: "" }),
      ],
    });
    expect(document.providers.keys()).toEqual(["bigmodel-api"]);
    expect(document.providers.get("bigmodel-api")?.access).toMatchObject({ apiKey: "kept-key" });
  });

  it("不凭名称或 URL 丢弃 UUID 自定义供应商", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider(id, {
          name: "BigModel - Coding Plan",
          endpoints: { baseURL: "https://open.bigmodel.cn/api/anthropic" },
        }),
      ],
    });
    expect(document.providers.getRule(id)?.providerName).toBe("BigModel - Coding Plan");
    expect(document.models.getExact(id, "model-a")?.properties?.contextWindow).toBe(200_000);
  });

  it("Builtin Provider 即使包含用户 Key 和 modified 模型也完全不迁移", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("deepseek", {
          source: "builtin",
          name: "DeepSeek",
          endpoints: { baseURL: "https://api.deepseek.com/anthropic" },
          models: [
            legacyModel("deepseek-v4", {
              contextWindow: 128_000,
              maxOutputTokens: 32_000,
              modified: true,
            }),
          ],
        }),
      ],
    });

    expect(document.providers.has("deepseek")).toBe(false);
    expect(document.models.getExact("deepseek", "deepseek-v4")).toBeUndefined();
  });

  it("自定义 Provider 迁移调用配置、成员顺序，并只保留模型 contextWindow", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("proxy", {
          name: "Team Proxy",
          endpoints: { baseURL: "https://proxy.example.com/anthropic" },
          headers: { "X-Team": "coding" },
          logoUrl: "https://proxy.example.com/logo.svg",
          apiKeyUrl: "https://proxy.example.com/keys",
          models: [
            legacyModel("custom-model", {
              contextWindow: 100_000,
              maxOutputTokens: 16_000,
              modalities: { input: ["text", "image"], output: ["text"] },
              supportsTools: true,
              supportsStructuredOutput: true,
              reasoning: {
                defaultLevel: "high",
                levels: {
                  low: {
                    anthropic: {
                      set: [{ path: ["effort"], value: "low" }],
                    },
                  },
                  high: {
                    anthropic: {
                      set: [
                        { path: ["effort"], value: "high" },
                        {
                          path: ["thinking", "budgetTokens"],
                          value: 12_000,
                        },
                      ],
                    },
                  },
                },
              },
              modified: true,
            }),
          ],
        }),
      ],
    });

    expect(document.providers.getRule("proxy")?.providerName).toBe("Team Proxy");
    expect(document.providers.get("proxy")?.toJSON()).toEqual({
      group: "standard-personal",
      access: {
        type: "api-key",
        apiKey: "test-key",
        apiKeyManagementUrl: "https://proxy.example.com/keys",
      },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://proxy.example.com/anthropic",
        headers: { "X-Team": "coding" },
      },
      personalModelIds: ["custom-model"],
      modelOrder: ["custom-model"],
    });
    expect(document.models.getExact("proxy", "custom-model")?.toJSON()).toEqual({
      properties: { contextWindow: 100_000 },
    });
  });

  it("按旧列表顺序迁移字符串和对象成员，并丢弃空白、重复和删除项", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("proxy", {
          source: undefined,
          models: [
            " model-a ",
            legacyModel("model-b", { modified: false }),
            legacyModel("model-a", { contextWindow: 64_000, modified: true }),
            legacyModel("deleted", { deleted: true, modified: true }),
            "   ",
          ],
        }),
      ],
    });

    expect(document.providers.get("proxy")?.personalModelIds).toEqual(["model-a", "model-b"]);
    expect(document.providers.get("proxy")?.modelOrder).toEqual(["model-a", "model-b"]);
    expect(document.models.getExact("proxy", "model-b")?.toJSON()).toEqual({
      properties: { contextWindow: 200_000 },
    });
    expect(document.models.getExact("proxy", "deleted")).toBeUndefined();
  });

  it("不为非法 contextWindow 生成 Model Rule，也不迁移已废弃 source", () => {
    const invalidContextModel = legacyModel("invalid-context", {
      contextWindow: 0,
      maxOutputTokens: 16_000,
      modalities: { input: ["text", "video"], output: ["text"] },
      supportsTools: true,
      modified: true,
    });
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("custom", { models: [invalidContextModel] }),
        legacyProvider("catalog", { source: "models-dev" }),
        legacyProvider("workspace", { source: "workspace" }),
      ],
    });

    expect(document.providers.has("custom")).toBe(true);
    expect(document.models.getExact("custom", "invalid-context")).toBeUndefined();
    expect(document.providers.has("catalog")).toBe(false);
    expect(document.providers.has("workspace")).toBe(false);
  });

  it("迁移后的 context Overlay 与当前通用 Model Rule 合成完整可执行模型", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("proxy", {
          models: [legacyModel("custom-model", { contextWindow: 64_000 })],
        }),
      ],
    });
    const genericRules = new ModelConfigRules([
      {
        type: "match",
        providerMatch: ".*",
        modelMatch: ".*",
        config: completeModelConfig(),
      },
    ]);

    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders: document.providers,
      zcodeBuiltinModelRules: genericRules,
      personalModels: document.models,
      accountProviders: ProviderConfigMap.empty(),
    });

    const model = resolution.resolvedProviders[0]?.models[0];
    expect(model?.modelId).toBe("custom-model");
    expect(model?.config.properties?.contextWindow).toBe(64_000);
    expect(model?.config.properties?.inputFormat?.supportsText).toBe(true);
    expect(model?.config.optionSpecs?.maxOutputTokens).toEqual({
      max: 32_000,
    });
  });

  it("没有 ZCodeBuiltin Account 定义的旧系统 Provider 不会误迁为 API Provider", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("account:zai-start-plan", {
          source: "builtin",
          apiKey: "runtime-jwt-must-not-persist",
        }),
      ],
    });

    expect(document.providers.has("account:zai-start-plan")).toBe(false);
  });

  it("旧 Builtin Preset 的系统静态值和新增模型都不会进入 Personal", () => {
    const document = importLegacyPersonalProviderConfig({
      legacyProviders: [
        legacyProvider("zai-api", {
          source: "builtin",
          name: "Z.ai - API Key",
          endpoints: { baseURL: "https://legacy.z.ai/api/anthropic" },
          models: [
            legacyModel("GLM-5.2"),
            legacyModel("GLM-5-Turbo"),
            legacyModel("user-model", {
              contextWindow: 128_000,
              modified: true,
            }),
          ],
        }),
      ],
    });

    expect(document.providers.has("zai-api")).toBe(false);
    expect(document.models.getExact("zai-api", "GLM-5.2")).toBeUndefined();
    expect(document.models.getExact("zai-api", "GLM-5-Turbo")).toBeUndefined();
    expect(document.models.getExact("zai-api", "user-model")).toBeUndefined();

    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: zcodeBuiltinSnapshot().providers,
      personalProviders: document.providers,
      zcodeBuiltinModelRules: zcodeBuiltinSnapshot().models,
      personalModels: document.models,
      accountProviders: ProviderConfigMap.empty(),
    });
    expect(
      resolution.resolvedProviders
        .find((provider) => provider.providerId === "zai-api")
        ?.models.map((model) => model.modelId),
    ).toEqual(["glm-5.3", "glm-5.2", "glm-5-turbo"]);
  });
});
