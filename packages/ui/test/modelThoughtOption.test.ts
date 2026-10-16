import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";

const registryView: ModelSelectionView = {
  revision: 3,
  providers: [
    {
      providerId: "provider-demo",
      config: {
        kind: "api",
        label: "Provider Demo",
        apiFormat: "anthropic-messages",
        baseURL: "https://example.test",
        apiKey: "secret",
        models: ["reasoning-model", "plain-model"],
      },
      models: [
        {
          modelId: "reasoning-model",
          config: {
            optionSpecs: {
              reasoningLevel: {
                values: ["low", "high", "max"],
              },
              maxOutputTokens: {
                max: 64_000,
              },
            },
          },
        },
        {
          modelId: "plain-model",
          config: {
            optionSpecs: {
              maxOutputTokens: {
                max: 64_000,
              },
            },
          },
        },
      ],
    },
  ],
};

describe("resolveModelThoughtOption", () => {
  it("uses Registry optionSpecs as the authoritative reasoning definition", () => {
    expect(
      resolveModelThoughtOption({
        modelSelectionView: registryView,
        providerId: "provider-demo",
        modelId: "reasoning-model",
      }),
    ).toEqual({
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      // 候选档位来自 Registry，但缺失的用户选择不能被自动补成最高档。
      currentValue: "",
      options: [
        { value: "low", name: "low" },
        { value: "high", name: "high" },
        { value: "max", name: "max" },
      ],
    });
  });

  it.each([
    ["high", "high"],
    ["medium", ""],
  ])("resolves the explicit reasoning %s to %s without picking a replacement", (input, value) => {
    expect(
      resolveModelThoughtOption({
        modelSelectionView: registryView,
        providerId: "provider-demo",
        modelId: "reasoning-model",
        currentValue: input,
      })?.currentValue,
    ).toBe(value);
  });

  it("does not fall back to stale metadata or model-name hardcode when Registry is present", () => {
    expect(
      resolveModelThoughtOption({
        modelSelectionView: registryView,
        providerId: "provider-demo",
        modelId: "GLM-5.2",
      }),
    ).toBeNull();
    expect(
      resolveModelThoughtOption({
        modelSelectionView: registryView,
        providerId: "provider-demo",
        modelId: "plain-model",
      }),
    ).toBeNull();
  });

  it("returns null when the Registry model is missing", () => {
    expect(
      resolveModelThoughtOption({
        modelSelectionView: registryView,
        providerId: "provider-demo",
        modelId: "missing-model",
      }),
    ).toBeNull();
  });
});
