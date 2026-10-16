import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type {
  OpenPluginUiSideTabRequest,
  PluginUiSessionScope,
  PluginUiSessionCommandPort,
  PluginUiToolBinding,
} from "@/plugin-ui/contract.js";
import { createPluginUiSessionActions } from "@/plugin-ui/adapters/pluginUiSessionBinding.js";
import { registerPluginUiSessionActions } from "@/plugin-ui/adapters/pluginUiSessionActions.js";
import { usePluginUiResourceDeltaFeed } from "@/plugin-ui/adapters/pluginUiResourceDeltaFeed.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";

const WorkspaceActions = createContext<((request: OpenPluginUiSideTabRequest) => void) | undefined>(
  undefined,
);
const SessionScope = createContext<PluginUiSessionScope | null>(null);

/** Shell 只在边界提供面板动作，中间布局组件不感知插件请求。 */
export function PluginUiWorkspaceProvider({
  onOpenSidePane,
  children,
}: {
  onOpenSidePane: (request: OpenPluginUiSideTabRequest) => void;
  children: ReactNode;
}) {
  return <WorkspaceActions.Provider value={onOpenSidePane}>{children}</WorkspaceActions.Provider>;
}
export function useOpenPluginUi() {
  return useContext(WorkspaceActions);
}

/** SessionPane 拥有命令入口；本适配器只绑定作用域与挂载生命周期。 */
export function PluginUiSessionProvider({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
  readOnly,
  sendText,
  uploadAttachment,
  projectionStore,
  children,
}: Omit<PluginUiSessionScope, "sessionId"> & {
  sessionId: string | null;
  readOnly: boolean;
  /** 本会话的投影 store（lease 就绪后给出），插件资源通知从它的 live 增量路由到沙箱实例。 */
  projectionStore?: ConversationProjectionStore | null;
  children: ReactNode;
} & PluginUiSessionCommandPort) {
  const scope = useMemo(
    () => (sessionId ? { workspacePath, workspaceIdentity, remoteSessionId, sessionId } : null),
    [workspacePath, workspaceIdentity, remoteSessionId, sessionId],
  );
  const port = useRef({ sendText, uploadAttachment });
  port.current = { sendText, uploadAttachment };
  usePluginUiResourceDeltaFeed(projectionStore, scope);
  useEffect(() => {
    if (!scope || readOnly) return;
    // 修复：发送配置变更会重建回调，但不应让同一挂载中的待确认请求失效。
    return registerPluginUiSessionActions(
      scope,
      createPluginUiSessionActions(scope, {
        sendText: (...args) => port.current.sendText(...args),
        uploadAttachment: (...args) => port.current.uploadAttachment(...args),
      }),
    );
  }, [scope, readOnly]);
  return <SessionScope.Provider value={scope}>{children}</SessionScope.Provider>;
}

export function usePluginUiToolBinding(toolCallId: string): PluginUiToolBinding | undefined {
  const scope = useContext(SessionScope);
  const open = useOpenPluginUi();
  return useMemo(
    () =>
      scope
        ? {
            scope: { ...scope, toolCallId },
            ...(open
              ? {
                  onOpenSidePane: (
                    request: Parameters<NonNullable<PluginUiToolBinding["onOpenSidePane"]>>[0],
                  ) =>
                    open({
                      ...request,
                      workspacePath: scope.workspacePath,
                      workspaceIdentity: scope.workspaceIdentity,
                      remoteSessionId: scope.remoteSessionId,
                      parentSessionId: scope.sessionId,
                    }),
                }
              : {}),
          }
        : undefined,
    [open, scope, toolCallId],
  );
}
