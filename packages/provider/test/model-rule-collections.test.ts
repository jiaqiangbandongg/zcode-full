import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  ModelConfigRules,
  parseModelConfig,
  parsePersonalModelConfigRules,
  parseZCodeBuiltinModelConfigRules,
  extractManualModelConfig,
} from "../src/index.js";

const complete = {
  enabled: false,
  properties: {
    contextWindow: 10_000,
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
    maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
  },
};
const emptyBuiltin = {
  modelRules: [],
  modelApiRules: [],
  providerSiteRules: [],
  templateModelRules: [],
  builtinProviderModelRules: [],
};
const input = {
  providerId: "p",
  templateId: "t",
  modelId: "model-x",
  apiType: "openai-responses",
  baseUrl: "https://API.EXAMPLE.COM:443/v1/",
};

describe("Todo104 规则集合读写与应用", () => {
  it("五层往返保留分组和组内顺序，按固定层次覆盖", () => {
    const source = {
      modelRules: [
        { modelMatch: ".*", config: complete },
        { modelMatch: "model-.*", config: { properties: { contextWindow: 20_000 } } },
      ],
      modelApiRules: [
        {
          modelMatch: "MODEL-X",
          apiTypeMatch: "openai-.*",
          config: { properties: { contextWindow: 30_000 } },
        },
      ],
      providerSiteRules: [
        {
          modelMatch: ".*",
          baseUrlMatch: "https://api\\.example\\.com/v1",
          config: { properties: { contextWindow: 40_000 } },
        },
      ],
      templateModelRules: [
        { templateId: "t", modelId: "model-x", config: { properties: { contextWindow: 50_000 } } },
      ],
      builtinProviderModelRules: [
        { providerId: "p", modelId: "model-x", config: { properties: { contextWindow: 60_000 } } },
      ],
    };
    const rules = parseZCodeBuiltinModelConfigRules(source);
    expect(rules.toZCodeBuiltinJSON()).toEqual(source);
    expect(rules.resolve(input).properties?.contextWindow).toBe(60_000);
    expect(rules.resolve({ ...input, providerId: "other" }).properties?.contextWindow).toBe(50_000);
    expect(
      rules.resolve({ ...input, providerId: "other", templateId: null }).properties?.contextWindow,
    ).toBe(40_000);
    expect(
      rules.resolve({
        ...input,
        providerId: "other",
        templateId: null,
        baseUrl: "https://evil.test/v1",
      }).properties?.contextWindow,
    ).toBe(30_000);
    expect(
      rules.resolve({
        ...input,
        providerId: "other",
        templateId: null,
        baseUrl: null,
        apiType: "anthropic-messages",
      }).properties?.contextWindow,
    ).toBe(20_000);
  });

  it("手动配置保留系统叶子，用户可编辑叶子固定", () => {
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: ".*", config: complete }],
    });
    const { enabled: _enabled, ...manualConfig } = extractManualModelConfig({
      ...complete,
      properties: { ...complete.properties, contextWindow: 20_000 },
    });
    const source = {
      providerModelRules: [],
      manualProviderModelRules: [{ providerId: "p", modelId: "model-x", config: manualConfig }],
    };
    const personal = parsePersonalModelConfigRules(source);
    expect(personal.toPersonalJSON()).toEqual(source);
    const effective = ModelConfigRules.composeEffective(builtin, personal).resolve(input);
    expect(effective.enabled).toBe(false);
    expect(effective.properties?.contextWindow).toBe(20_000);
    expect(effective.validateComplete()).toEqual([]);
    const cleared = personal.setExact(
      "p",
      "model-x",
      parseModelConfig({ ...manualConfig, enabled: null }),
    );
    expect(ModelConfigRules.composeEffective(builtin, cleared).resolve(input).enabled).toBeNull();
  });

  it("切换模式只移动条目到对应集合，普通启停更新不改变模式", () => {
    let rules = ModelConfigRules.empty().setExact(
      "p",
      "model-x",
      parseModelConfig(extractManualModelConfig(complete)),
      false,
    );
    expect(rules.toPersonalJSON().providerModelRules).toEqual([]);
    expect(rules.toPersonalJSON().manualProviderModelRules).toHaveLength(1);
    rules = rules.setExact(
      "p",
      "model-x",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: true })),
    );
    expect(rules.toPersonalJSON().manualProviderModelRules[0]?.config.enabled).toBe(true);
    rules = rules.setExact(
      "p",
      "model-x",
      parseModelConfig({ properties: { contextWindow: 25_000 } }),
      true,
    );
    expect(rules.toPersonalJSON().manualProviderModelRules).toEqual([]);
    expect(rules.toPersonalJSON().providerModelRules).toHaveLength(1);
    expect(() =>
      rules.setExact("p", "model-x", parseModelConfig({ enabled: true }), false),
    ).toThrow();
    rules = rules.renameExactModel("p", "model-x", "model-y");
    expect(rules.getExact("p", "model-x")).toBeUndefined();
    expect(rules.getExact("p", "model-y")).toBeDefined();
    expect(rules.deleteExact("p", "model-y").toPersonalJSON()).toEqual({
      providerModelRules: [],
      manualProviderModelRules: [],
    });
  });

  it("不接受旧持久化 type/模式布尔和宽泛层条件", () => {
    expect(() =>
      parseZCodeBuiltinModelConfigRules({
        ...emptyBuiltin,
        modelRules: [{ type: "match", modelMatch: ".*", config: {} }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalModelConfigRules({
        providerModelRules: [
          { providerId: "p", modelId: "m", useRecommendedConfig: false, config: complete },
        ],
        manualProviderModelRules: [],
      }),
    ).toThrow();
    expect(() =>
      parseZCodeBuiltinModelConfigRules({
        ...emptyBuiltin,
        modelRules: [{ modelMatch: ".*", providerMatch: "p", config: {} }],
      }),
    ).toThrow();
  });

  it("真实 Builtin 越层规则按精确 Endpoint 接回，Start 搜索保留", async () => {
    const release = JSON.parse(
      await readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
    expect(rules.toZCodeBuiltinJSON()).toEqual(release.config.modelConfigRules);
    const resolve = (baseUrl: string, modelId = "unknown-model", apiType = "anthropic-messages") =>
      rules.resolve({
        providerId: "custom:site-test",
        modelId,
        apiType,
        baseUrl,
      }).properties;
    for (const baseUrl of [
      "https://api.z.ai/api/anthropic",
      "https://open.bigmodel.cn/api/anthropic",
      "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    ]) {
      expect(resolve(baseUrl)?.inputFormat).toMatchObject({
        supportsImage: true,
        supportsVideo: true,
      });
    }
    expect(resolve("https://zcode.z.ai/api/v1/zcode-plan/anthropic")?.supportsNativeWebSearch).toBe(
      true,
    );
    expect(resolve("https://api.z.ai/api/anthropic")?.supportsNativeWebSearch).toBe(true);
    expect(resolve("https://open.bigmodel.cn/api/anthropic")?.supportsMidConversationSystem).toBe(
      true,
    );
    for (const baseUrl of [
      "https://open.bigmodel.cn/api/off-peak/anthropic",
      "https://api.z.ai/api/anthropic-extra",
      "https://attacker.test/api/anthropic",
    ]) {
      expect(resolve(baseUrl)?.inputFormat?.supportsVideo).toBe(false);
    }
    expect(
      resolve("https://api.anthropic.com/v1", "vendor/claude-test")?.supportsNativeWebSearch,
    ).toBe(true);
    expect(resolve("https://attacker.test/v1", "vendor/claude-test")?.supportsNativeWebSearch).toBe(
      false,
    );
    expect(resolve("https://api.moonshot.cn/anthropic", "kimi-k3")?.requiresMfjsToolSchema).toBe(
      true,
    );
    expect(resolve("https://attacker.test/anthropic", "kimi-k3")?.requiresMfjsToolSchema).toBe(
      false,
    );
    expect(resolve("https://api.deepseek.com/anthropic")?.supportsMidConversationSystem).toBe(true);
    expect(
      resolve("https://api.deepseek.com/anthropic", "unknown-model", "openai-chat-completions")
        ?.supportsMidConversationSystem,
    ).toBe(false);
  });
});
