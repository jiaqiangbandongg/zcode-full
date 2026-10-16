import { describe, expect, it } from "vitest";
import {
  ModelRetryBudget,
  modelNetworkStatusEventJsonSchema,
  type ModelTextRequest,
} from "../src/model/index.js";
import {
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
} from "../src/model/invocation-context.js";

// docs/dynamic-workflow/concurrency.md「Unbounded retries for workflow traffic」：重试预算档位是 runtime-only 字段；
// 状态事件用 maxAttempts = 0 表示无上限，协议 schema 的下界因此是 0。
describe("ModelRetryBudget", () => {
  it("exposes the two budget tiers", () => {
    expect(ModelRetryBudget).toEqual({ Default: "default", Unbounded: "unbounded" });
  });

  it("is a runtime-only request field and stays out of the model request JSON schema", async () => {
    const request: ModelTextRequest = {
      model: "test/model",
      messages: [],
      modelRetryBudget: ModelRetryBudget.Unbounded,
    };
    expect(request.modelRetryBudget).toBe("unbounded");
    const { modelTextRequestJsonSchema } = await import("../src/model/index.js");
    const properties = (modelTextRequestJsonSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties).not.toHaveProperty("modelRetryBudget");
    expect(properties).not.toHaveProperty("modelRequestSessionType");
  });

  it("allows maxAttempts = 0 (unbounded marker) in the network status schema", () => {
    const properties = (
      modelNetworkStatusEventJsonSchema as { properties: Record<string, { minimum?: number }> }
    ).properties;
    expect(properties.maxAttempts?.minimum).toBe(0);
    // attempt 仍从 1 起：只有预算总数才有「无上限」这个哨兵。
    expect(properties.attempt?.minimum).toBe(1);
  });

  it("travels with the model invocation context", () => {
    const seen = runWithModelInvocationContext(
      { modelRetryBudget: ModelRetryBudget.Unbounded },
      () => getCurrentModelInvocationContext()?.modelRetryBudget,
    );
    expect(seen).toBe("unbounded");
    expect(getCurrentModelInvocationContext()).toBeUndefined();
  });
});
