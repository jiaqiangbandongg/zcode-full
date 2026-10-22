import type { WorkspacePurpose } from "@zcode/shared";

/** 远程无项目聊天只保留历史数据，不进入任何 UI 导航或恢复候选。 */
export function isRemoteConversationWorkspace(target: {
  workspacePurpose?: WorkspacePurpose;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
  kind?: string;
}): boolean {
  return (
    target.workspacePurpose === "conversation" &&
    Boolean(
      target.kind === "remote" ||
      target.remoteTarget ||
      target.remoteSessionId ||
      target.workspaceIdentity?.trim(),
    )
  );
}
