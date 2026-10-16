import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseZCodeBuiltinModelConfigRules } from "@zcode/provider";

describe("2026-09 新模型官方目录", () => {
  it("模型身份、能力和值域独立声明，不能从旧型号宽匹配猜测", async () => {
    const release = JSON.parse(
      await readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
    const templates = release.config.providerConfigRules.templateRules;
    for (const [templateId, modelId, context, output, levels] of [
      ["openai", "gpt-6-astra", 1050000, 128000, ["low", "medium", "high", "xhigh", "max"]],
      ["anthropic", "claude-fable-5-1", 1000000, 128000, ["low", "medium", "high", "xhigh", "max"]],
      ["deepseek", "deepseek-flash", 1000000, 384000, ["disabled", "low", "high", "max"]],
    ] as const) {
      const template = templates.find((t: { templateId: string }) => t.templateId === templateId);
      expect(template.config.builtinModelIds).toContain(modelId);
      const model = rules.resolve({
        templateId,
        providerId: "fixture",
        modelId,
        apiType: template.config.api.type,
        baseUrl: template.config.api.baseUrl,
      });
      expect(model.enabled).toBe(true);
      expect(model.properties?.contextWindow).toBe(context);
      expect(model.properties?.inputFormat?.supportsImage).toBe(true);
      expect(model.optionSpecs?.maxOutputTokens?.max).toBe(output);
      expect(model.optionSpecs?.reasoningLevel?.values).toEqual(levels);
    }
    for (const [modelId, baseUrl, image] of [
      ["deepseek-v4-flash", "https://api.deepseek.com/anthropic", true],
      ["deepseek-v4-flash", "https://proxy.invalid/anthropic", false],
      ["deepseek-v4-pro", "https://api.deepseek.com/anthropic", false],
    ] as const)
      expect(
        rules.resolve({ providerId: "fixture", modelId, baseUrl, apiType: "anthropic-messages" })
          .properties?.inputFormat?.supportsImage,
      ).toBe(image);
  });
});
