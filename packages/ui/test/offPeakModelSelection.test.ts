import { describe, expect, it } from "vitest";
import { buildOffPeakSubmissionModelSelection } from "../src/settings/OffPeakEditView.js";

describe("buildOffPeakSubmissionModelSelection", () => {
  it("persists the displayed reasoning level for every new task Selection", () => {
    expect(
      buildOffPeakSubmissionModelSelection("account:zai-offpeak-idle-plan", "GLM-5.2", "high"),
    ).toEqual({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: "high" },
    });
  });

  it("preserves an explicitly selected value even when it equals the Config default", () => {
    expect(
      buildOffPeakSubmissionModelSelection("account:bigmodel-offpeak-idle-plan", "GLM-5.2", "high"),
    ).toEqual({
      providerId: "account:bigmodel-offpeak-idle-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: "high" },
    });
  });
});
