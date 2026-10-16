import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import { ModelConfig, ModelOptionSpecsConfig } from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";

const path = fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url));
const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: path, watch: false });
let snapshot: Awaited<ReturnType<typeof source.read>>;
let modelIds: string[];
beforeAll(async () => {
  snapshot = await source.read();
  const file = JSON.parse(await readFile(path, "utf8"));
  modelIds = file.config.providerConfigRules.templateRules.find(
    (rule: { templateId: string }) => rule.templateId === "openrouter",
  ).config.builtinModelIds;
});
afterAll(() => source.dispose());

function resolve(
  modelId: string,
  baseUrl = "https://openrouter.ai/api",
  apiType = "anthropic-messages",
) {
  return snapshot.models.resolve({ providerId: "custom-router", modelId, apiType, baseUrl });
}

function body(config: ModelConfig, reasoningLevel: string, maxOutputTokens = 5000) {
  return compileModelOptionMaps({
    reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
    maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
  }).apply({ model: "unchanged", messages: [] }, { reasoningLevel, maxOutputTokens });
}

describe("OpenRouter Messages 推理请求契约", () => {
  it.each(["zcode-builtin.json", "zcode-builtin.test.json"])(
    "%s 模板仅简化名称，不改变请求协议",
    async (filename) => {
      const release = JSON.parse(
        await readFile(new URL(`../../../config/provider/${filename}`, import.meta.url), "utf8"),
      );
      const template = release.config.providerConfigRules.templateRules.find(
        (item: { templateId: string }) => item.templateId === "openrouter",
      );
      expect(template.templateNameMap).toEqual({ "zh-CN": "OpenRouter", "en-US": "OpenRouter" });
      expect(template.config.api).toEqual({
        type: "anthropic-messages",
        baseUrl: "https://openrouter.ai/api",
      });
    },
  );

  it("所有模板成员的所有档位不再生成缺预算的 enabled", () => {
    expect(modelIds.length).toBeGreaterThan(50);
    for (const id of modelIds) {
      const config = resolve(id);
      for (const level of config.optionSpecs!.reasoningLevel!.values!) {
        const request = body(config, level);
        const thinking = request.thinking as { type?: string; budget_tokens?: number } | undefined;
        if (thinking?.type === "enabled") {
          expect(Number.isInteger(thinking.budget_tokens), `${id}/${level}`).toBe(true);
          expect(thinking.budget_tokens!, `${id}/${level}`).toBeGreaterThan(0);
        }
        if (level === "disabled" || level === "none") {
          expect(thinking?.type, `${id}/${level}`).not.toBe("adaptive");
          expect(thinking?.type, `${id}/${level}`).not.toBe("enabled");
        }
      }
    }
  });

  it.each([
    ["z-ai/glm-5.3", "low"],
    ["z-ai/glm-5.3-flash", "max"],
    ["z-ai/glm-5.2", "high"],
    ["z-ai/glm-4.7", "enabled"],
    ["deepseek/deepseek-v4-pro", "max"],
    ["deepseek/deepseek-v4.1-flash", "low"],
    ["moonshotai/kimi-k2.7-code", "enabled"],
    ["moonshotai/kimi-k2.5", "enabled"],
    ["qwen/qwen3.8-max-0902", "minimal"],
    ["qwen/qwen3.7-plus", "enabled"],
    ["xiaomi/mimo-v2.5-pro", "enabled"],
  ])("%s/%s 使用 adaptive，不引入与小输出上限冲突的固定预算", (id, level) => {
    for (const baseUrl of [
      "https://openrouter.ai/api",
      "https://openrouter.ai/api/",
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai/api/v1/",
    ]) {
      expect(body(resolve(id, baseUrl), level, 1)).toEqual({
        model: "unchanged",
        messages: [],
        max_tokens: 1,
        thinking: { type: "adaptive" },
        output_config: { effort: level === "enabled" ? "high" : level },
      });
    }
  });

  it("关闭仍关闭，现有 Claude 和 GPT 映射不变", () => {
    expect(body(resolve("z-ai/glm-5.2"), "disabled")).toMatchObject({
      thinking: { type: "disabled" },
    });
    expect(body(resolve("anthropic/claude-fable-5.1"), "low")).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(body(resolve("openai/gpt-6-astra"), "high")).not.toHaveProperty("thinking");
  });

  it("不改变官方站点、相似域名、其他协议及 Personal Map", () => {
    for (const url of [
      "https://api.z.ai/api/anthropic",
      "https://open.bigmodel.cn/api/anthropic",
      "https://example.test/api",
      "https://openrouter.ai.evil.test/api",
    ]) {
      expect(body(resolve("z-ai/glm-5.3", url), "low").thinking).toEqual({ type: "enabled" });
    }
    for (const api of ["openai-chat-completions", "openai-responses"]) {
      expect(resolve("z-ai/glm-5.3", "https://openrouter.ai/api", api).optionSpecs).toEqual(
        resolve("z-ai/glm-5.3", "https://example.test/api", api).optionSpecs,
      );
    }
    const personal = resolve("z-ai/glm-5.3").overlay(
      new ModelConfig({
        optionSpecs: new ModelOptionSpecsConfig({
          reasoningLevel: { map: '{"personal_effort": reasoningLevel}' },
        }),
      }),
    );
    expect(body(personal, "high")).toEqual({
      model: "unchanged",
      messages: [],
      max_tokens: 5000,
      personal_effort: "high",
    });
  });
});
