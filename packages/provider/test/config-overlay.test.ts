import { describe, expect, it } from "vitest";
import {
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  parseModelConfig,
  parseProviderConfigMap,
} from "../src/index.js";

describe("ProviderConfigMap overlay", () => {
  it("Provider enabled 位于外层；Overlay、往返及后续配置写入保留 false", () => {
    const base = parseProviderConfigMap([{ providerId: "p", enabled: true, config: {} }]);
    const off = parseProviderConfigMap([{ providerId: "p", enabled: false, config: {} }]);
    const updated = base
      .overlay(off)
      .overlay(parseProviderConfigMap([{ providerId: "p", providerName: "renamed", config: {} }]));
    expect(updated.getRule("p")?.enabled).toBe(false);
    expect(parseProviderConfigMap(updated.toJSON()).getRule("p")?.enabled).toBe(false);
    expect(() =>
      parseProviderConfigMap([{ providerId: "p", config: { enabled: false } }]),
    ).toThrow();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "完整属性和保存 Schema 一致拒绝非法 contextWindow：%s",
    (contextWindow) => {
      const properties = new ModelPropertiesConfig({
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
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      });
      expect(() => parseModelConfig({ properties: properties.toJSON() })).toThrow();
      expect(properties.validateComplete()).toContainEqual(
        expect.objectContaining({ path: ["contextWindow"] }),
      );
    },
  );

  it.each([{ values: [" "] }, { values: ["low", "low"] }])(
    "稀疏 Schema 同样拒绝非法档位 $values",
    ({ values }) => {
      expect(() => parseModelConfig({ optionSpecs: { reasoningLevel: { values } } })).toThrow();
    },
  );

  it("完整输出上限拒绝非安全整数", () => {
    const spec = new LimitOptionSpecConfig({
      max: Number.MAX_SAFE_INTEGER + 1,
      map: "{'max_tokens': maxOutputTokens}",
    });
    expect(spec.validateComplete()).toContainEqual(expect.objectContaining({ path: ["max"] }));
  });
  it("保留 ZCodeBuiltin key 的位置，并按 Personal 顺序追加新 key", () => {
    const zcodeBuiltin = new ProviderConfigMap([
      {
        providerId: "A",
        providerName: "ZCodeBuiltin A",
        config: new ProviderConfig({
          logo: { type: "builtin", key: "provider-a" },
          builtinModelIds: ["m1", "m2"],
        }),
      },
      ["B", new ProviderConfig({ api: new ProviderApiConfig({ baseUrl: "https://b.example" }) })],
      ["C", new ProviderConfig({ api: new ProviderApiConfig({ baseUrl: "https://c.example" }) })],
    ]);
    const personal = new ProviderConfigMap([
      ["Y", new ProviderConfig()],
      { providerId: "C", providerName: "Personal C", config: new ProviderConfig({}) },
      ["X", new ProviderConfig()],
      {
        providerId: "A",
        providerName: "Personal A",
        config: new ProviderConfig({
          access: new ApiKeyAccessConfig({
            apiKeyManagementUrl: "https://personal.example/api-keys",
          }),
          personalModelIds: ["m1"],
        }),
      },
    ]);

    const effective = zcodeBuiltin.overlay(personal);

    expect(effective.keys()).toEqual(["A", "B", "C", "Y", "X"]);
    expect(effective.get("A")?.builtinModelIds).toEqual(["m1", "m2"]);
    expect(effective.get("A")?.personalModelIds).toEqual(["m1"]);
    expect(effective.getRule("A")?.providerName).toBe("Personal A");
    expect(effective.get("A")?.logo).toEqual({ type: "builtin", key: "provider-a" });
    expect(
      effective.get("A")?.access?.type === "api-key"
        ? effective.get("A")?.access.apiKeyManagementUrl
        : undefined,
    ).toBe("https://personal.example/api-keys");
    expect(effective.get("C")?.api?.baseUrl).toBe("https://c.example");
    expect(effective.getRule("C")?.providerName).toBe("Personal C");
    expect(zcodeBuiltin.get("A")?.builtinModelIds).toEqual(["m1", "m2"]);
    expect(personal.keys()).toEqual(["Y", "C", "X", "A"]);
  });

  it("按照给定顺序重排已有 key，同时保留未提到的 key", () => {
    const personal = new ProviderConfigMap([
      ["Y", new ProviderConfig()],
      { providerId: "C", providerName: "Personal C", config: new ProviderConfig({}) },
      ["X", new ProviderConfig()],
      ["A", new ProviderConfig({ personalModelIds: ["m1"] })],
      ["unmentioned", new ProviderConfig()],
    ]);

    const reordered = personal.reorder(["A", "B", "C", "X", "Y"]);

    expect(reordered.keys()).toEqual(["A", "C", "X", "Y", "unmentioned"]);
    expect(personal.keys()).toEqual(["Y", "C", "X", "A", "unmentioned"]);
  });

  it("递归覆盖 Config 字段，并整体替换普通字段", () => {
    const base = new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 200_000,
        inputFormat: new ModelInputFormatConfig({
          supportsText: true,
          supportsImage: false,
          supportsPdf: false,
        }),
        outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: {
          values: ["low", "high"],
          map: "{'reasoning': {'effort': reasoningLevel}}",
        },
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_output_tokens': maxOutputTokens}",
        },
      }),
    });
    const patch = new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: true,
        inputFormat: new ModelInputFormatConfig({ supportsImage: true }),
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: { values: ["off", "on"] },
      }),
    });

    const effective = base.overlay(patch);

    expect(effective.properties?.contextWindow).toBe(200_000);
    expect(effective.properties?.inputFormat?.supportsText).toBe(true);
    expect(effective.properties?.inputFormat?.supportsImage).toBe(true);
    expect(effective.properties?.inputFormat?.supportsPdf).toBe(false);
    expect(effective.properties?.outputFormat?.supportsText).toBe(true);
    expect(effective.optionSpecs?.reasoningLevel).toEqual({
      values: ["off", "on"],
      map: "{'reasoning': {'effort': reasoningLevel}}",
    });
    expect(effective.optionSpecs?.maxOutputTokens).toEqual({
      max: 32_000,
      map: "{'max_output_tokens': maxOutputTokens}",
    });
    expect(effective.properties?.requiresMfjsToolSchema).toBe(true);
  });

  it("最终 Option Spec 必须包含可编译且返回 Object 的 map", () => {
    const model = new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 200_000,
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
          map: "reasoningLevel.field",
        },
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_tokens': maxOutputTokens}",
        },
      }),
    });

    expect(model.validateComplete(["models", "example"])).toContainEqual({
      code: "invalid-option-spec",
      path: ["models", "example", "optionSpecs", "reasoningLevel", "map"],
      message: expect.stringContaining("member access"),
    });
  });

  it("Option Spec 只能引用自己的同名输入变量", () => {
    expect(() =>
      parseModelConfig({
        optionSpecs: {
          reasoningLevel: {
            map: "{'reasoning_effort': maxOutputTokens}",
          },
        },
      }),
    ).toThrow(/maxOutputTokens/);

    expect(() =>
      parseModelConfig({
        optionSpecs: {
          maxOutputTokens: {
            map: "{'max_tokens': reasoningLevel}",
          },
        },
      }),
    ).toThrow(/reasoningLevel/);
  });

  it("使用 supportsJsonSchemaOutput 表达严格 JSON Schema 能力", () => {
    expect(
      parseModelConfig({
        properties: { supportsJsonSchemaOutput: true },
      }).properties?.supportsJsonSchemaOutput,
    ).toBe(true);
    expect(() =>
      parseModelConfig({
        properties: { supportsStructuredOutput: true },
      }),
    ).toThrow();
  });

  it("最终 Model Config 必须包含完整 Reasoning Option Spec", () => {
    const model = new ModelConfig({
      optionSpecs: new ModelOptionSpecsConfig({
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_tokens': maxOutputTokens}",
        },
      }),
    });

    expect(
      model.optionSpecs?.validateComplete(["models", "example", "optionSpecs"]),
    ).toContainEqual(
      expect.objectContaining({
        code: "required-field-missing",
        path: ["models", "example", "optionSpecs", "reasoningLevel"],
      }),
    );
  });

  it("接受 disabled 单档位与空 Request Body Patch 作为无推理基线", () => {
    const optionSpecs = new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    });

    expect(optionSpecs.validateComplete(["models", "example", "optionSpecs"])).toEqual([]);
  });

  it.each([
    { values: [], message: "reasoningLevel.values 不能为空" },
    { values: ["low", ""], message: "reasoningLevel.values 必须是非空字符串" },
    { values: ["low", "low"], message: "reasoningLevel.values 不能重复" },
  ])("拒绝不完整的 Reasoning 档位：$message", ({ values, message }) => {
    const spec = new EnumOptionSpecConfig({ values, map: "{}" });

    expect(spec.validateComplete(["optionSpecs", "reasoningLevel"])).toContainEqual(
      expect.objectContaining({ code: "invalid-option-spec", message }),
    );
  });

  it("Schema 在写入边界拒绝返回非 Object 的 Option map", () => {
    expect(() =>
      parseModelConfig({
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: "reasoningLevel",
          },
        },
      }),
    ).toThrow(/object/i);
  });

  it("Schema 拒绝已退役的 Option Spec default", () => {
    expect(() =>
      parseModelConfig({
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            default: "high",
            map: "{'reasoning': {'effort': reasoningLevel}}",
          },
        },
      }),
    ).toThrow(/unrecognized|default/i);
  });

  it("用 null 清除字段，并在最终完整性校验中报告必填值缺失", () => {
    const base = new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 200_000,
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
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_tokens': maxOutputTokens}",
        },
      }),
    });

    const effective = base.overlay(
      new ModelConfig({
        properties: new ModelPropertiesConfig({
          requiresMfjsToolSchema: null,
          contextWindow: null,
        }),
      }),
    );

    expect(effective.properties?.contextWindow).toBeNull();
    expect(effective.validateComplete(["models", "example"])).toContainEqual({
      code: "required-field-missing",
      path: ["models", "example", "properties", "contextWindow"],
      message: "缺少必填配置 models.example.properties.contextWindow",
    });
    expect(effective.validateComplete(["models", "example"])).toContainEqual({
      code: "required-field-missing",
      path: ["models", "example", "properties", "requiresMfjsToolSchema"],
      message: "缺少必填配置 models.example.properties.requiresMfjsToolSchema",
    });
  });

  it("从普通 Object 解析，并拒绝未知字段", () => {
    const parsed = parseProviderConfigMap([
      {
        providerId: "local",
        config: {
          access: { type: "api-key", apiKey: "test-key" },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://api.example.com",
          },
          builtinModelIds: ["model-a"],
        },
      },
    ]);

    expect(parsed.keys()).toEqual(["local"]);
    expect(parsed.get("local")?.api?.baseUrl).toBe("https://api.example.com");
    expect(() =>
      parseProviderConfigMap([{ providerId: "invalid", config: { unknownField: true } }]),
    ).toThrow();
  });
});
