import type { WindowHostAttachmentScope } from "@zcode/shared";

/** 群控制复用已验证 attachment，不能由 RPC 调用方声明另一条远程会话。 */
export function bindBotGroupTaskScope<T extends object>(
  params: T,
  scope: WindowHostAttachmentScope,
): T {
  return scope.kind === "local"
    ? params
    : {
        ...params,
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        remoteSessionId: scope.remoteSessionId,
      };
}
