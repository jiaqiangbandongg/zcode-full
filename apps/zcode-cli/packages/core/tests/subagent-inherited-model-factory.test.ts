import { describe, expect, it, vi } from "vitest";
import type { Model } from "@zcode/contracts";
import {
  createInheritedSubagentModelFactory,
  modelSelectionFromActiveModel,
} from "../src/runtime/methods/subagent.js";

function createModel(reasoningLevel: string, maxOutputTokens: number): Model {
  return {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel, maxOutputTokens },
  } as Model;
}

describe("createInheritedSubagentModelFactory", () => {
  it("从实际继承的 Active Model 派生 child Selection", () => {
    const inherited = createModel("high", 8_000);

    expect(modelSelectionFromActiveModel(inherited)).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
  });

  it("以父 Submission 的稀疏 Selection 复用已冻结的父 Model", () => {
    const inherited = createModel("high", 8_000);
    const rebound = createModel("low", 4_000);
    const fallback = vi.fn(() => rebound);
    const inheritedSelection = { providerId: "provider-a", modelId: "model-a" } as const;
    const factory = createInheritedSubagentModelFactory(inheritedSelection, inherited, fallback);

    expect(
      factory({
        selection: {
          providerId: "provider-a",
          modelId: "model-a",
        },
      }),
    ).toBe(inherited);

    expect(
      factory({
        selection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: { reasoningLevel: "low" },
        },
      }),
    ).toBe(rebound);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
