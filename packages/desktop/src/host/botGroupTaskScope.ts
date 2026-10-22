import type { WindowHostAttachmentScope } from "@zcode/shared";

/** 群控制复用已验证 attachment，不能由 RPC 调用方声明另一条远程会话。 */
export function bindBotGroupTaskScope<T extends object>(
  params: T,
  scope: WindowHostAttachmentScope,
): T {
  // Source settings 没有 workspace/task 权限，不能按 remote 分支读取不存在的路由字段。
  if (scope.kind === "source-settings") {
    throw new Error("Source settings attachment does not provide bot task routing");
  }
  return scope.kind === "local"
    ? params
    : {
        ...params,
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        remoteSessionId: scope.remoteSessionId,
      };
}
