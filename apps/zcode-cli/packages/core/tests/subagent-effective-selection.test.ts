import { describe, expect, it, vi } from "vitest";
import { resolveSubagentSelection } from "../src/runtime/helpers/subagent-selection.js";
import { projectExecutionErrorPayload } from "../src/errors/error-payload.js";
import { createErrorResult } from "../src/tool/executor/errors.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import { modelContentForToolResult } from "../src/runtime/helpers/tool-result.js";

describe("显式 Subagent 选择使用注入的公共解析", () => {
  const original = Object.freeze({
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3",
    options: Object.freeze({ reasoningLevel: "high" }),
  });
  const effective = { ...original, providerId: "account:bigmodel-team-coding-plan" };

  it.each([
    "selection-missing",
    "account-connection-unavailable",
    "provider-not-found",
    "model-not-found",
    "reasoning-level-missing",
    "reasoning-level-not-supported",
  ] as const)("真实错误投影与工具结果保留原因 %s", (reason) => {
    let caught: Error | undefined;
    try {
      resolveSubagentSelection({
        profileSelection: original,
        resolveSelection: () => ({ effectiveSelection: effective, selectionIssue: reason }),
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    const projected = projectExecutionErrorPayload(caught);
    expect(projected.attribution).toMatchObject({
      reason,
      providerId: effective.providerId,
      modelId: effective.modelId,
    });
    expect(projected.detail).toContain(`reason=${reason}`);
    expect(projected.message).toContain(reason);
    expect(projected.message).toContain(original.providerId);
    expect(projected.message).toMatch(/[\u4e00-\u9fff]/);
    const result = createErrorResult(
      { id: "tool-selection", name: "Agent", input: {} } as Parameters<typeof createErrorResult>[0],
      caught!,
    );
    expect(result.error?.message).toBe(projected.message);
    expect(result.error?.detail).toContain(reason);
    expect(modelContentForToolResult(result)).toContain(reason);
    expect(result.success).toBe(false);
  });

  it("没有有效身份时只描述原选择，不冒充已重映射执行身份", () => {
    let caught: unknown;
    try {
      resolveSubagentSelection({
        profileSelection: original,
        resolveSelection: (): EffectiveModelSelectionResult => ({
          effectiveSelection: null,
          selectionIssue: "account-connection-unavailable",
        }),
      });
    } catch (error) {
      caught = error;
    }
    const projected = projectExecutionErrorPayload(caught);
    expect(projected.message).toContain(original.providerId);
    expect(projected.attribution).not.toHaveProperty("providerId");
    expect(projected.message).not.toContain("apiKey");
  });

  it("只解析本次显式意图，保留原 profile", () => {
    const resolveSelection = vi.fn(() => ({ effectiveSelection: effective }));
    expect(resolveSubagentSelection({ profileSelection: original, resolveSelection })).toEqual({
      selection: effective,
      hasConcreteModel: true,
    });
    expect(resolveSelection).toHaveBeenCalledWith(original);
    expect(original.providerId).toBe("account:bigmodel-individual-coding-plan");
  });

  it("无有效同模型时阻断，不能回退父模型", () => {
    expect(() =>
      resolveSubagentSelection({
        profileSelection: original,
        parentSelection: effective,
        resolveSelection: () => ({ effectiveSelection: null, selectionIssue: "model-not-found" }),
      }),
    ).toThrow();
  });

  it("继承和已明确的内部 override 不重解析", () => {
    const resolveSelection = vi.fn(() => ({ effectiveSelection: null }));
    expect(
      resolveSubagentSelection({ parentSelection: original, resolveSelection }).selection,
    ).toEqual(original);
    expect(
      resolveSubagentSelection({
        profileSelection: original,
        overrideSelection: effective,
        resolveSelection,
      }).selection,
    ).toEqual(effective);
    expect(resolveSelection).not.toHaveBeenCalled();
  });

  it("未注入服务的独立 CLI 保持原行为", () => {
    expect(resolveSubagentSelection({ profileSelection: original }).selection).toEqual(original);
  });

  it("公共解析返回缺档位的部分结果时保留原因并阻断执行", () => {
    expect(() =>
      resolveSubagentSelection({
        profileSelection: original,
        resolveSelection: () => ({
          effectiveSelection: { providerId: effective.providerId, modelId: effective.modelId },
          selectionIssue: "reasoning-level-not-supported",
        }),
      }),
    ).toThrow(
      expect.objectContaining({
        context: expect.objectContaining({ selectionIssue: "reasoning-level-not-supported" }),
      }),
    );
  });
});
