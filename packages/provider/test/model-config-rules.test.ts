import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  parseZCodeBuiltinModelConfigRules,
  parseModelConfig,
  parsePersonalModelConfigRules,
  extractManualModelConfig,
} from "../src/index.js";

const emptyBuiltin = {
  modelRules: [],
  modelApiRules: [],
  providerSiteRules: [],
  templateModelRules: [],
  builtinProviderModelRules: [],
};
const complete = {
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128000,
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
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled"], map: "{}" },
    maxOutputTokens: { max: 8192, map: '{"max_tokens":maxOutputTokens}' },
  },
};

describe("ModelConfigRules", () => {
  it("Todo90：固定配置不从推荐补缺；enabled 仍独立继承", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({
          enabled: false,

          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: true,
            contextWindow: 100000,
          }),
        }),
      },
      {
        type: "manual-provider-model",
        providerId: "p",
        modelId: "m",
        config: new ModelConfig({
          properties: new ModelPropertiesConfig({ requiresMfjsToolSchema: false }),
        }),
      },
    ]);
    const fixed = rules.resolve({ providerId: "p", modelId: "m" });
    expect(fixed.properties?.contextWindow).toBeUndefined();
    expect(fixed.properties?.requiresMfjsToolSchema).toBe(false);
    expect(fixed.enabled).toBe(false);
    expect(fixed.validateComplete().length).toBeGreaterThan(0);
  });
  it("modelMatch 对完整 Model ID 做大小写不敏感匹配，但不隐式扩成 contains", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: "GLM-5",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(rules.resolve({ providerId: "custom", modelId: "glm-5" }).enabled).toBe(false);
    expect(rules.resolve({ providerId: "custom", modelId: "glm-5-turbo" }).enabled).toBeUndefined();
    expect(
      rules.resolve({ providerId: "custom", modelId: "vendor/glm-5" }).enabled,
    ).toBeUndefined();
  });

  it("baseUrlMatch 规范化 scheme、hostname、默认端口和尾部斜杠，但保留 path 大小写", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({ enabled: true }),
      },
      {
        type: "provider-site",
        modelMatch: "model-a",
        baseUrlMatch: "https://api\\.example\\.com/v1",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        baseUrl: "HTTPS://API.EXAMPLE.COM:443/v1/",
      }).enabled,
    ).toBe(false);
    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        baseUrl: "https://api.example.com/V1/",
      }).enabled,
    ).toBe(true);
  });

  it("按 Effective Provider baseURL 应用可选的 Endpoint 特化规则", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({ enabled: true }),
      },
      {
        type: "provider-site",
        modelMatch: "model-a",
        baseUrlMatch: "https://api\\.example\\.com/v1",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        apiType: "openai-responses",
        baseUrl: "https://api.example.com/v1",
      }).enabled,
    ).toBe(false);
    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        apiType: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      }).enabled,
    ).toBe(true);
  });

  it("严格解析并原样序列化 baseUrlMatch", () => {
    const source = {
      ...emptyBuiltin,
      providerSiteRules: [
        {
          modelMatch: "model-a",
          apiTypeMatch: "openai-responses",
          baseUrlMatch: "https://api\\\\.example\\\\.com/v1",
          config: { enabled: true },
        },
      ],
    };
    const rules = parseZCodeBuiltinModelConfigRules(source);
    expect(rules.toZCodeBuiltinJSON()).toEqual(source);
  });

  it("Personal 手动配置通过所属集合表达模式，往返不混回智能组", () => {
    const source = {
      providerModelRules: [],
      manualProviderModelRules: [
        {
          providerId: "provider-a",
          modelId: "model-a",
          config: extractManualModelConfig(complete),
        },
      ],
    };
    const rules = parsePersonalModelConfigRules(source);
    expect(rules.toPersonalJSON()).toEqual(source);
    expect(rules.getExactRule("provider-a", "model-a")?.type).toBe("manual-provider-model");
  });

  it("替换精确 Personal Rule 时保留显式推荐模式", () => {
    const rules = ModelConfigRules.empty().setExact(
      "provider-a",
      "model-a",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: true })),
      false,
    );

    const replaced = rules.setExact(
      "provider-a",
      "model-a",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: false })),
      false,
    );

    expect(replaced.getExactRule("provider-a", "model-a")).toEqual({
      type: "manual-provider-model",
      providerId: "provider-a",
      modelId: "model-a",
      config: parseModelConfig(extractManualModelConfig({ ...complete, enabled: false })),
    });
  });

  it("provider-model 使用结构化精确身份并按来源层合成", () => {
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: "model-a", config: { enabled: false } }],
    });
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [
        { providerId: "provider-a", modelId: "model-a", config: { enabled: true } },
      ],
      manualProviderModelRules: [],
    });
    const rules = ModelConfigRules.composeEffective(builtin, personal);
    expect(rules.resolve({ providerId: "provider-a", modelId: "model-a" }).enabled).toBe(true);
    expect(rules.resolve({ providerId: "provider-b", modelId: "model-a" }).enabled).toBe(false);
    expect(rules.resolve({ providerId: "provider-a", modelId: "MODEL-A" }).enabled).toBe(false);
    expect(rules.rules().map((rule) => rule.type)).toEqual(["model", "provider-model"]);
  });

  it("Effective 组合只允许 Built-in 与 Personal 精确覆盖", () => {
    const builtin = new ModelConfigRules([
      { type: "model", modelMatch: ".*", config: new ModelConfig({ enabled: true }) },
    ]);
    const personal = new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "provider-a",
        modelId: "model-a",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    const effective = ModelConfigRules.composeEffective(builtin, personal);

    expect(effective.resolve({ providerId: "provider-a", modelId: "model-a" }).enabled).toBe(false);
    expect(effective.rules().map((rule) => rule.type)).toEqual(["model", "provider-model"]);
    expect(personal.rules().map((rule) => rule.type)).toEqual(["provider-model"]);
  });

  it("专属生命周期操作只修改精确规则，不猜测外观精确的匹配规则", () => {
    const match = {
      type: "model" as const,
      modelMatch: "model-a",
      config: new ModelConfig({ enabled: false }),
    };
    const rules = new ModelConfigRules([match]).setExact(
      "provider-a",
      "model-a",
      new ModelConfig({ enabled: true }),
    );
    const renamed = rules.renameExactModel("provider-a", "model-a", "model-b");
    expect(renamed.rules()[0]).toEqual(match);
    expect(renamed.getExact("provider-a", "model-a")).toBeUndefined();
    expect(renamed.getExact("provider-a", "model-b")?.enabled).toBe(true);
    expect(renamed.deleteExact("provider-a", "model-b").rules()).toEqual([match]);
  });

  it("持久化不接受 type 或混合两种 Rule 字段", () => {
    expect(() =>
      parseZCodeBuiltinModelConfigRules({
        ...emptyBuiltin,
        modelRules: [{ type: "model", modelMatch: "model-a", config: { enabled: true } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalModelConfigRules({
        providerModelRules: [
          {
            providerId: "provider-a",
            modelId: "model-a",
            modelMatch: "model-a",
            config: { enabled: true },
          },
        ],
        manualProviderModelRules: [],
      }),
    ).toThrow();
  });
});
