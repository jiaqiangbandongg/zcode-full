// ============================================================
// 确认窗里的入参调整：授权之后、handler 之前的那一步
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// broker 把用户在确认窗里改过的字段放在结果的 `inputAdjustments` 上；这里把它交给工具自己的
// `applyInputAdjustments`，换回调整后的入参。放在 permission flow 的尾部而不是 handler 里，是因为
// 调整属于「用户批准了什么」，而 handler 只该面对一份已经落定的入参——与 `resolveInput` 同一条理由。

import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolExecutionResult,
  ToolInputResolutionContext,
} from "../types.js";
import {
  createErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
} from "./errors.js";
import type { ToolExecutorDeps } from "./types.js";

export type PermissionInputAdjustmentOutcome =
  | { ok: true; executionInput: unknown; applied?: Readonly<Record<string, unknown>> }
  | { ok: false; result: ToolExecutionResult };

/**
 * `resolveInput` 与 `applyInputAdjustments` 共用的上下文。两处读的必须是同一组端口：确认窗之前按
 * 这份目录解析过的模型，批准之后也按这份目录再解析一遍。
 */
export function buildToolInputResolutionContext(
  deps: ToolExecutorDeps,
): ToolInputResolutionContext {
  const workingDirectory = deps.getWorkingDirectory?.();
  return {
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
    ...(deps.dynamicWorkflowRunPort === undefined
      ? {}
      : { dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort }),
    ...(deps.modelCatalogPort === undefined ? {} : { modelCatalogPort: deps.modelCatalogPort }),
    sessionId: deps.sessionId,
    ...(deps.hasLoadedSkill === undefined ? {} : { hasLoadedSkill: deps.hasLoadedSkill }),
  };
}

export function applyPermissionInputAdjustments(options: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  toolCall: ExecutableToolCall;
  executionInput: unknown;
  adjustments: Readonly<Record<string, unknown>> | undefined;
  traceContext: TraceContext;
}): PermissionInputAdjustmentOutcome {
  const { adjustments, deps, entry, executionInput, toolCall, traceContext } = options;
  if (adjustments === undefined || Object.keys(adjustments).length === 0) {
    return { ok: true, executionInput };
  }
  const logContext = {
    ...traceContextToLogContext(traceContext),
    adjustedKeys: Object.keys(adjustments),
    module: "core.tool.executor",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  };
  if (!entry.applyInputAdjustments) {
    // broker 只为声明了这一步的工具合成调整；走到这里说明 broker 与工具声明不同步。照原入参执行
    // 并留痕，而不是替用户拒绝一次他已经批准的调用。
    deps.logger?.warn("Permission input adjustments ignored: the tool does not apply them", {
      ...logContext,
      event: "tool.permission.input_adjustments_ignored",
      status: "completed",
    });
    return { ok: true, executionInput };
  }
  const outcome = entry.applyInputAdjustments(
    executionInput,
    adjustments,
    buildToolInputResolutionContext(deps),
  );
  if (isToolHandlerFailure(outcome)) {
    deps.logger?.warn("Permission input adjustments rejected", {
      ...logContext,
      errorCode: outcome.errorCode,
      event: "tool.permission.input_adjustments_rejected",
      status: "failed",
    });
    return {
      ok: false,
      result: createErrorResult(toolCall, createToolHandlerFailureError(toolCall, outcome)),
    };
  }
  deps.logger?.info("Permission input adjustments applied", {
    ...logContext,
    appliedKeys: Object.keys(outcome.applied ?? {}),
    event: "tool.permission.input_adjustments_applied",
    status: "completed",
  });
  return {
    ok: true,
    executionInput: outcome.input,
    ...(outcome.applied === undefined ? {} : { applied: outcome.applied }),
  };
}
