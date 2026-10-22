import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ConversationWorkspaceTab,
  ConversationWorkspaceTarget,
  ConversationWorkspaceTargetParams,
} from "@/conversation-workspace-target/contract.js";

/** 解析本地“在项目外工作”的目标，远程项目不提供该操作。 */
export async function resolveConversationWorkspaceTarget(
  params: ConversationWorkspaceTargetParams,
): Promise<ConversationWorkspaceTarget> {
  const activeWorkspaceKey = resolveWorkspaceKey({
    workspacePath: params.activeWorkspacePath ?? "",
    workspaceIdentity: params.activeWorkspaceIdentity ?? undefined,
  });
  // 本地 identity 为空时不能通配同路径远端 tab，否则会误触远端保护；按完整 workspaceKey 匹配。
  const activeTab = params
    .getTabs()
    .find(
      (tab): tab is ConversationWorkspaceTab =>
        tab.kind === "workspace" && resolveWorkspaceKey(tab) === activeWorkspaceKey,
    );
  // 远程项目不允许解除项目绑定；入口已隐藏，这里拦住陈旧回调，不能静默切换执行设备。
  if (
    activeTab &&
    (activeTab.remoteTarget || activeTab.remoteSessionId || activeTab.workspaceIdentity)
  ) {
    throw new Error("Remote projects require a project workspace");
  }
  if (activeTab?.workspacePurpose === "conversation")
    return { workspacePath: activeTab.workspacePath };
  return { workspacePath: await params.resolveLocalConversationWorkspacePath() };
}
