import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  validateModelSelectionOptions,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import baseline from "./fixtures/reasoning-map-before-todo95.json";

const source = new NodeZCodeBuiltinProviderConfigSource({
  bundledFilePath: fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
  watch: false,
});
let snapshot: Awaited<ReturnType<typeof source.read>>;
type Rule = {
  modelMatch: string;
  apiTypeMatch: string;
  baseUrlMatch?: string;
  config: { optionSpecs?: { reasoningLevel?: { map?: string } } };
};
let rules: Record<string, Rule[]>;
beforeAll(async () => {
  snapshot = await source.read();
  rules = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  ).config.modelConfigRules;
});
afterAll(() => source.dispose());

// 基线取自 a56dc32c26 的专用表达式，按相同表达式分组但逐条验证规则，不能随美化更新预期。
const levels = [
  ["low", "high", "max"],
  ["low", "high", "max"],
  ["off", "nothink", "disabled", "enabled"],
  ["nothink", "high", "max"],
  ["low", "high", "max"],
  ["none", "low", "medium", "high", "xhigh", "max"],
  ["low", "medium", "high", "xhigh"],
  ["low", "medium", "high", "xhigh", "max"],
  ["low", "high", "max"],
  ["off", "enabled"],
  ["off", "enabled"],
  ["off", "low", "high", "max"],
  ["off", "low", "high", "max"],
  ["low", "medium", "xhigh"],
  ["low", "medium", "xhigh"],
  ["low", "medium", "xhigh"],
  ["disabled", "off", "enabled"],
  ["none", "low", "medium", "high", "xhigh", "max"],
  ["off", "low", "high", "max"],
];
const outputMaps: Record<string, string> = {
  "anthropic-messages": '{"max_tokens":maxOutputTokens}',
  "openai-chat-completions": '{"max_completion_tokens":maxOutputTokens}',
  "openai-responses": '{"max_output_tokens":maxOutputTokens}',
};
const bases = [
  { model: "unchanged", messages: [] },
  {
    model: "unchanged",
    messages: [],
    thinking: { type: "before", budget_tokens: 777 },
    output_config: { effort: "before", extra: true },
    reasoning: { effort: "before", summary: "auto" },
    reasoning_effort: "before",
    enable_thinking: null,
  },
];

describe("Todo95 专用 Map 合法请求等价", () => {
  for (const [group, entry] of baseline.entries()) {
    for (const reference of entry.rules) {
      it(`${reference.scope}[${reference.index}] ${reference.modelMatch} ${reference.apiMatch}`, () => {
        // 规则重组会改变下标；按完整匹配条件定位，基线表达式及请求断言不变。
        const matches = rules[reference.scope]!.filter(
          (rule) =>
            rule.modelMatch === reference.modelMatch &&
            rule.apiTypeMatch === reference.apiMatch &&
            rule.baseUrlMatch === reference.baseURLMatch,
        );
        expect(matches).toHaveLength(1);
        const rule = matches[0]!;
        expect(rule.modelMatch).toBe(reference.modelMatch);
        expect(rule.apiTypeMatch).toBe(reference.apiMatch);
        expect(rule.baseUrlMatch).toBe(reference.baseURLMatch);
        const compile = (map: string) =>
          compileModelOptionMaps({
            reasoningLevel: { map },
            maxOutputTokens: { map: outputMaps[reference.apiMatch]! },
          });
        const before = compile(entry.map);
        const after = compile(rule.config.optionSpecs!.reasoningLevel!.map!);
        for (const reasoningLevel of levels[group]!) {
          for (const base of bases) {
            const options = { reasoningLevel, maxOutputTokens: 32000 };
            // C 改名比较旧输入/旧 Map 与新输入/新 Map；A/B 的请求基线保持不变。
            const renamed =
              reasoningLevel === "off" || reasoningLevel === "nothink"
                ? "disabled"
                : reasoningLevel;
            expect(
              after.apply(base, { ...options, reasoningLevel: renamed }),
              reasoningLevel,
            ).toEqual(before.apply(base, options));
          }
        }
      });
    }
  }
  it("历史专用 Map 不遗漏；新增型号与 Go 站点由独立配置及 wire 验证承接", () => {
    const newModelMatchers = new Set([
      // OpenRouter 的无预算 enabled 修复由 openrouter-reasoning-contract.test.ts 独立验收。
      ".*(?:glm-|deepseek-|kimi-k2|qwen|mimo-).*",
      ".*gpt-6-astra(?:[.\\-:/\\[].*)?",
      ".*claude-(?:fable|mythos)-5[.-]1(?:[.\\-:/\\[].*)?",
      ".*deepseek-flash(?:[.\\-:/\\[].*)?",
      "deepseek-flash",
      ".*gpt-5\\.4(?:-(?:pro|mini|nano))?(?:-20\\d{2}(?:-?\\d{2}){2})?(?:[:/\\[].*)?",
      ".*deepseek-v4[.-]1-flash(?:[.\\-:/\\[].*)?",
      ".*qwen3\\.(?:7-(?:max|plus|flash)|6-(?:plus|flash))(?:-20\\d{2}(?:-?\\d{2}){2})?(?:[:/\\[].*)?",
      ".*qwen3\\.8-omni-flash(?:-20\\d{2}(?:-?\\d{2}){2})?(?:[:/\\[].*)?",
    ]);
    const current = ["modelApiRules", "providerSiteRules"].flatMap((scope) =>
      rules[scope]!.flatMap((rule) =>
        rule.modelMatch !== ".*" &&
        !newModelMatchers.has(rule.modelMatch) &&
        // Go 新站点不属于 Todo95 历史基线；成员/档位/请求由 opencode-go 独立用例验证。
        !(
          scope === "providerSiteRules" && rule.baseUrlMatch === "https://opencode\\.ai/zen/go/v1/?"
        ) &&
        rule.config.optionSpecs?.reasoningLevel?.map
          ? [JSON.stringify([scope, rule.modelMatch, rule.apiTypeMatch, rule.baseUrlMatch])]
          : [],
      ),
    );
    expect(current.sort()).toEqual(
      baseline
        .flatMap((group) =>
          group.rules.map((rule) =>
            JSON.stringify([rule.scope, rule.modelMatch, rule.apiMatch, rule.baseURLMatch]),
          ),
        )
        .sort(),
    );
  });
});

