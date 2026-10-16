import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/provider";
import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { resolveStartPlanRecommendation } from "@/lib/startPlanRecommendation.js";

const selection = {
  providerId: "account:bigmodel-individual-coding-plan",
  modelId: "glm-5",
  options: { reasoningLevel: "high" },
};
const view = {
  revision: 1,
  providers: [
    {
      providerId: "account:bigmodel-start-plan",
      config: {},
      models: [
        { modelId: "glm-5", config: { optionSpecs: { reasoningLevel: { values: ["high"] } } } },
      ],
    },
  ],
} as unknown as ModelSelectionView;
function snapshot(remaining: number | undefined = 10): UsageEntitlementSnapshot {
  return {
    provider: { id: "account:bigmodel-start-plan" },
    generatedAt: 100,
    quota: {
      limits: [
        {
          remaining,
          number: 100,
          periodStart: 0,
          periodEnd: 200,
          usageDetails: [{ modelCode: "GLM-5" }],
        },
      ],
    },
  } as UsageEntitlementSnapshot;
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(100));
afterEach(() => vi.restoreAllMocks());
describe("提交前 Start 同模型推荐", () => {
  it("采集超过一分钟不推荐，桶按采集后经过的时间过期", () => {
    const quota = snapshot();
    vi.mocked(Date.now).mockReturnValue(201);
    expect(resolveStartPlanRecommendation(selection, view, quota)).toBeNull();
    quota.quota!.limits[0]!.periodEnd = 1000000;
    vi.mocked(Date.now).mockReturnValue(60101);
    expect(resolveStartPlanRecommendation(selection, view, quota)).toBeNull();
  });
  it("只改变 Provider，保留同模型与思考配置", () => {
    expect(resolveStartPlanRecommendation(selection, view, snapshot())).toEqual({
      ...selection,
      providerId: "account:bigmodel-start-plan",
    });
    expect(selection.providerId).toBe("account:bigmodel-individual-coding-plan");
  });
  it.each(["account:bigmodel-start-plan", "account:bigmodel-offpeak-idle-plan", "personal-api"])(
    "不推荐 %s",
    (providerId) => {
      expect(
        resolveStartPlanRecommendation({ ...selection, providerId }, view, snapshot()),
      ).toBeNull();
    },
  );
  it("拒绝其他型号、品牌、无效思考及不可执行 Start", () => {
    for (const original of [
      { ...selection, modelId: "glm-5.1" },
      { ...selection, providerId: "account:zai-individual-coding-plan" },
      { ...selection, options: { reasoningLevel: "low" } },
      { ...selection, options: undefined },
    ]) {
      expect(resolveStartPlanRecommendation(original, view, snapshot())).toBeNull();
    }
    expect(
      resolveStartPlanRecommendation(selection, { revision: 2, providers: [] }, snapshot()),
    ).toBeNull();
  });
  it("未知、耗尽、过期或其他模型额度不能触发推荐", () => {
    const unknown = snapshot();
    delete unknown.quota!.limits[0]!.remaining;
    const expired = snapshot();
    expired.quota!.limits[0]!.periodEnd = 99;
    const other = snapshot();
    other.quota!.limits[0]!.usageDetails = [{ modelCode: "glm-4" }];
    for (const quota of [null, snapshot(0), unknown, expired, other]) {
      expect(resolveStartPlanRecommendation(selection, view, quota)).toBeNull();
    }
  });
  it("同模型多个桶只要一个有明确余额就可推荐，未知桶不算余额", () => {
    const quota = snapshot(0);
    quota.quota!.limits.push(...snapshot(5).quota!.limits);
    expect(resolveStartPlanRecommendation(selection, view, quota)).not.toBeNull();
  });
});
