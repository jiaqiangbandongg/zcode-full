import { describe, expect, it } from "vitest";
import { importLegacyCliPersonalProviderConfig } from "../src/app/legacy-cli-personal-provider-config-importer.js";

function importModels(models: Record<string, unknown>) {
  return importLegacyCliPersonalProviderConfig({
    input: { provider: { custom: { kind: "anthropic", models } } },
  });
}

describe("CLI 首次导入输出上限", () => {
  it.each([
    { model: { limit: { output: 64_000 } }, expected: 64_000 },
    { model: { options: { max_tokens: 48_000 } }, expected: 48_000 },
    { model: { maxOutputTokens: 16_000 }, expected: 16_000 },
    {
      model: {
        limit: { output: 64_000 },
        options: { max_tokens: 48_000 },
        maxOutputTokens: 16_000,
      },
      expected: 64_000,
    },
    { model: { options: { max_tokens: 48_000 }, maxOutputTokens: 16_000 }, expected: 48_000 },
    { model: { limit: { output: 1.5 }, maxOutputTokens: 16_000 }, expected: 16_000 },
  ])("将 $model 迁为稀疏输出规则", ({ model, expected }) => {
    const before = structuredClone(model);
    const imported = importModels({ evaluation: model });
    expect(imported.models.getExact("custom", "evaluation")?.toJSON()).toEqual({
      optionSpecs: { maxOutputTokens: { max: expected } },
    });
    expect(model).toEqual(before);
  });

  it.each([undefined, null, 0, -1, 1.5, "24000", Number.NaN, Number.POSITIVE_INFINITY])(
    "非法 options.max_tokens %s 不进入配置，仍可使用合法顶层值",
    (maxTokens) => {
      const imported = importModels({
        missing: { options: { max_tokens: maxTokens } },
        fallback: { options: { max_tokens: maxTokens }, maxOutputTokens: 16_000 },
      });
      expect(imported.models.getExact("custom", "missing")).toBeUndefined();
      expect(
        imported.models.getExact("custom", "fallback")?.optionSpecs?.maxOutputTokens?.max,
      ).toBe(16_000);
    },
  );

  it.each([0, -1, "24000", Number.NaN, Number.POSITIVE_INFINITY])(
    "保持 parser 对非法显式字段 %s 的拒绝边界",
    (value) => {
      expect(() => importModels({ model: { maxOutputTokens: value } })).toThrow();
      expect(() => importModels({ model: { limit: { output: value } } })).toThrow();
    },
  );

  it("输出缺省不写默认值，context 单独保留，小数不成为输出规则", () => {
    const imported = importModels({
      context: { contextWindow: 128_000 },
      empty: {},
      fractional: { maxOutputTokens: 1.5 },
    });
    expect(imported.models.toPersonalJSON().providerModelRules).toEqual([
      {
        providerId: "custom",
        modelId: "context",
        config: { properties: { contextWindow: 128_000 } },
      },
    ]);
  });

  it("删除与重复成员不复活，使用 trim 后的真实 model id", () => {
    const imported = importModels({
      removed: { id: " shared ", deleted: true, maxOutputTokens: 1_000 },
      first: { id: " shared ", maxOutputTokens: 24_000 },
      duplicate: { id: "shared", maxOutputTokens: 48_000 },
      blank: { id: " ", maxOutputTokens: 8_000 },
    });
    expect(imported.providers.get("custom")?.personalModelIds).toEqual(["shared"]);
    expect(imported.models.toPersonalJSON().providerModelRules).toEqual([
      {
        providerId: "custom",
        modelId: "shared",
        config: { optionSpecs: { maxOutputTokens: { max: 24_000 } } },
      },
    ]);
  });
});
