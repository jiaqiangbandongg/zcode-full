import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

const view = {
  revision: 1,
  providers: [
    {
      providerId: "provider-a",
      config: {},
      models: [
        {
          modelId: "model-a",
          config: {
            optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } },
          },
        },
      ],
    },
  ],
  preferredSelection: {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "high" },
  },
} as ModelSelectionView;

describe("createComposerSubmissionConfig", () => {
  it("没有 Composer 草稿时返回空配置而不抛错", () => {
    expect(createComposerSubmissionConfig(undefined, null)).toBeNull();
  });
  it("只从 Composer 复制配置，随后编辑不能改变已提交值", () => {
    const draft = {
      mode: "yolo",
      planEnabled: true,
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      },
    };
    const submission = createComposerSubmissionConfig(draft, view);
    draft.mode = "yolo";
    draft.planEnabled = false;
    draft.modelSelection.options.reasoningLevel = "high";
    expect(submission).toEqual({
      mode: "yolo",
      planEnabled: true,
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      },
    });
    expect(Object.isFrozen(submission?.modelSelection.options)).toBe(true);
  });

  it("空选择、空档位和失效档位不创建 Submission，也不使用 preferred", () => {
    for (const modelSelection of [
      undefined,
      { providerId: "provider-a", modelId: "model-a" },
      { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "removed" } },
      { providerId: "removed", modelId: "model-a", options: { reasoningLevel: "high" } },
    ]) {
      expect(createComposerSubmissionConfig({ mode: "build", modelSelection }, view)).toBeNull();
    }
  });

  it("旧平铺展示字段不能补全当前 Selection", () => {
    const draft = { mode: "build", provider: "provider-a", model: "model-a", thought: "high" };
    expect(createComposerSubmissionConfig(draft, view)).toBeNull();
  });

  it("没有 Ready View 或合法模式时不提交", () => {
    const draft = { mode: "build", modelSelection: view.preferredSelection! };
    expect(createComposerSubmissionConfig(draft, null)).toBeNull();
    expect(createComposerSubmissionConfig({ ...draft, mode: "removed" }, view)).toBeNull();
  });
});