describe("Todo95 API Schema 兜底", () => {
  for (const apiType of [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
  ] as const) {
    it(`${apiType} 未知模型仅加档位即可继承 Map，Personal Map 保持权威`, () => {
      const original = snapshot.models.resolve({
        providerId: "unknown",
        modelId: "future-unknown-model",
        apiType,
        baseUrl: "https://example.test/v1",
      });
      expect(original.optionSpecs!.reasoningLevel!.values).toEqual(["disabled", "enabled"]);
      const configured = original.overlay(
        new ModelConfig({
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: {
              values: [
                "disabled",
                "enabled",
                "low",
                "high",
                "max",
                ...(apiType === "anthropic-messages" ? [] : ["none"]),
              ],
            },
          }),
        }),
      );
      expect(configured.validateComplete()).toEqual([]);
      const selectionModel = {
        config: {
          optionSpecs: {
            reasoningLevel: { values: configured.optionSpecs!.reasoningLevel!.values! },
          },
        },
      };
      expect(
        validateModelSelectionOptions(selectionModel, {
          providerId: "unknown",
          modelId: "future-unknown-model",
          options: { reasoningLevel: "not-declared" },
        }),
      ).toMatchObject({ ok: false, code: "reasoning-level-not-supported" });
      const apply = (config: ModelConfig, reasoningLevel: string) =>
        compileModelOptionMaps({
          reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
          maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
        }).apply(
          { model: "future-unknown-model", messages: [] },
          { reasoningLevel, maxOutputTokens: 32000 },
        );
      for (const level of configured.optionSpecs!.reasoningLevel!.values!) {
        const effort = level === "disabled" ? "none" : level === "enabled" ? "high" : level;
        const disabled = level === "disabled" || level === "none";
        const expected =
          apiType === "anthropic-messages"
            ? level === "disabled"
              ? { thinking: { type: "disabled" } }
              : { thinking: { type: "adaptive" }, output_config: { effort } }
            : apiType === "openai-responses"
              ? { reasoning: { effort } }
              : {
                  thinking: { type: disabled ? "disabled" : "enabled" },
                  enable_thinking: !disabled,
                  reasoning_effort: effort,
                  reasoning: { effort },
                };
        const outputField =
          apiType === "anthropic-messages"
            ? "max_tokens"
            : apiType === "openai-responses"
              ? "max_output_tokens"
              : "max_completion_tokens";
        expect(apply(configured, level)).toEqual({
          model: "future-unknown-model",
          messages: [],
          ...expected,
          [outputField]: 32000,
        });
      }
      const custom = configured.overlay(
        new ModelConfig({
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: { map: '{"custom_effort":reasoningLevel}' },
          }),
        }),
      );
      const request = apply(custom, "high");
      expect(request.custom_effort).toBe("high");
      expect(request).not.toHaveProperty("thinking");
      expect(request).not.toHaveProperty("reasoning");
      expect(original.optionSpecs!.reasoningLevel!.values).toEqual(["disabled", "enabled"]);
    });
  }
});

describe("Todo138 Model 层兜底与专用档位", () => {
  it("没有 API 信息也有 Model 两档；API 通用规则不声明档位", () => {
    const result = snapshot.models.resolve({
      providerId: "unknown",
      modelId: "future-unknown-model",
    });
    expect(result.optionSpecs!.reasoningLevel!.values).toEqual(["disabled", "enabled"]);
    expect(result.optionSpecs!.reasoningLevel!.map).toBe("{}");
    for (const rule of rules.modelApiRules!.filter((rule) => rule.modelMatch === ".*")) {
      expect(rule.config.optionSpecs?.reasoningLevel).not.toHaveProperty("values");
    }
  });
  it.each([
    ["gpt-5.4", ["none", "low", "medium", "high", "xhigh"]],
    ["GLM-5.3", ["low", "high", "max"]],
  ])("%s 专用档位在三种 API 下保持", (modelId, values) => {
    for (const apiType of [
      "anthropic-messages",
      "openai-chat-completions",
      "openai-responses",
    ] as const) {
      expect(
        snapshot.models.resolve({
          providerId: "unknown",
          modelId,
          apiType,
          baseUrl: "https://example.test/v1",
        }).optionSpecs!.reasoningLevel!.values,
      ).toEqual(values);
    }
  });
});
