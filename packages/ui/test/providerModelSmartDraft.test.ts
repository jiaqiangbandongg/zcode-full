import { describe, expect, it } from "vitest";
import { smartDraftModel } from "./providerModelSmartDraftFixture.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import {
  projectModelDraft,
  updateModelDraft,
  modelDraftOverrides,
} from "@/settings/model-provider-section/ProviderModelDraftState.js";

describe("Todo90/92 common model draft", () => {
  it.each([true, false])("隐藏的 MFJS=%s 不参与编辑，已有覆盖在智能模式保持", (value) => {
    const model = smartDraftModel();
    model.personalConfig.properties = { requiresMfjsToolSchema: value };
    const draft = updateModelDraft(
      createProviderModelDraftValues(model),
      { contextWindowValue: "123456" },
      model,
    );
    const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") throw new Error("expected commit");
    expect(result.model.personalConfig).not.toHaveProperty("requiresMfjsToolSchema");
    expect(result.model.personalConfig.properties?.requiresMfjsToolSchema).toBe(value);
    const reopened = createProviderModelDraftValues(result.model);
    expect(reopened).not.toHaveProperty("requiresMfjsToolSchemaValue");
    expect(reopened.overriddenFieldsValue).not.toContain("requiresMfjsToolSchemaValue");
  });

  it("智能配置未改MFJS不物化false，已有null保持清除意图", () => {
    for (const properties of [undefined, { requiresMfjsToolSchema: null }]) {
      for (const effectiveValue of [undefined, null, false]) {
        const model = smartDraftModel();
        model.personalConfig = { enabled: false, properties };
        model.config.properties!.requiresMfjsToolSchema = effectiveValue;
        const result = resolveProviderModelDraftCommit({
          currentModel: model,
          draft: createProviderModelDraftValues(model),
        });
        expect(result.status).toBe("commit");
        if (result.status !== "commit") throw new Error("expected commit");
        expect(result.model.personalConfig.properties?.requiresMfjsToolSchema).toBe(
          properties?.requiresMfjsToolSchema,
        );
        expect(result.model.personalConfig.enabled).toBe(false);
      }
    }
  });
  it("preserves explicit equal-value intent across ID changes, projects only untouched values", () => {
    const model = smartDraftModel();
    let draft = createProviderModelDraftValues(model);
    draft = updateModelDraft(
      draft,
      { contextWindowValue: "100000", maxOutputTokensValue: "32000" },
      model,
    );
    draft = updateModelDraft(
      draft,
      { inputFormatValue: { ...draft.inputFormatValue, supportsPdf: true } },
      model,
    );
    const config = structuredClone(model.config);
    config.properties!.contextWindow = 200000;
    config.properties!.inputFormat!.supportsImage = false;
    config.optionSpecs!.reasoningLevel!.values = ["off", "max"];
    const next = { ...model, modelId: "b", config, inheritedConfig: config };
    draft = projectModelDraft({ ...draft, idValue: "b" }, next);
    expect(draft.contextWindowValue).toBe("100000");
    expect(draft.inputFormatValue.supportsImage).toBe(false);
    expect(draft.inputFormatValue.supportsPdf).toBe(true);
    expect(draft.reasoningLevelValuesValue).toEqual(["off", "max"]);
    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: { ...draft, idValue: "a" },
    });
    expect(result.status).toBe("commit");
    if (result.status === "commit") {
      expect(result.model.personalConfig.properties?.contextWindow).toBe(100000);
      expect(result.model.personalConfig.optionSpecs?.maxOutputTokens?.max).toBe(32000);
      expect(result.model.personalConfig.properties?.inputFormat?.supportsPdf).toBe(true);
    }
  });

  it("freezes editable facts when switching off; rejects each blank required input", () => {
    const model = smartDraftModel();
    const draft = updateModelDraft(
      createProviderModelDraftValues(model),
      { useRecommendedConfigValue: false },
      model,
    );
    expect(draft.contextWindowValue).toBe("100000");
    expect(draft.inputFormatValue.supportsAudio).toBe(true);
    expect(modelDraftOverrides(draft).size).toBe(0);
    for (const field of [
      "contextWindowValue",
      "maxOutputTokensValue",
      "reasoningLevelMapValue",
    ] as const) {
      expect(
        resolveProviderModelDraftCommit({ currentModel: model, draft: { ...draft, [field]: "" } })
          .status,
      ).toBe("invalid");
    }
    const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
    expect(result.status).toBe("commit");
    if (result.status === "commit") {
      expect(result.model.personalConfig.enabled).toBe(false);
      expect(result.model.personalConfig.properties).not.toHaveProperty("requiresMfjsToolSchema");
      expect(result.model.personalConfig.optionSpecs?.reasoningLevel?.map).toBe("{}");
    }
  });

  it("clears old overrides on re-enable, preserves subsequent edits and enabled", () => {
    const model = smartDraftModel();
    model.personalConfig = {
      enabled: false,
      optionSpecs: { maxOutputTokens: { map: "{'old_limit': maxOutputTokens}" } },
    };
    let draft = updateModelDraft(
      createProviderModelDraftValues(model),
      { useRecommendedConfigValue: false },
      model,
    );
    draft = updateModelDraft(draft, { contextWindowValue: "444444" }, model);
    draft = updateModelDraft(draft, { useRecommendedConfigValue: true }, model);
    expect(draft.contextWindowValue).toBe("");
    draft = updateModelDraft(draft, { maxOutputTokensValue: "12345" }, model);
    draft = projectModelDraft(draft, model);
    expect(draft).not.toHaveProperty("maxOutputTokensMapValue");
    const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
    expect(result.status).toBe("commit");
    if (result.status === "commit") {
      expect(result.model.personalConfig.properties?.contextWindow).toBeUndefined();
      expect(result.model.personalConfig.optionSpecs?.maxOutputTokens?.max).toBe(12345);
      expect(result.model.personalConfig.enabled).toBe(false);
      expect(result.model.personalConfig.optionSpecs?.maxOutputTokens?.map).toBe(
        "{'old_limit': maxOutputTokens}",
      );
    }
  });

  it("keeps independent override feedback while another field is invalid", () => {
    const model = smartDraftModel();
    let draft = updateModelDraft(
      createProviderModelDraftValues(model),
      { reasoningLevelValuesValue: ["low", "max"] },
      model,
    );
    draft = updateModelDraft(
      draft,
      { contextWindowValue: "not a number", reasoningLevelMapValue: "bad syntax (" },
      model,
    );
    const flags = modelDraftOverrides(draft);
    expect(flags.has("reasoningLevelValuesValue")).toBe(true);
    expect(flags.has("reasoningLevelMapValue")).toBe(true);
    expect(flags.has("contextWindowValue")).toBe(true);
    expect(flags.has("supportsJsonSchemaOutputValue")).toBe(false);
  });
});
