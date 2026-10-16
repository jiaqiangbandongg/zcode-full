import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import { ModelConfig, ModelConfigRules, parseZCodeBuiltinModelConfigRules } from "@zcode/provider";

const url = "https://opencode.ai/zen/go/v1";
const members = {
  "opencode-go-chat": [
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "hy4-preview",
    "hy3",
  ],
  "opencode-go-messages": [
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
  ],
  "opencode-go-responses": ["gpt-5.6-luna", "grok-4.6"],
};
const enabled = new Set([
  "glm-5.3-flash",
  "glm-5.3",
  "kimi-k3",
  "kimi-k2.7-code",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m3",
  "qwen3.8-max",
  "qwen3.8-flash",
  "gpt-5.6-luna",
  "grok-4.6",
]);
let rules: ModelConfigRules;
let templates: {
  templateId: string;
  config: {
    api: { type: string; baseUrl: string };
    access: unknown;
    logo: unknown;
    builtinModelIds: string[];
  };
}[];
beforeAll(async () => {
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
  templates = release.config.providerConfigRules.templateRules;
});
const input = (modelId: string, apiType = "openai-chat-completions", baseUrl = url) => ({
  providerId: "personal-go",
  modelId,
  apiType,
  baseUrl,
});
const patch = (config: ModelConfig, level: string) =>
  compileModelOptionMaps({
    reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
    maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
  }).apply({}, { reasoningLevel: level, maxOutputTokens: 4096 });

describe("Todo149 Go 模板与自建供应商共用站点规则", () => {
  it.each(Object.entries(members))("%s 按官方协议列成员，模板只决定默认启停", (templateId, ids) => {
    const t = templates.find((t) => t.templateId === templateId)!;
    expect(t).toBeDefined();
    expect(t.config.builtinModelIds).toEqual(
      [...ids].sort((a, b) => Number(enabled.has(b)) - Number(enabled.has(a))),
    );
    expect(t.config.api).toEqual({
      type: templateId.endsWith("chat")
        ? "openai-chat-completions"
        : templateId.endsWith("messages")
          ? "anthropic-messages"
          : "openai-responses",
      baseUrl: url,
    });
    expect(t.config.access).toEqual({
      type: "api-key",
      apiKeyManagementUrl: "https://opencode.ai/auth",
    });
    expect(t.config.logo).toEqual({ type: "builtin", key: "opencode" });
    for (const modelId of ids) {
      const i = input(modelId, t.config.api.type);
      const fromTemplate = rules.resolve({ ...i, templateId });
      const manual = rules.resolve(i);
      expect(fromTemplate.validateComplete(), modelId).toEqual([]);
      expect(fromTemplate.enabled, modelId).toBe(enabled.has(modelId));
      expect(fromTemplate.properties?.toJSON()).toEqual(manual.properties?.toJSON());
      expect(fromTemplate.optionSpecs?.toJSON()).toEqual(manual.optionSpecs?.toJSON());
      expect(manual.properties?.supportsNativeWebSearch, modelId).toBe(false);
      for (const level of fromTemplate.optionSpecs!.reasoningLevel!.values!)
        expect(() => patch(fromTemplate, level), `${modelId}/${level}`).not.toThrow();
    }
  });

  // 原因：GLM 落入通用四组参数兜底，Go 上游严格校验并拒绝 enable_thinking/reasoning。
  it.each(["glm-5.3", "glm-5.3-flash"])(
    "%s 每个档位仅发送 reasoning_effort，不修改其他站点",
    (modelId) => {
      for (const level of ["low", "high", "max"]) {
        expect(patch(rules.resolve(input(modelId)), level)).toEqual({
          reasoning_effort: level,
          max_tokens: 4096,
        });
        expect(patch(rules.resolve(input(modelId, undefined, `${url}/`)), level)).toEqual({
          reasoning_effort: level,
          max_tokens: 4096,
        });
      }
      for (const other of [
        "https://opencode.ai/zen/v1",
        "https://opencode.ai.evil.test/zen/go/v1",
        "https://opencode.ai/zen/go/v10",
        "https://other.test/zen/go/v1",
      ]) {
        expect(patch(rules.resolve(input(modelId, undefined, other)), "high")).toHaveProperty(
          "enable_thinking",
          true,
        );
      }
      expect(patch(rules.resolve(input(modelId, "anthropic-messages")), "high")).toHaveProperty(
        "thinking",
      );
    },
  );

  it.each([
    ["glm-5.2", ["high", "max"], 1000000, 131072],
    ["glm-5.1", ["enabled"], 202752, 32768],
    ["kimi-k3", ["max"], 1048576, 131072],
    ["kimi-k2.7-code", ["enabled"], 262144, 262144],
    ["deepseek-v4-pro", ["high", "max"], 1000000, 384000],
    ["hy3", ["none", "low", "high"], 256000, 128000],
    ["hy4-preview", ["none", "high"], 1024000, 64000],
  ] as const)("%s 使用 Go 能力而不是同名原厂默认", (id, levels, context, max) => {
    const c = rules.resolve(input(id));
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual(levels);
    expect(c.properties?.contextWindow).toBe(context);
    expect(c.optionSpecs?.maxOutputTokens?.max).toBe(max);
  });

  it("视觉与桥接分离；Qwen 的 Go 输出上限不照搬原厂", () => {
    expect(rules.resolve(input("glm-5.3")).properties?.inputFormat.supportsImage).toBe(false);
    expect(rules.resolve(input("glm-5.3-flash")).properties?.inputFormat.toJSON()).toMatchObject({
      supportsImage: true,
      supportsVideo: true,
      supportsPdf: true,
    });
    expect(rules.resolve(input("deepseek-v4-flash")).properties?.inputFormat.supportsImage).toBe(
      false,
    );
    expect(
      rules.resolve(input("deepseek-v4-flash-vision-exp")).properties?.inputFormat.supportsImage,
    ).toBe(true);
    for (const id of ["qwen3.7-max", "qwen3.7-plus"])
      expect(rules.resolve(input(id, "anthropic-messages")).optionSpecs?.maxOutputTokens?.max).toBe(
        65536,
      );
  });

  it.each(["provider-model", "manual-provider-model"] as const)(
    "%s 的个人 Map 仍然优先",
    (type) => {
      const personal = new ModelConfigRules([
        {
          type,
          providerId: "personal-go",
          modelId: "glm-5.3",
          config: new ModelConfig({
            optionSpecs: {
              reasoningLevel: { values: ["high"], map: '{"custom_effort": reasoningLevel}' },
              maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
            },
          }),
        },
      ]);
      const c = ModelConfigRules.composeEffective(rules, personal).resolve(input("glm-5.3"));
      expect(patch(c, "high")).toEqual({ custom_effort: "high", max_tokens: 4096 });
      if (type === "manual-provider-model") expect(c.properties?.contextWindow).toBeUndefined();
    },
  );
});
