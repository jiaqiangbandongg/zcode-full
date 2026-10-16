import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/provider";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
const view = {
  revision: 1,
  providers: [
    {
      providerId: "account:bigmodel-team-coding-plan",
      config: {},
      models: [
        { modelId: "glm-5", config: { optionSpecs: { reasoningLevel: { values: ["high"] } } } },
      ],
    },
  ],
} as unknown as ModelSelectionView;
const config: SessionConfigState = {
  provider: "account:bigmodel-team-coding-plan",
  model: "glm-5",
  thought: "high",
  thoughtLevels: ["high"],
  mode: "build",
  followupMode: "queue",
  modelSelection: { providerId: "account:bigmodel-individual-coding-plan", modelId: "glm-5" },
};
describe("副屏推荐模型来源", () => {
  it("使用父 runtime 的生效投影与思考，不用旧套餐 ID 或主输入草稿", () => {
    expect(resolveSelectionSideInheritedModel(config, view)).toEqual({
      providerId: config.provider,
      modelId: config.model,
      options: { reasoningLevel: "high" },
    });
    expect(config.modelSelection?.providerId).toBe("account:bigmodel-individual-coding-plan");
  });
  it("缺目录、模型或有效思考时跳过推荐，不伪造默认选择", () => {
    expect(resolveSelectionSideInheritedModel(config, null)).toBeNull();
    expect(resolveSelectionSideInheritedModel({ ...config, thought: "invalid" }, view)).toBeNull();
    expect(resolveSelectionSideInheritedModel(null, view)).toBeNull();
  });
});
