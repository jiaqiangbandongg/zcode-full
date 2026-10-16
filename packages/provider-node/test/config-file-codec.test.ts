import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  extractManualModelConfig,
} from "@zcode/provider";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
  UnsupportedProviderConfigVersionError,
} from "../src/provider-config-file-codec.js";

describe("provider-node private config codecs", () => {
  it.each([true, false])("Todo134：旧手动 MFJS=%s 可读取，但不继续固化隐藏字段", (value) => {
    const config = {
      properties: {
        contextWindow: 1234,
        requiresMfjsToolSchema: value,
        inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: true },
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["high"], map: "{}" },
        maxOutputTokens: { max: 128 },
      },
    };
    const input = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [{ providerId: "p", modelId: "m", config }],
        },
      },
    };
    const output = encodeProviderConfigFile(decodeProviderConfigFile(input));
    expect(output.config.modelConfigRules.manualProviderModelRules[0]?.config).toEqual(
      extractManualModelConfig(config),
    );
    expect(config.properties.requiresMfjsToolSchema).toBe(value);
    expect(encodeProviderConfigFile(decodeProviderConfigFile(output))).toEqual(output);
    Object.assign(config.properties, { unknown: true });
    expect(() => decodeProviderConfigFile(input)).toThrow();
  });
  it("Todo130：仅在文件读取规范化合法旧完整手动规则，保留顺序/默认/启停；再写不含系统叶子", () => {
    const legacy = {
      enabled: false,
      properties: {
        contextWindow: 1234,
        requiresMfjsToolSchema: false,
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: {
          supportsText: true,
          supportsAudio: false,
          supportsImage: false,
          supportsVideo: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
      },
      optionSpecs: {
        reasoningLevel: { values: ["high"], map: "{}" },
        maxOutputTokens: { max: 128, map: "{}" },
      },
    };
    const input = {
      schemaVersion: 1,
      config: {
        providerOrder: ["p"],
        defaultModelSelection: { providerId: "p", modelId: "m" },
        providerConfigRules: { providerRules: [] },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [{ providerId: "p", modelId: "m", config: legacy }],
        },
      },
    };
    const original = structuredClone(input);
    const output = encodeProviderConfigFile(decodeProviderConfigFile(input));
    expect(output).toEqual({
      ...input,
      config: {
        ...input.config,
        modelConfigRules: {
          ...input.config.modelConfigRules,
          manualProviderModelRules: [
            { providerId: "p", modelId: "m", config: extractManualModelConfig(legacy) },
          ],
        },
      },
    });
    expect(input).toEqual(original);
    expect(encodeProviderConfigFile(decodeProviderConfigFile(output))).toEqual(output);
    const invalid = structuredClone(input);
    Object.assign(invalid.config.modelConfigRules.manualProviderModelRules[0]!.config, {
      unknown: true,
    });
    expect(() => decodeProviderConfigFile(invalid)).toThrow();
    const incomplete = structuredClone(input);
    Reflect.deleteProperty(
      incomplete.config.modelConfigRules.manualProviderModelRules[0]!.config.properties,
      "supportsToolCall",
    );
    expect(() => decodeProviderConfigFile(incomplete)).toThrow();
  });
  it("round-trips Provider layer values through the versioned file format", () => {
    const update = {
      providers: new ProviderConfigMap([
        [
          "personal",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig(),
          }),
        ],
      ]),
      models: ModelConfigRules.empty(),
    };

    const encoded = encodeProviderConfigFile(update);
    expect(encoded).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "personal",
              config: { group: "standard-personal", access: { type: "api-key" } },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    });
    expect(decodeProviderConfigFile(encoded).providers.keys()).toEqual(["personal"]);
  });

  it("rejects missing, future, and structurally invalid Provider file envelopes", () => {
    expect(() => decodeProviderConfigFile({ providers: {}, modelConfigRules: [] })).toThrow(
      UnsupportedProviderConfigVersionError,
    );
    expect(() =>
      decodeProviderConfigFile({ schemaVersion: 2, providers: {}, modelConfigRules: [] }),
    ).toThrow(UnsupportedProviderConfigVersionError);
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        providers: {},
        modelConfigRules: [],
        extra: true,
      }),
    ).toThrow();
  });

  it("拒绝 Personal Provider Config 中的全局 match 规则", () => {
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        providers: {},
        modelConfigRules: {
          matchRules: [],
          providerModelRules: [],
        },
      }),
    ).toThrow();
  });

  it("round-trips a complete ModelSelection without exposing the file envelope", () => {
    const selection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    };
    const encoded = encodeProviderConfigFile({
      providers: ProviderConfigMap.empty(),
      models: ModelConfigRules.empty(),
      defaultModelSelection: selection,
    });

    expect(encoded.config.defaultModelSelection).toEqual(selection);
    expect(decodeProviderConfigFile(encoded).defaultModelSelection).toEqual(selection);
    expect(() => decodeProviderConfigFile({ schemaVersion: 2 })).toThrow(
      UnsupportedProviderConfigVersionError,
    );
  });
});
