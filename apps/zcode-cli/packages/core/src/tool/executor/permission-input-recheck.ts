import { type CollaborationMode, type PermissionRuleset } from "@zcode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import type { ToolExecutorDeps } from "./types.js";

export interface PermissionHookInputRecheckResult {
  permissionDecision?: PermissionDecisionResult;
}

export function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  toolCall: ExecutableToolCall;
  /** 与首次判权同一份上下文（mode、bashShellSelection、cwd 快照），由 executor 构造并透传。 */
  context: ToolRuntimePermissionCapabilityContext & {
    workingDirectory: string;
    workspaceRoot: string;
  };
}): PermissionHookInputRecheckResult {
  // 根因（2026-09-17 review）：此前在此重新构造只含 runtimeScope/cwd 的缩减上下文，丢掉 mode 与
  // bashShellSelection；一旦 guarded 复用重判路径，matcher 会静默失效。上下文只能有一个构造点。
  const { context: runtimePermissionContext } = input;
  const { workingDirectory, workspaceRoot } = runtimePermissionContext;
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // 与首次判定同源：hook 改过 input 之后，草稿免确认仍要按同一个工作目录复核。
    workingDirectory,
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory,
    workspaceRoot,
  });

  if (decision.decision === "deny") {
    return {
      permissionDecision: decision,
    };
  }
  if (
    decision.decision !== "ask" ||
    (decision.ruleId !== "rule.project.ask" &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory,
        workspaceRoot,
      }))
  ) {
    return {};
  }

  // 仅返回旧模式需要保留的策略事实；请求登记/发布/终态全部由 executor 统一处理。
  return { permissionDecision: decision };
}
