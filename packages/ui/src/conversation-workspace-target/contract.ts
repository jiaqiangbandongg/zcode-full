/** 仅描述解析所需的只读视图；tab 的生命周期仍由窗口 store 管理。 */
export interface ConversationWorkspaceTab {
  readonly kind: "workspace";
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly workspacePurpose?: "project" | "conversation";
  readonly remoteSessionId?: string;
  /** 只用于判定远端 tab；只有 remoteTarget 的旧远端 tab 也不能解除项目绑定。 */
  readonly remoteTarget?: unknown;
}

export interface ConversationWorkspaceTarget {
  workspacePath: string;
  /** 远端使用现有 stable identity；本地继续走 workspacePath fallback。 */
  workspaceIdentity?: string;
}

/** Root 注入现有操作；不转移 store、连接或持久化的所有权。 */
export interface ConversationWorkspaceTargetParams {
  getTabs: () => readonly (ConversationWorkspaceTab | { readonly kind: "settings" })[];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  getRemoteSessionSourceServerId?: (remoteSessionId: string) => string | undefined;
  openRemoteConversation?: (remoteSessionId: string, sourceServerId?: string) => Promise<void>;
  resolveLocalConversationWorkspacePath: () => Promise<string>;
}

/**
 * 已在本地 conversation 时直接返回；远端拒绝解除项目绑定。
 * 端口失败、Source 未知或目标缺失时 reject，不回落本地。重试由打开端口承接；
 * 解析器不发事件、不写持久化、不保存任何请求状态。
 */
export type ResolveConversationWorkspaceTarget = (
  params: ConversationWorkspaceTargetParams,
) => Promise<ConversationWorkspaceTarget>;
