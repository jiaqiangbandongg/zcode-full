import { describe, expect, it } from "vitest";
import { applyComposerPlanTransition } from "@/v4/composer/composerPlanTransition.js";

describe("Plan 工具定向同步", () => {
  it("批准只关闭 Plan，权限、正文和模型不变；回放不重复应用", () => {
    const draft = { text: "next", mode: "yolo" as const, planEnabled: true, updatedAt: 0 };
    const next = applyComposerPlanTransition(draft, { toolCallId: "approve", planEnabled: false });
    expect(next).toMatchObject({ text: "next", mode: "yolo", planEnabled: false });
    expect(applyComposerPlanTransition(next, { toolCallId: "approve", planEnabled: false })).toBe(
      next,
    );
  });
  it.each([true, false])("新工具结果按 %s 设置标记，不保护期间的手动改选", (planEnabled) => {
    // 包含未上线初版留下的额外字段，不能再改变最新裁决的结果。
    const draft = {
      text: "下一条消息",
      mode: "yolo" as const,
      modelSelection: { providerId: "p", modelId: "m" },
      planEnabled: !planEnabled,
      ignoredPlanToolCallIds: ["transition"],
      updatedAt: 0,
    };
    expect(
      applyComposerPlanTransition(draft, { toolCallId: "transition", planEnabled }),
    ).toMatchObject({ ...draft, planEnabled, lastPlanTransitionId: "transition" });
  });
  it("批准已应用后，用户重新开启 Plan，相同结果的重复快照不再清除", () => {
    const transition = { toolCallId: "approve", planEnabled: false };
    const approved = applyComposerPlanTransition(
      { text: "", planEnabled: true, updatedAt: 0 },
      transition,
    );
    const edited = { ...approved, planEnabled: true };
    expect(applyComposerPlanTransition(edited, transition)).toBe(edited);
  });
  it("没有工具转换时，普通快照、拒绝和反馈不修改草稿", () => {
    const draft = { text: "", planEnabled: true, updatedAt: 0 };
    expect(applyComposerPlanTransition(draft, undefined)).toBe(draft);
  });
});
