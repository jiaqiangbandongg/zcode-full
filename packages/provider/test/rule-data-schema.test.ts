import { describe, expect, it } from "vitest";
import { completeModelConfigDataSchema } from "@zcode/shared/model-config";
import { extractManualModelConfig } from "../src/index.js";
import {
  builtinModelConfigRulesSchema,
  builtinProviderConfigRulesSchema,
  manualModelConfigSchema,
  modelApiMatchConfigRuleSchema,
  modelMatchConfigRuleSchema,
  personalModelConfigRulesSchema,
  personalProviderConfigRulesSchema,
  providerSiteMatchConfigRuleSchema,
} from "../src/config/rule-data-schema.js";

const completeModel = {
  enabled: false,
  properties: {
    contextWindow: 100_000,
    requiresMfjsToolSchema: false,
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
    reasoningLevel: { values: ["disabled", "high"], map: '{"effort": reasoningLevel}' },
    maxOutputTokens: { max: 32_768, map: '{"max_tokens": maxOutputTokens}' },
  },
};
const modelRule = { modelMatch: ".*", config: {} };
const exactRule = { providerId: "custom:test", modelId: "test", config: {} };
const emptyModelRules = {
  modelRules: [],
  modelApiRules: [],
  providerSiteRules: [],
  templateModelRules: [],
  builtinProviderModelRules: [],
};

