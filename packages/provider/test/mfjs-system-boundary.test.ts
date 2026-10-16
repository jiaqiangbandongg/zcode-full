import { describe, expect, it } from "vitest";
import {
  extractManualModelConfig,
  clearManualModelConfig,
  ModelConfigRules,
  parsePersonalModelConfigRules,
  parseZCodeBuiltinModelConfigRules,
} from "../src/index.js";
import { manualModelConfigSchema } from "../src/config/rule-data-schema.js";

const editable = {
  properties: {
    contextWindow: 1000,
    inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: { reasoningLevel: { values: ["high"], map: "{}" }, maxOutputTokens: { max: 128 } },
};
describe("Todo134 system fields never become manual editor requirements", () => {
  it("accepts only editable fields and rejects MFJS/output format", () => {
    expect(manualModelConfigSchema.safeParse(editable).success).toBe(true);
    for (const hidden of [
      { requiresMfjsToolSchema: false },
      { outputFormat: { supportsText: true } },
    ]) {
      expect(
        manualModelConfigSchema.safeParse({
          ...editable,
          properties: { ...editable.properties, ...hidden },
        }).success,
      ).toBe(false);
      expect(
        extractManualModelConfig({
          ...editable,
          properties: { ...editable.properties, ...hidden },
        }),
      ).toEqual(editable);
    }
    expect(
      clearManualModelConfig({
        ...editable,
        properties: {
          ...editable.properties,
          requiresMfjsToolSchema: true,
          outputFormat: { supportsText: true },
        },
      }),
    ).toEqual({
      properties: { requiresMfjsToolSchema: true, outputFormat: { supportsText: true } },
    });
  });
  it("manual configuration follows system MFJS without freezing it", () => {
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [],
      manualProviderModelRules: [{ providerId: "p", modelId: "m", config: editable }],
    });
    for (const requiresMfjsToolSchema of [true, false]) {
      const builtin = parseZCodeBuiltinModelConfigRules({
        modelRules: [
          {
            modelMatch: ".*",
            config: {
              properties: { requiresMfjsToolSchema, outputFormat: { supportsText: true } },
            },
          },
        ],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      });
      const resolved = ModelConfigRules.composeEffective(builtin, personal).resolve({
        providerId: "p",
        modelId: "m",
        apiType: "anthropic-messages",
      });
      expect(resolved.properties?.requiresMfjsToolSchema).toBe(requiresMfjsToolSchema);
      expect(resolved.properties?.contextWindow).toBe(1000);
    }
  });
});
