import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";

type Release = {
  config: {
    providerConfigRules: {
      templateRules: { templateId: string; config: { builtinModelIds: string[] } }[];
    };
    modelConfigRules: {
      modelRules: unknown[];
      modelApiRules: unknown[];
      providerSiteRules: unknown[];
      templateModelRules: { templateId: string; modelId: string; config: { enabled: boolean } }[];
      builtinProviderModelRules: unknown[];
    };
  };
};
let release: Release;
let rules: ReturnType<typeof parseZCodeBuiltinModelConfigRules>;
beforeAll(async () => {
  release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
});
const resolve = (
  modelId: string,
  apiType = "openai-chat-completions",
  baseUrl = "https://fixture.invalid/v1",
  templateId?: string,
) => rules.resolve({ providerId: "fixture", modelId, apiType, baseUrl, templateId });
const patch = (modelId: string, apiType: string, baseUrl: string, reasoningLevel: string) => {
  const config = resolve(modelId, apiType, baseUrl);
  expect(config.optionSpecs?.reasoningLevel?.values).toContain(reasoningLevel);
  return compileModelOptionMaps({
    reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
    maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
  }).apply({}, { reasoningLevel, maxOutputTokens: 4096 });
};

describe("Todo113 第二轮：原厂、聚合、快照必须有独立正确配置", () => {
  it.each([
    ["gpt-5.4", 1050000, ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4-pro", 1050000, ["medium", "high", "xhigh"]],
    ["gpt-5.4-mini", 400000, ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4-nano", 400000, ["none", "low", "medium", "high", "xhigh"]],
  ])("%s 原厂、Zen、OR 前缀与快照一致", (id, context, levels) => {
    for (const [api, url, template, name] of [
      ["openai-responses", "https://api.openai.com/v1", "openai", id],
      ["openai-responses", "https://opencode.ai/zen/v1", "opencode-zen-responses", id],
      ["anthropic-messages", "https://openrouter.ai/api", "openrouter", `openai/${id}`],
    ]) {
      const config = resolve(String(name), String(api), String(url), String(template));
      expect(config.validateComplete()).toEqual([]);
      expect(config.properties?.contextWindow).toBe(context);
      expect(config.optionSpecs?.maxOutputTokens?.max).toBe(128000);
      expect(config.optionSpecs?.reasoningLevel?.values).toEqual(levels);
      expect(config.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: true,
        supportsPdf: true,
        supportsVideo: false,
        supportsAudio: false,
      });
      expect(config.properties?.supportsJsonSchemaOutput).toBe(true);
      expect(config.enabled).toBe(false);
    }
    expect(resolve(`vendor/${id}-2026-03-05`).properties?.contextWindow).toBe(context);
  });
  it.each([
    ["qwen3.7-max", 131072, false, false, true],
    ["qwen3.7-max-2026-06-08", 131072, true, true, true],
    ["qwen3.7-plus", 131072, true, true, true],
    ["qwen3.7-flash", 131072, true, true, false],
    ["qwen3.6-plus", 65536, true, true, false],
    ["qwen3.6-flash", 65536, true, true, false],
  ] as const)("%s 不混淆默认别名、视觉快照、JSON 与 Schema", (id, max, image, video, schema) => {
    for (const name of [id, `vendor/${id}`]) {
      const config = resolve(name);
      expect(config.properties?.contextWindow).toBe(1000000);
      expect(config.optionSpecs?.maxOutputTokens?.max).toBe(max);
      expect(config.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
      expect(config.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: image,
        supportsVideo: video,
        supportsAudio: false,
        supportsPdf: false,
      });
      expect(config.properties?.supportsJsonSchemaOutput).toBe(schema);
    }
  });
  it("Omni 独立容量、模态与值域，不套普通 Flash", () => {
    const c = resolve("qwen3.8-omni-flash");
    expect(c.properties?.contextWindow).toBe(65536);
    expect(c.optionSpecs?.maxOutputTokens?.max).toBe(16384);
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(c.properties?.inputFormat.toJSON()).toMatchObject({
      supportsImage: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsPdf: false,
    });
    expect(c.properties?.supportsJsonSchemaOutput).toBe(false);
    expect(c.properties?.supportsNativeWebSearch).toBe(false);
  });
  it("高速 Code 不提供官方拒绝的关闭档，K2.6 不受影响", () => {
    for (const id of [
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "vendor/kimi-k2.7-code-highspeed",
    ]) {
      const c = resolve(id);
      expect(c.optionSpecs?.reasoningLevel?.values).toEqual(["enabled"]);
      expect(c.properties?.contextWindow).toBe(262144);
      expect(c.optionSpecs?.maxOutputTokens?.max).toBe(98304);
    }
    expect(resolve("kimi-k2.6").optionSpecs?.reasoningLevel?.values).toEqual([
      "disabled",
      "enabled",
    ]);
  });
  it("网关能力与容量仅覆盖真实站点，不能污染原厂及相似恶意域名", () => {
    const router = (id: string) => resolve(id, "anthropic-messages", "https://openrouter.ai/api");
    expect(router("deepseek/deepseek-v4.1-flash").properties?.contextWindow).toBe(1048576);
    expect(router("deepseek/deepseek-v4.1-flash").properties?.supportsJsonSchemaOutput).toBe(true);
    expect(resolve("deepseek-v4.1-flash").properties?.contextWindow).toBe(1000000);
    expect(router("qwen/qwen3.7-flash").optionSpecs?.maxOutputTokens?.max).toBe(65536);
    expect(router("qwen/qwen3.7-plus").properties?.inputFormat.supportsVideo).toBe(false);
    expect(router("qwen/qwen3.8-max-0902").optionSpecs?.reasoningLevel?.values).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(resolve("qwen3.8-max-0902").optionSpecs?.reasoningLevel?.values).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
    for (const id of ["qwen3.6-plus", "qwen3.6-flash"]) {
      expect(router(`qwen/${id}`).properties?.supportsJsonSchemaOutput).toBe(true);
      expect(resolve(id).properties?.supportsJsonSchemaOutput).toBe(false);
    }
    expect(
      resolve(
        "qwen/qwen3.7-plus",
        "anthropic-messages",
        "https://openrouter.ai.attacker.invalid/api",
      ).properties?.inputFormat.supportsVideo,
    ).toBe(true);
    expect(resolve("deepseek-v4-flash").properties?.inputFormat.supportsImage).toBe(false);
    expect(resolve("deepseek-v4-pro").properties?.inputFormat.supportsImage).toBe(false);
  });
  it("专用协议 Map 不向官方接口注入其他厂商字段", () => {
    expect(
      patch("gpt-5.4", "openai-chat-completions", "https://api.openai.com/v1", "none"),
    ).toEqual({ reasoning_effort: "none", max_completion_tokens: 4096 });
    expect(patch("gpt-5.4-pro", "openai-responses", "https://api.openai.com/v1", "xhigh")).toEqual({
      reasoning: { effort: "xhigh" },
      max_output_tokens: 4096,
    });
    expect(
      patch("openai/gpt-5.4-mini", "anthropic-messages", "https://openrouter.ai/api", "none"),
    ).toEqual({ thinking: { type: "disabled" }, max_tokens: 4096 });
    expect(
      patch("openai/gpt-5.4-mini", "anthropic-messages", "https://openrouter.ai/api", "low"),
    ).toEqual({ output_config: { effort: "low" }, max_tokens: 4096 });
    expect(
      patch(
        "qwen3.7-plus",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "disabled",
      ),
    ).toEqual({ enable_thinking: false, max_completion_tokens: 4096 });
    expect(
      patch(
        "qwen/qwen3.7-plus",
        "openai-chat-completions",
        "https://openrouter.ai/api/v1",
        "enabled",
      ),
    ).toEqual({ reasoning: { enabled: true }, max_completion_tokens: 4096 });
    expect(
      patch(
        "deepseek/deepseek-v4.1-flash",
        "openai-chat-completions",
        "https://openrouter.ai/api/v1",
        "disabled",
      ),
    ).toEqual({ reasoning: { enabled: false }, max_completion_tokens: 4096 });
    expect(
      patch(
        "qwen3.8-omni-flash",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "max",
      ),
    ).toEqual({ reasoning_effort: "max", max_completion_tokens: 4096 });
  });
  it.each([
    "gpt-5.4-image-2",
    "gpt-5.40",
    "gpt-5.4-future",
    "qwen3.7-omni-flash",
    "qwen3.6-max-preview",
    "deepseek-v4.1-pro",
  ])("相邻型号 %s 不被新规则吞掉", (id) => {
    expect(resolve(id).properties?.contextWindow).toBe(200000);
  });
  it("个人参数仍可覆盖新 Built-in，不代写保存的选择", () => {
    const c = resolve("gpt-5.4").overlay(
      new ModelConfig({
        optionSpecs: new ModelOptionSpecsConfig({
          reasoningLevel: { values: ["personal"], map: '{"custom": true}' },
        }),
      }),
    );
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual(["personal"]);
    expect(c.optionSpecs?.reasoningLevel?.map).toBe('{"custom": true}');
  });
  it("目录与精确默认成对维护，原厂退役不波及第三方和模型规则", () => {
    const ids = (id: string) =>
      release.config.providerConfigRules.templateRules.find((t) => t.templateId === id)!.config
        .builtinModelIds;
    for (const t of release.config.providerConfigRules.templateRules) {
      for (const id of t.config.builtinModelIds)
        expect(
          release.config.modelConfigRules.templateModelRules.filter(
            (r) => r.templateId === t.templateId && r.modelId === id,
          ),
          `${t.templateId}/${id}`,
        ).toHaveLength(1);
    }
    for (const t of ["openai", "openrouter"])
      for (const id of ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"])
        expect(ids(t)).toContain(t === "openrouter" ? `openai/${id}` : id);
    for (const t of ["qwen-alibaba-model-studio-cn", "qwen-alibaba-model-studio-intl"])
      for (const id of [
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.7-flash",
        "qwen3.6-plus",
        "qwen3.6-flash",
      ])
        expect(ids(t)).toContain(id);
    expect(ids("qwen-alibaba-model-studio-intl")).toContain("qwen3.8-omni-flash");
    expect(ids("moonshot-kimi")).toContain("kimi-k2.7-code-highspeed");
    expect(ids("openrouter")).toContain("deepseek/deepseek-v4.1-flash");
    expect(ids("openrouter")).toContain("qwen/qwen3.8-max-0902");
    for (const [t, removed] of [
      ["deepseek", ["deepseek-v4-flash"]],
      ["xiaomi-mimo", ["mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"]],
      [
        "moonshot-kimi",
        [
          "kimi-k2.5",
          "moonshot-v1-8k",
          "moonshot-v1-32k",
          "moonshot-v1-128k",
          "moonshot-v1-8k-vision-preview",
          "moonshot-v1-32k-vision-preview",
          "moonshot-v1-128k-vision-preview",
        ],
      ],
    ] as const) {
      for (const id of removed) {
        expect(ids(t)).not.toContain(id);
        expect(
          release.config.modelConfigRules.templateModelRules.filter(
            (r) => r.templateId === t && r.modelId === id,
          ),
        ).toEqual([]);
      }
    }
    expect(ids("deepseek")).toContain("deepseek-v4-pro");
    expect(ids("openrouter")).toContain("moonshotai/kimi-k2.5");
    expect(ids("openrouter")).toContain("deepseek/deepseek-v4-flash");
    expect(resolve("mimo-v2-flash").properties?.contextWindow).toBe(262144);
  });
});
