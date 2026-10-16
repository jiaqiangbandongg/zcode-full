import { describe, expect, it } from "vitest";
import { resolveHighspeedPrepareSelection } from "../src/highspeed/highspeedSend.js";

describe("resolveHighspeedPrepareSelection", () => {
  it("prefers the submission selection so a freshly switched model drives admission", async () => {
    // 回归：切换模型后首次发送曾读会话投影的旧 Coding Plan 组合发起 draw，
    // 抽中后把用户的提交选择覆盖成卡模型（spec §3 规则 15）。
    const resolved = resolveHighspeedPrepareSelection({
      submissionSelection: {
        providerId: "2b05e183-7ae4-46d6-aedb-4c8f750d9811",
        modelId: "glm-5.3-flash-cc-highspeed",
        options: { reasoningLevel: "high" },
      },
      projectedConfig: { provider: "account:bigmodel-team-coding-plan", model: "GLM-5.3" },
      draftConfig: { provider: "account:bigmodel-team-coding-plan", model: "GLM-5.3" },
    });

    expect(resolved).toEqual({
      provider: "2b05e183-7ae4-46d6-aedb-4c8f750d9811",
      model: "glm-5.3-flash-cc-highspeed",
      reasoningLevel: "high",
    });
  });

  it("falls back per-field to projection, draft, then initial draft without a submission", () => {
    const resolved = resolveHighspeedPrepareSelection({
      projectedConfig: { model: "GLM-5.3", thought: "" },
      draftConfig: { provider: "account:bigmodel-team-coding-plan" },
      initialDraftConfig: { provider: "account:zai-team-coding-plan", model: "GLM-5.2" },
    });

    expect(resolved).toEqual({
      provider: "account:bigmodel-team-coding-plan",
      model: "GLM-5.3",
    });
  });

  it("resolves reasoningLevel from the submission options first, then legacy sources", () => {
    const fromSubmission = resolveHighspeedPrepareSelection({
      submissionSelection: {
        providerId: "account:bigmodel-team-coding-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "medium" },
      },
      projectedConfig: { provider: "account:bigmodel-team-coding-plan", model: "GLM-5.3", thought: "high" },
    });
    expect(fromSubmission).toEqual({
      provider: "account:bigmodel-team-coding-plan",
      model: "GLM-5.3",
      reasoningLevel: "medium",
    });

    const fromProjectionThought = resolveHighspeedPrepareSelection({
      projectedConfig: {
        provider: "account:bigmodel-team-coding-plan",
        model: "GLM-5.3",
        thought: "high",
      },
      draftConfig: {
        provider: "account:bigmodel-team-coding-plan",
        model: "GLM-5.3",
        modelSelection: { providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3", options: { reasoningLevel: "low" } },
      },
    });
    expect(fromProjectionThought?.reasoningLevel).toBe("high");
  });

  it("returns null when neither submission nor fallbacks yield a provider and model", () => {
    expect(
      resolveHighspeedPrepareSelection({ draftConfig: { provider: "account:bigmodel-team-coding-plan" } }),
    ).toBeNull();
    expect(resolveHighspeedPrepareSelection({})).toBeNull();
  });
});
