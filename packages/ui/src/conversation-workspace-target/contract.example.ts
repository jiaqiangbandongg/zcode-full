import type {
  ConversationWorkspaceTargetParams,
  ResolveConversationWorkspaceTarget,
} from "@/conversation-workspace-target/contract.js";

/** Root 从当前窗口注入只读查询与既有打开操作，每次调用读取最新事实。 */
export function exampleConversationWorkspaceTarget(
  resolve: ResolveConversationWorkspaceTarget,
  ports: ConversationWorkspaceTargetParams,
) {
  return resolve(ports);
}
