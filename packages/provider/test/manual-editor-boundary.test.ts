import { describe, expect, it } from "vitest";
import {
  ModelConfigRules,
  parseModelConfig,
  parsePersonalModelConfigRules,
  parseZCodeBuiltinModelConfigRules,
} from "../src/index.js";
import { manualModelConfigSchema } from "../src/config/rule-data-schema.js";

export const manualConfig = {
  properties: {
    contextWindow: 100_000,
    inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["high"], map: '{"effort": reasoningLevel}' },
    maxOutputTokens: { max: 1024 },
  },
};

describe("Todo130 手动可编辑字段边界", () => {
  it("只要求可编辑叶子，拒绝隐藏字段；enabled 的三态不变", () => {
    for (const enabled of [undefined, null, true, false])
      expect(manualModelConfigSchema.safeParse({ ...manualConfig, enabled }).success).toBe(true);
    expect(
      manualModelConfigSchema.safeParse({
        ...manualConfig,
        properties: { ...manualConfig.properties, supportsToolCall: true },
      }).success,
    ).toBe(false);
    expect(
      manualModelConfigSchema.safeParse({
        ...manualConfig,
        optionSpecs: { ...manualConfig.optionSpecs, maxOutputTokens: { max: 1024, map: "{}" } },
      }).success,
    ).toBe(false);
    expect(
      manualModelConfigSchema.safeParse({
        ...manualConfig,
        properties: {
          ...manualConfig.properties,
          inputFormat: { supportsImage: false, supportsPdf: false },
        },
      }).success,
    ).toBe(false);
  });

  it("手动叶子固定，系统字段由当前 API 规则更新；未知接口仍不能执行", () => {
    const builtin = parseZCodeBuiltinModelConfigRules({
      modelRules: [
        {
          modelMatch: ".*",
          config: {
            enabled: true,
            properties: {
              ...manualConfig.properties,
              contextWindow: 999_000,
              supportsToolCall: true,
              requiresMfjsToolSchema: false,
              inputFormat: { supportsText: true, supportsAudio: false },
              outputFormat: { supportsText: true },
            },
          },
        },
      ],
      modelApiRules: ["a", "b"].map((name) => ({
        modelMatch: ".*",
        apiTypeMatch: name,
        config: { optionSpecs: { maxOutputTokens: { map: `{"${name}": maxOutputTokens}` } } },
      })),
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    });
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [],
      manualProviderModelRules: [{ providerId: "p", modelId: "m", config: manualConfig }],
    });
    const rules = ModelConfigRules.composeEffective(builtin, personal);
    for (const apiType of ["a", "b"]) {
      const result = rules.resolve({ providerId: "p", modelId: "m", apiType });
      expect(result.properties?.contextWindow).toBe(100_000);
      expect(result.optionSpecs?.maxOutputTokens?.map).toBe(`{"${apiType}": maxOutputTokens}`);
      expect(result.validateComplete()).toEqual([]);
    }
    expect(
      rules.resolve({ providerId: "p", modelId: "m", apiType: "unknown" }).validateComplete()
        .length,
    ).toBeGreaterThan(0);
    expect(() =>
      personal.setExact(
        "p",
        "m",
        parseModelConfig({
          ...manualConfig,
          properties: { ...manualConfig.properties, supportsToolCall: true },
        }),
        false,
      ),
    ).toThrow();
  });
});