describe("Todo104 最终规则数据合同", () => {
  it("三种 Match 层只接受本层条件，保留正则而非 API 枚举", () => {
    expect(modelMatchConfigRuleSchema.parse(modelRule)).toEqual(modelRule);
    expect(
      modelApiMatchConfigRuleSchema.parse({ ...modelRule, apiTypeMatch: "openai-.*" }),
    ).toMatchObject({ apiTypeMatch: "openai-.*" });
    expect(
      providerSiteMatchConfigRuleSchema.parse({
        ...modelRule,
        baseUrlMatch: "https://api\\.example\\.com/v1",
        apiTypeMatch: "anthropic-.*",
      }),
    ).toMatchObject({ modelMatch: ".*" });
    expect(modelApiMatchConfigRuleSchema.safeParse(modelRule).success).toBe(false);
    expect(providerSiteMatchConfigRuleSchema.safeParse(modelRule).success).toBe(false);
    for (const key of [
      "apiTypeMatch",
      "baseUrlMatch",
      "providerMatch",
      "apiMatch",
      "baseURLMatch",
      "type",
    ]) {
      expect(modelMatchConfigRuleSchema.safeParse({ ...modelRule, [key]: ".*" }).success).toBe(
        false,
      );
    }
    expect(
      modelApiMatchConfigRuleSchema.safeParse({
        ...modelRule,
        apiTypeMatch: ".*",
        baseUrlMatch: ".*",
      }).success,
    ).toBe(false);
    for (const schema of [
      modelMatchConfigRuleSchema,
      modelApiMatchConfigRuleSchema,
      providerSiteMatchConfigRuleSchema,
    ]) {
      const valid =
        schema === modelMatchConfigRuleSchema
          ? modelRule
          : schema === modelApiMatchConfigRuleSchema
            ? { ...modelRule, apiTypeMatch: ".*" }
            : { ...modelRule, baseUrlMatch: ".*" };
      expect(schema.safeParse({ ...valid, providerMatch: ".*" }).success).toBe(false);
      expect(schema.safeParse({ ...valid, type: "match" }).success).toBe(false);
      expect(schema.safeParse({ ...valid, modelMatch: "[" }).success).toBe(false);
    }
    expect(
      modelApiMatchConfigRuleSchema.safeParse({ ...modelRule, apiTypeMatch: "[" }).success,
    ).toBe(false);
    expect(
      providerSiteMatchConfigRuleSchema.safeParse({ ...modelRule, baseUrlMatch: "[" }).success,
    ).toBe(false);
  });

  it("Manual 从共享叶子派生，可编辑字段完整、系统字段不写入", () => {
    expect(completeModelConfigDataSchema.parse(completeModel)).toEqual(completeModel);
    const manual = extractManualModelConfig(completeModel);
    expect(manualModelConfigSchema.shape.properties.shape.contextWindow).toBe(
      completeModelConfigDataSchema.shape.properties.shape.contextWindow,
    );
    for (const enabled of [undefined, null, false, true]) {
      expect(manualModelConfigSchema.safeParse({ ...manual, enabled }).success).toBe(true);
    }
    const paths = leafPaths(manual).filter((path) => path[0] !== "enabled");
    for (const path of paths) {
      for (const missing of [undefined, null]) {
        const candidate = structuredClone(manual) as Record<string, unknown>;
        let owner = candidate;
        for (const key of path.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
        owner[path.at(-1)!] = missing;
        expect(manualModelConfigSchema.safeParse(candidate).success, path.join(".")).toBe(false);
      }
    }
    expect(
      manualModelConfigSchema.safeParse({
        ...manual,
        properties: { ...manual.properties, contextWindow: 0 },
      }).success,
    ).toBe(false);
    expect(
      manualModelConfigSchema.safeParse({
        ...manual,
        optionSpecs: {
          ...manual.optionSpecs,
          reasoningLevel: { values: ["high"], map: "{" },
        },
      }).success,
    ).toBe(false);
  });

  it("Personal 两组互斥，手动完整、智能稀疏，不能靠顺序吞掉冲突", () => {
    const manual = { ...exactRule, config: extractManualModelConfig(completeModel) };
    expect(
      personalModelConfigRulesSchema.parse({
        providerModelRules: [exactRule],
        manualProviderModelRules: [],
      }),
    ).toEqual({ providerModelRules: [exactRule], manualProviderModelRules: [] });
    expect(
      personalModelConfigRulesSchema.safeParse({
        providerModelRules: [],
        manualProviderModelRules: [manual],
      }).success,
    ).toBe(true);
    expect(
      personalModelConfigRulesSchema.safeParse({
        providerModelRules: [exactRule],
        manualProviderModelRules: [manual],
      }).success,
    ).toBe(false);
    expect(
      personalModelConfigRulesSchema.safeParse({
        providerModelRules: [],
        manualProviderModelRules: [exactRule],
      }).success,
    ).toBe(false);
    for (const key of ["type", "useRecommendedConfig", "useSmartConfig"]) {
      expect(
        personalModelConfigRulesSchema.safeParse({
          providerModelRules: [{ ...exactRule, [key]: false }],
          manualProviderModelRules: [],
        }).success,
      ).toBe(false);
    }
    expect(personalModelConfigRulesSchema.safeParse({ providerModelRules: [] }).success).toBe(
      false,
    );
  });

  it("Builtin 五组均必需，精确规则与匹配规则不混用，旧集合不兼容", () => {
    expect(builtinModelConfigRulesSchema.parse(emptyModelRules)).toEqual(emptyModelRules);
    for (const key of Object.keys(emptyModelRules)) {
      expect(
        builtinModelConfigRulesSchema.safeParse({ ...emptyModelRules, [key]: undefined }).success,
      ).toBe(false);
    }
    expect(
      builtinModelConfigRulesSchema.safeParse({ ...emptyModelRules, modelRules: [exactRule] })
        .success,
    ).toBe(false);
    expect(
      builtinModelConfigRulesSchema.safeParse({ ...emptyModelRules, providerModelRules: [] })
        .success,
    ).toBe(false);
    expect(
      builtinModelConfigRulesSchema.safeParse({ ...emptyModelRules, matchRules: [] }).success,
    ).toBe(false);
  });

  it("Provider 规则身份/名称在外层，来源权限保持", () => {
    const template = {
      templateId: "openai",
      templateNameMap: { "en-US": "OpenAI" },
      config: {
        access: { type: "api-key" },
        api: { type: "openai-responses", baseUrl: "https://api.example.com/v1" },
      },
    };
    const builtin = {
      providerId: "account:zai",
      providerName: "Z.ai",
      config: { group: "zai-family" },
    };
    expect(
      builtinProviderConfigRulesSchema.parse({
        templateRules: [template],
        providerRules: [builtin],
      }),
    ).toMatchObject({ templateRules: [template], providerRules: [builtin] });
    expect(
      builtinProviderConfigRulesSchema.safeParse({
        templateRules: [
          {
            ...template,
            config: {
              ...template.config,
              access: { type: "api-key", apiKey: "not-allowed" },
            },
          },
        ],
        providerRules: [],
      }).success,
    ).toBe(false);
    for (const key of ["templateId", "label", "personalModelIds", "modelOrder"]) {
      expect(
        builtinProviderConfigRulesSchema.safeParse({
          templateRules: [],
          providerRules: [{ ...builtin, config: { ...builtin.config, [key]: [] } }],
        }).success,
      ).toBe(false);
    }
    const personal = {
      providerId: "custom:one",
      templateId: "openai",
      providerName: "OpenAI",
      config: {
        group: "standard-personal",
        api: { baseUrl: "unfinished endpoint" },
        personalModelIds: ["model"],
      },
    };
    expect(personalProviderConfigRulesSchema.parse({ providerRules: [personal] })).toEqual({
      providerRules: [personal],
    });
    expect(
      personalProviderConfigRulesSchema.safeParse({
        providerRules: [{ ...personal, config: { label: "old" } }],
      }).success,
    ).toBe(false);
    expect(
      personalProviderConfigRulesSchema.safeParse({
        providerRules: [{ ...personal, config: { builtinModelIds: ["x"] } }],
      }).success,
    ).toBe(false);
    expect(
      personalProviderConfigRulesSchema.safeParse({
        providerRules: [
          {
            providerId: "account:zai",
            config: { access: { type: "api-key", apiKey: "not-allowed" } },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      personalProviderConfigRulesSchema.safeParse({ templateRules: [], providerRules: [] }).success,
    ).toBe(false);
  });

  it("同来源重复 Provider/Template 在建索引前拒绝；Match 同时命中仍合法", () => {
    const provider = { providerId: "test", config: { group: "zai-family" } };
    const template = { templateId: "test", templateNameMap: {}, config: {} };
    expect(
      builtinProviderConfigRulesSchema.safeParse({
        templateRules: [],
        providerRules: [provider, provider],
      }).success,
    ).toBe(false);
    expect(
      builtinProviderConfigRulesSchema.safeParse({
        templateRules: [template, template],
        providerRules: [],
      }).success,
    ).toBe(false);
    expect(
      personalProviderConfigRulesSchema.safeParse({
        providerRules: [exactProvider(), exactProvider()],
      }).success,
    ).toBe(false);
    expect(
      builtinModelConfigRulesSchema.parse({
        ...emptyModelRules,
        modelRules: [modelRule, modelRule],
      }).modelRules,
    ).toHaveLength(2);
    expect(
      personalProviderConfigRulesSchema.parse({ providerRules: [exactProvider()] }).providerRules,
    ).toHaveLength(1);
  });
});

function exactProvider() {
  return { providerId: "test", config: {} };
}
function leafPaths(value: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? leafPaths(child as Record<string, unknown>, [...prefix, key])
      : [[...prefix, key]],
  );
}
