// 权限规则的读取、持久化与授权后的落定（从 permission-flow.ts 拆出）。
// 拆分原因：permission-flow.ts 引入 responder 竞速后超过单文件 400 行上限；这里的 helper 只与
// 规则存取内聚（project 级写 sessionStore、会话级进内存 ruleset），与 ask 时序无关。确认窗的设置调整
// 让 permission-flow.ts 再次逼近上限时，授权应答里的规则更新整段也搬了过来（行为不变）。
import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type PermissionRuleset,
  type PermissionUpdate,
  type ProjectId,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { applyPermissionUpdates } from "./permission-rules.js";
import type { ToolExecutorDeps } from "./types.js";

export async function loadProjectPermissionRuleset(
  deps: ToolExecutorDeps,
): Promise<PermissionRuleset | null> {
  if (!deps.sessionStore) return null;
  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") return session.permission;
  if (!session?.projectID) return null;
  return deps.sessionStore.getProjectPermission(session.projectID);
}

export async function persistProjectPermissionUpdates(
  deps: ToolExecutorDeps,
  updates: PermissionUpdate[],
  traceContext: TraceContext,
): Promise<void> {
  if (updates.length === 0) return;

  if (!deps.sessionStore) {
    deps.logger?.warn("Project permission update skipped without session store", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") {
    await deps.sessionStore.updateSession({
      id: deps.sessionId,
      permission: applyPermissionUpdates(session.permission, updates),
    });
    return;
  }
  const projectID = await resolveProjectId(deps);
  if (!projectID) {
    deps.logger?.warn("Project permission update skipped without persisted session", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const current = (await deps.sessionStore.getProjectPermission(projectID)) ?? { version: 1 };
  const next = applyPermissionUpdates(current, updates);
  await deps.sessionStore.saveProjectPermission({ projectID, permission: next });

  deps.logger?.info("Project permission updated", {
    ...traceContextToLogContext(traceContext),
    event: "tool.permission.project_update.saved",
    module: "core.tool.executor",
    status: "completed",
    updateCount: updates.length,
  });
}

/**
 * 授权应答里的规则更新：先把项目级规则写盘，再把会话级规则放进内存 ruleset。写盘失败即返回工具失败
 * 结果（用户选的「始终允许」没能记住，不能当作什么都没发生），此时会话级规则也不落。
 */
export async function applyGrantedPermissionUpdates(options: {
  deps: ToolExecutorDeps;
  permissionUpdates: PermissionUpdate[] | undefined;
  requestId: string;
  sessionPermissionUpdates: PermissionUpdate[] | undefined;
  toolCall: ExecutableToolCall;
  traceContext: TraceContext;
}): Promise<ToolExecutionResult | undefined> {
  const { deps, permissionUpdates, requestId, sessionPermissionUpdates, toolCall, traceContext } =
    options;
  if (permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(deps, permissionUpdates, traceContext);
    } catch (error) {
      return createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to persist project permission update", {
          cause: error instanceof Error ? error : undefined,
          context: {
            requestId,
            sessionId: deps.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          },
          recoverable: true,
        }),
      );
    }
  }

  if (sessionPermissionUpdates?.length) {
    // 会话免确认（docs/dynamic-workflow/launch.md「Always allow in this session」）：只进内存里的会话 ruleset，
    // 与上面的项目级持久化互不可见。
    deps.permissionService.grantSessionPermission(sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: sessionPermissionUpdates.length,
    });
  }
  return undefined;
}

async function resolveProjectId(deps: ToolExecutorDeps): Promise<ProjectId | undefined> {
  const session = await deps.sessionStore?.getSession(deps.sessionId);
  return session?.projectID;
}
