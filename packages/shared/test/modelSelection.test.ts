import { describe, expect, it } from "vitest";
import {
  formatModelPickerValue,
  modelSelectionSchema,
  parseModelPickerValue,
} from "../src/model-selection.js";

describe("ModelSelection value", () => {
  it("projects provider, slash-containing model and reasoning into a picker value", () => {
    const selection = {
      providerId: "openrouter",
      modelId: "vendor/model:free",
      options: { reasoningLevel: "high" },
    };
    expect(parseModelPickerValue(formatModelPickerValue(selection))).toEqual(selection);
  });

  it("rejects request-only maxOutputTokens in a selection", () => {
    expect(
      modelSelectionSchema.safeParse({
        providerId: "openrouter",
        modelId: "vendor/model:free",
        options: { maxOutputTokens: 16_384, reasoningLevel: "high" },
      }).success,
    ).toBe(false);
  });

  it("rejects values without an explicit provider", () => {
    expect(() => parseModelPickerValue("model-only")).toThrow("模型选择缺少 Provider");
  });
});
