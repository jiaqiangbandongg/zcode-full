import { describe, expect, it } from "vitest";
import { shouldApplyModelStateUpdateForTaskModel } from "../src/lib/modelStateUpdateGuard.js";

describe("shouldApplyModelStateUpdateForTaskModel", () => {
  it("rejects session initialization updates for a different task model identity", () => {
    expect(
      shouldApplyModelStateUpdateForTaskModel({
        currentModelValue: "custom:default-deepseek:deepseek-v4-flash",
        incomingModelValue: "runtime-provider/deepseek-chat",
        reason: "session_initialized",
      }),
    ).toBe(false);
  });

  it("accepts equivalent custom and provider-qualified model identities", () => {
    expect(
      shouldApplyModelStateUpdateForTaskModel({
        currentModelValue: "custom:runtime-provider:deepseek-v4-flash",
        incomingModelValue: "runtime-provider/deepseek-v4-flash",
        reason: "session_initialized",
      }),
    ).toBe(true);
  });

  it("keeps explicit model changed events usable even when the current value is stale", () => {
    expect(
      shouldApplyModelStateUpdateForTaskModel({
        currentModelValue: "old-provider/old-model",
        incomingModelValue: "new-provider/new-model",
        reason: "model_changed",
      }),
    ).toBe(true);
  });

  it("treats an OpenRouter colon suffix as model identity instead of variant", () => {
    expect(
      shouldApplyModelStateUpdateForTaskModel({
        currentModelValue: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
        incomingModelValue: "openrouter/nvidia/nemotron-3-ultra-550b-a55b",
        reason: "session_initialized",
      }),
    ).toBe(false);
  });

  it("ignores only the reserved dollar variant when comparing model identity", () => {
    expect(
      shouldApplyModelStateUpdateForTaskModel({
        currentModelValue: "custom-openai/agent-model$fast",
        incomingModelValue: "custom-openai/agent-model$slow",
        reason: "session_initialized",
      }),
    ).toBe(true);
  });
});
