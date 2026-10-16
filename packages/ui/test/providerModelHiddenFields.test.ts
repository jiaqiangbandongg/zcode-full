import { describe, expect, it } from "vitest";
import { smartDraftModel } from "./providerModelSmartDraftFixture.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { updateModelDraft } from "@/settings/model-provider-section/ProviderModelDraftState.js";

describe("Todo134 hidden model fields", () => {
  it("has no output or MFJS draft; manual submission excludes both", () => {
    const model = smartDraftModel();
    const draft = createProviderModelDraftValues(model);
    expect(draft).not.toHaveProperty("outputFormatValue");
    expect(draft).not.toHaveProperty("requiresMfjsToolSchemaValue");
    const manual = updateModelDraft(draft, { useRecommendedConfigValue: false }, model);
    const result = resolveProviderModelDraftCommit({ currentModel: model, draft: manual });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") throw new Error(result.field);
    expect(result.model.personalConfig.properties).not.toHaveProperty("outputFormat");
    expect(result.model.personalConfig.properties).not.toHaveProperty("requiresMfjsToolSchema");
  });
  it("unrelated smart edits preserve existing system overrides", () => {
    const model = smartDraftModel();
    model.personalConfig = {
      properties: { requiresMfjsToolSchema: true, outputFormat: { supportsText: true } },
    };
    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: { ...createProviderModelDraftValues(model), contextWindowValue: "9999" },
    });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") throw new Error(result.field);
    expect(result.model.personalConfig.properties).toMatchObject({
      requiresMfjsToolSchema: true,
      outputFormat: { supportsText: true },
      contextWindow: 9999,
    });
  });
});
