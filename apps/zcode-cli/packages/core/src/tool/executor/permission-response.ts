import {
  CoreErrorType,
  createCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import type { PermissionDecisionResult } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { preparePermissionInput, snapshotPermissionInput } from "./permission-input.js";
import type { PermissionResponderRaceOutcome } from "./permission-responder-race.js";
import type { ToolExecutorDeps } from "./types.js";

export type PermissionFlowResult =
  | {
      allowed: true;
      executionInput: unknown;
      permissionWaitMs?: number;
      /** 确认窗里的调整中实际生效的那部分（applyInputAdjustments 的 applied）。 */
      inputAdjustments?: Readonly<Record<string, unknown>>;
    }
  | { allowed: false; result: ToolExecutionResult };

export type PermissionResponseTransition =
  | { kind: "rewrite"; input: unknown }
  | { kind: "complete"; result: PermissionFlowResult };

/** 应答来源取真实 responder；响应载荷不能自行声明授权豁免。 */
export function interpretPermissionResponse(params: {
  deps: ToolExecutorDeps;
  toolCall: ExecutableToolCall;
  entry: ToolEntry;
  input: unknown;
  mode: CollaborationMode;
  decision: PermissionDecisionResult;
  outcome: PermissionResponderRaceOutcome;
  requestId: string;
}): PermissionResponseTransition {
  const { deps, toolCall, entry, mode, decision, outcome, requestId } = params;
  const response = outcome.result;
  if (mode === "guarded")
    validatePermissionResponse(response, decision.approvalMode === "user-once");
  if (response.decision === "deny") {
    return {
      kind: "complete",
      result: {
        allowed: false,
        result: createPermissionErrorResult(
          toolCall,
          response.reason,
          { mode, requestId, ruleId: decision.ruleId, reasonSource: response.reasonSource },
          response.preserveReasonFormatting ? { preserveReasonFormatting: true } : undefined,
        ),
      },
    };
  }
  if (response.decision === "escalate") {
    return {
      kind: "complete",
      result: {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(
            CoreErrorType.PermissionEscalation,
            response.reason ?? "Permission escalation requested",
            {
              context: { mode, requestId, ruleId: decision.ruleId, toolName: toolCall.name },
              recoverable: true,
            },
          ),
        ),
      },
    };
  }
  let input = params.input;
  if (
    response.decision === "modify" ||
    (mode === "guarded" && response.modifiedInput !== undefined)
  ) {
    input = preparePermissionInput(response.modifiedInput ?? input, entry, deps);
    if (mode === "guarded") {
      input = snapshotPermissionInput(input);
      // 根因：把用户已批准的修改当作 Hook 提案会重复询问；broker 的批准/答案均完成本次请求。
      // 来源取真实 responder，Hook 改写仍重判，不能通过响应载荷自报为用户批准。
      if (outcome.source === "hook") return { kind: "rewrite", input };
    }
  }
  return { kind: "complete", result: { allowed: true, executionInput: input } };
}

function validatePermissionResponse(response: PermissionBrokerResult, once: boolean): void {
  if (
    !response ||
    !["allow", "deny", "modify", ...(once ? [] : ["escalate"])].includes(response.decision) ||
    (response.reason !== undefined && typeof response.reason !== "string") ||
    (response.permissionUpdates !== undefined &&
      (!Array.isArray(response.permissionUpdates) ||
        (once && response.permissionUpdates.length > 0))) ||
    (response.decision === "modify" && response.modifiedInput === undefined) ||
    (response.sessionPermissionUpdates !== undefined &&
      (!Array.isArray(response.sessionPermissionUpdates) ||
        (once && response.sessionPermissionUpdates.length > 0)))
  ) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Invalid permission response; single-use requests cannot persist project rules",
      { recoverable: true },
    );
  }
}
