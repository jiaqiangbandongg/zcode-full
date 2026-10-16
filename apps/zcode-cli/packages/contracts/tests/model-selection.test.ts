import { describe, expect, it } from "vitest";
import { parseModelSelectionValue } from "../src/model/index.js";

describe("model selection", () => {
  it("reads the structured persisted selection", () => {
    expect(
      parseModelSelectionValue({
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
  });

  it("does not interpret legacy storage fields in the domain contract", () => {
    expect(
      parseModelSelectionValue({
        providerId: "provider-a",
        modelId: "model-a",
        thoughtLevel: "high",
      }),
    ).toBeUndefined();
  });
});
