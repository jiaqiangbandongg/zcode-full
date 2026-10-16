import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import { compileModelOptionMaps } from "@zcode/model-option-map";

describe("发布模型规则的前后缀与覆盖顺序", () => {
  it("OpenRouter Messages 的 GPT 选择实际生成对应 effort，保留完整请求型号", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const snapshot = await source.read();
      for (const modelId of ["openai/gpt-5.6-sol", "openai/gpt-5.3-codex"]) {
        const config = snapshot.models.resolve({
          providerId: "router-instance",
          templateId: "openrouter",
          modelId,
          apiType: "anthropic-messages",
          baseUrl: "https://openrouter.ai/api",
        });
        const maps = compileModelOptionMaps({
          reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
          maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
        });
        for (const reasoningLevel of config.optionSpecs!.reasoningLevel!.values!) {
          const request = maps.apply(
            { model: modelId, messages: [] },
            { reasoningLevel, maxOutputTokens: 1000 },
          );
          expect(request).toEqual({
            model: modelId,
            messages: [],
            max_tokens: 1000,
            output_config: { effort: reasoningLevel },
          });
        }
      }
    } finally {
      source.dispose();
    }
  });
  it.each(["anthropic-messages", "openai-chat-completions", "openai-responses"] as const)(
    "%s：等价前后缀复用能力与 Map，不依赖聚合站点白名单",
    async (apiType) => {
      const source = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: fileURLToPath(
          new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        ),
        watch: false,
      });
      try {
        const snapshot = await source.read();
        const modelIds = [
          "GLM-5.3",
          "GLM-5.3-Flash",
          "GLM-5.2",
          "GLM-4.6v",
          "GLM-4.7-FlashX",
          "gpt-5.6-sol",
          "claude-haiku-4-5-20251001",
          "claude-opus-5",
          "MiniMax-M2.7-highspeed",
          "MiniMax-M3",
          "kimi-k3",
          "k3-256k",
          "mimo-v2.5-pro",
          "qwen3.8-flash",
          "deepseek-v4-pro",
          "grok-4.6",
        ];
        const get = (modelId: string) =>
          snapshot.models
            .resolve({
              providerId: "custom-alias-check",
              modelId,
              apiType,
              baseUrl: "https://example.test/v1",
            })
            .toJSON();
        for (const modelId of modelIds) {
          const expected = get(modelId);
          for (const alias of [
            `vendor/${modelId}`,
            `gateway/vendor/${modelId}`,
            `${modelId}-20250901`,
            `gateway/${modelId}-20250901`,
            `gateway/${modelId}:free`,
          ]) {
            expect(get(alias), alias).toEqual(expected);
          }
        }
        // 先族基线、后具体变体：不能把匹配范围扩大后让族规则重新盖掉具体配置。
        expect(get("gateway/GLM-5.3-Flash-20250901").properties?.inputFormat?.supportsImage).toBe(
          true,
        );
        expect(get("gateway/GLM-5.3-20250901").properties?.inputFormat?.supportsImage).toBe(false);
        expect(get("gateway/k3-256k-20250901").properties?.contextWindow).toBe(262_144);
        expect(get("gateway/mimo-v2.5-pro-20250901").properties?.inputFormat?.supportsVideo).toBe(
          false,
        );
        for (const modelId of [
          "GLM-5-Turbo",
          "GLM-4.7-Flash",
          "GLM-4.7-FlashX",
          "MiniMax-M2.5-highspeed",
          "GLM-4.1V-Thinking-Flash",
        ]) {
          expect(get(`vendor/${modelId}:free`), modelId).toEqual(get(modelId));
        }
      } finally {
        source.dispose();
      }
    },
  );

  it("聚合模板的每家维护厂商有默认启用代表，所有成员能形成完整配置和请求 Map", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const enabledVendors = new Set<string>();
      for (const templateId of [
        "openrouter",
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]) {
        const template = snapshot.providerTemplates!.get(templateId)!;
        const api = template.config.api!;
        for (const modelId of template.config.builtinModelIds!) {
          const config = snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: api.type!,
            baseUrl: api.baseUrl!,
          });
          expect(config.validateComplete(), `${templateId}/${modelId}`).toEqual([]);
          if (templateId === "openrouter" && config.enabled)
            enabledVendors.add(modelId.split("/")[0]!);
          const maps = compileModelOptionMaps({
            reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
            maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
          });
          for (const reasoningLevel of config.optionSpecs!.reasoningLevel!.values!) {
            const request = maps.apply(
              { model: modelId, messages: [] },
              { reasoningLevel, maxOutputTokens: 1000 },
            );
            expect(request.model).toBe(modelId);
            expect(
              request[
                api.type === "openai-responses"
                  ? "max_output_tokens"
                  : api.type === "openai-chat-completions"
                    ? "max_completion_tokens"
                    : "max_tokens"
              ],
            ).toBe(1000);
          }
        }
      }
      expect([...enabledVendors].sort()).toEqual(
        [
          "anthropic",
          "deepseek",
          "minimax",
          "moonshotai",
          "openai",
          "qwen",
          "x-ai",
          "xiaomi",
          "z-ai",
        ].sort(),
      );
    } finally {
      source.dispose();
    }
  });
});
