import { describe, expect, it } from "vitest";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import { stringifyToolResultOutput } from "../src/runtime/helpers/tool-result.js";
import { createTurnFailureError } from "../src/runtime/helpers/turn-errors.js";
import { ErrorPayloadRole, withErrorPayloadRole } from "../src/errors/error-payload.js";
import { createErrorResult, createPermissionErrorResult } from "../src/tool/executor/errors.js";
import type { ExecutableToolCall } from "../src/tool/types.js";

const USER_DENIAL_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

describe("tool executor error projection", () => {
  it("keeps user-denial content provider-visible", () => {
    const result = createPermissionErrorResult(agentToolCall(), USER_DENIAL_CONTENT, {});

    expect(stringifyToolResultOutput(result)).toBe(USER_DENIAL_CONTENT);
  });

  it("keeps denial feedback in the same provider-visible tool_result", () => {
    const reason = `${USER_DENIAL_CONTENT} To tell you how to proceed, the user said:\nPlease use the existing file instead.`;
    const result = createPermissionErrorResult(
      agentToolCall(),
      reason,
      {},
      {
        preserveReasonFormatting: true,
      },
    );

    expect(stringifyToolResultOutput(result)).toBe(reason);
  });

  it("sanitizes denial feedback unless preservation is explicitly requested", () => {
    const reason = `${USER_DENIAL_CONTENT}\nTo tell you how to proceed, the user said:\n${"x".repeat(600)}`;
    const result = createPermissionErrorResult(agentToolCall(), reason, {});

    expect(result.error?.message).toHaveLength(500);
    expect(result.error?.message).not.toContain("\n");
    expect(result.error?.message).toMatch(/\.\.\.$/);
  });

  it("surfaces provider/model cause details for failed parent Agent tool calls", () => {
    const providerError = Object.assign(
      new Error("Model provider is not configured: old-provider"),
      {
        code: "provider_not_found",
        context: {
          providerId: "old-provider",
          modelId: "old-model",
        },
        name: "AiSdkModelAdapterError",
      },
    );
    const turnError = createTurnFailureError(providerError, undefined, "Turn execution failed");

    const result = createErrorResult(agentToolCall(), turnError);

    expect(result.error?.message).toBe("Model provider is not configured: old-provider");
    expect(result.error?.detail).toContain("Turn execution failed");
    expect(result.error?.detail).toContain("provider=old-provider");
    expect(result.error?.detail).toContain("model=old-model");
    expect(stringifyToolResultOutput(result)).toBe(
      "Model provider is not configured: old-provider",
    );
  });

  it("keeps provider cause identity when subagent wrappers add context", () => {
    const providerError = Object.assign(
      new Error("Model provider is not configured: old-provider"),
      {
        code: "provider_not_found",
        context: {
          providerId: "old-provider",
          modelId: "old-model",
        },
        name: "AiSdkModelAdapterError",
      },
    );
    const subagentError = createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Explore subagent failed",
      {
        cause: providerError,
        context: withErrorPayloadRole(
          {
            code: "agent_child_runtime_failed",
            agentId: "agent_e2e",
            agentType: "e2e-stale-error-reviewer",
          },
          ErrorPayloadRole.Wrapper,
        ),
        recoverable: true,
      },
    );

    const result = createErrorResult(agentToolCall(), subagentError);

    expect(result.error?.message).toBe("Model provider is not configured: old-provider");
    expect(result.error?.code).toBe("provider_not_found");
    expect(result.error?.detail).toContain("Explore subagent failed");
    expect(result.error?.detail).toContain("code=agent_child_runtime_failed");
    expect(result.error?.detail).toContain("provider=old-provider");
    expect(result.error?.detail).toContain("model=old-model");
    expect(stringifyToolResultOutput(result)).toBe(
      "Model provider is not configured: old-provider",
    );
  });

  it("keeps invalid subagent model context in failed parent Agent tool calls", () => {
    const parseError = new Error("Model ref is missing model id");
    const configurationError = createCoreError(
      CoreErrorType.ConfigurationError,
      "Invalid subagent model configuration",
      {
        cause: parseError,
        context: withErrorPayloadRole(
          {
            code: "INVALID_SUBAGENT_MODEL",
            model: "custom:old-provider:",
            reason: "missing_model_id",
          },
          ErrorPayloadRole.Wrapper,
        ),
        recoverable: true,
      },
    );

    const result = createErrorResult(agentToolCall(), configurationError);

    expect(result.error?.message).toBe("Model ref is missing model id");
    expect(result.error?.code).toBe("INVALID_SUBAGENT_MODEL");
    expect(result.error?.detail).toContain("Invalid subagent model configuration");
    expect(result.error?.detail).toContain("model=custom:old-provider:");
    expect(result.error?.detail).toContain("reason=missing_model_id");
  });

  it("preserves plan approval feedback before turn steering handles it", () => {
    const feedback = "x".repeat(600);

    const result = createPermissionErrorResult(
      {
        id: "exit_plan",
        input: { plan: "1. Keep discussing" },
        name: "ExitPlanMode",
      },
      feedback,
      { reasonSource: "plan_approval_feedback" },
    );

    expect(result.error?.message).toBe(feedback);
    expect(result.error?.reasonSource).toBe("plan_approval_feedback");
  });

  it("preserves workflow refine feedback before turn steering handles it", () => {
    const feedback = "改成先跑 lint 再 fan out，".repeat(60);

    const result = createPermissionErrorResult(
      {
        id: "create_workflow",
        input: { script: "return 1;" },
        name: "CreateWorkflow",
      },
      feedback,
      { reasonSource: "workflow_refine_feedback" },
    );

    expect(result.error?.message).toBe(feedback);
    expect(result.error?.reasonSource).toBe("workflow_refine_feedback");
  });
});

function agentToolCall(): ExecutableToolCall {
  return {
    id: "call_agent",
    input: {
      description: "Run stale configured subagent",
      prompt: "Inspect the repo",
      subagent_type: "Explore",
    },
    name: "Agent",
  };
}
