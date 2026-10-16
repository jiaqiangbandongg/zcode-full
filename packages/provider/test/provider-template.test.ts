import { describe, expect, it } from "vitest";
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
  ProviderTemplate,
  ProviderTemplateMap,
  parseProviderTemplateMap,
  parseZCodeBuiltinModelConfigRules,
  resolveProviderTemplateName,
} from "../src/index.js";

describe("Provider Template", () => {
  it("只接受可复用基线字段，拒绝凭据、身份和运行状态", () => {
    expect(
      parseProviderTemplateMap([
        {
          templateId: "deepseek",
          templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
          config: {
            logo: { type: "builtin", key: "deepseek" },
            access: { type: "api-key", apiKeyManagementUrl: "https://example.com/keys" },
            api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
            builtinModelIds: ["model-a"],
          },
        },
      ])
        .get("deepseek")
        ?.toJSON(),
    ).toEqual({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: {
        logo: { type: "builtin", key: "deepseek" },
        access: { type: "api-key", apiKeyManagementUrl: "https://example.com/keys" },
        api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
        builtinModelIds: ["model-a"],
      },
    });

    for (const forbidden of [
      { templateNameMap: { "en-US": "DeepSeek" }, group: "standard-personal" },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { templateId: "nested" } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { enabled: true } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { visibility: "hidden" } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { personalModelIds: ["personal"] } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { modelOrder: ["model-a"] } },
      {
        templateNameMap: { "en-US": "DeepSeek" },
        config: { access: { type: "api-key", apiKey: "secret" } },
      },
    ]) {
      expect(() => parseProviderTemplateMap([{ templateId: "deepseek", ...forbidden }])).toThrow();
    }
  });

  it("按当前语言、英文和 Template ID 依次解析名称", () => {
    const localized = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: new ProviderConfig(),
    });
    const englishOnly = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "en-US": "DeepSeek" },
      config: new ProviderConfig(),
    });
    const unnamed = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: {},
      config: new ProviderConfig(),
    });

    expect(resolveProviderTemplateName("deepseek", localized, "zh-CN")).toBe("深度求索");
    expect(resolveProviderTemplateName("deepseek", englishOnly, "zh-CN")).toBe("DeepSeek");
    expect(resolveProviderTemplateName("deepseek", unnamed, "zh-CN")).toBe("deepseek");
  });

  it("同一 Template 可实例化为多个独立 Provider，Template 不进入 Registry", () => {
    const template = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "en-US": "DeepSeek" },
      config: new ProviderConfig({
        access: new ApiKeyAccessConfig(),
        api: new ProviderApiConfig({
          type: "anthropic-messages",
          baseUrl: "https://api.example.com",
        }),
        builtinModelIds: ["model-a"],
      }),
    });
    const personalProviders = new ProviderConfigMap([
      {
        providerId: "deepseek",
        templateId: "deepseek",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "first" }),
        }),
      },
      {
        providerId: "deepseek-2",
        templateId: "deepseek",
        providerName: "DeepSeek 2",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "second" }),
        }),
      },
    ]);
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: completeModelConfig(),
      },
    ]);
    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      zcodeBuiltinProviderTemplates: new ProviderTemplateMap([["deepseek", template]]),
      accountProviders: ProviderConfigMap.empty(),
      personalProviders,
      zcodeBuiltinModelRules: rules,
      personalModels: ModelConfigRules.empty(),
    });

    expect(resolution.registryProviders.map(({ providerId }) => providerId)).toEqual([
      "deepseek",
      "deepseek-2",
    ]);
    expect(resolution.resolvedProviders.map(({ providerId }) => providerId)).not.toContain(
      "template:deepseek",
    );
    expect(resolution.registryProviders[0]?.config.api?.baseUrl).toBe("https://api.example.com");
  });

  it("Built-in Rule 固定按 match、template-model、provider-model 排序", () => {
    const rules = parseZCodeBuiltinModelConfigRules({
      modelRules: [{ modelMatch: ".*", config: { enabled: false } }],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [
        { templateId: "deepseek", modelId: "model-a", config: { enabled: true } },
      ],
      builtinProviderModelRules: [
        { providerId: "deepseek-special", modelId: "model-a", config: { enabled: false } },
      ],
    });

    expect(
      rules.resolve({
        providerId: "deepseek",
        templateId: "deepseek",
        modelId: "model-a",
      }).enabled,
    ).toBe(true);
    expect(
      rules.resolve({
        providerId: "deepseek-special",
        templateId: "deepseek",
        modelId: "model-a",
      }).enabled,
    ).toBe(false);
  });

  it("Built-in 分组按 model、model+api、site、template、provider 顺序叠加", () => {
    const rules = parseZCodeBuiltinModelConfigRules({
      modelRules: [
        { modelMatch: ".*", config: { enabled: false } },
        { modelMatch: ".*GLM-5\\.3.*", config: { enabled: true } },
      ],
      modelApiRules: [
        {
          modelMatch: ".*GLM-5\\.3.*",
          apiTypeMatch: "anthropic-messages",
          config: { properties: { requiresMfjsToolSchema: true } },
        },
      ],
      providerSiteRules: [
        {
          modelMatch: ".*GLM-5\\.3.*",
          apiTypeMatch: "anthropic-messages",
          baseUrlMatch: "https://api.example.com/anthropic/?",
          config: { enabled: false },
        },
      ],
      templateModelRules: [{ templateId: "glm", modelId: "GLM-5.3", config: { enabled: true } }],
      builtinProviderModelRules: [
        { providerId: "provider-a", modelId: "GLM-5.3", config: { enabled: false } },
      ],
    });

    const resolved = rules.resolve({
      providerId: "provider-a",
      templateId: "glm",
      modelId: "GLM-5.3",
      apiType: "anthropic-messages",
      baseUrl: "https://api.example.com/anthropic",
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.properties?.requiresMfjsToolSchema).toBe(true);
  });
});

function completeModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,

    properties: new ModelPropertiesConfig({
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
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
  });
}
