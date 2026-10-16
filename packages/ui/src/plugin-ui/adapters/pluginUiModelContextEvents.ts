import { useCallback, useEffect, useState } from "react";
import { buildPluginUiSessionKey, type PluginUiSessionScope } from "@/plugin-ui/contract.js";
import type { PluginUiModelContext } from "@/plugin-ui/domain/pluginUiModelContext.js";

// 接收端登记不保存草稿：Composer hook 是唯一 owner；卸载立即撤销投递能力。
const receivers = new Map<string, (context: PluginUiModelContext) => void>();

export function registerPluginUiModelContextReceiver(
  scope: PluginUiSessionScope,
  receive: (context: PluginUiModelContext) => void,
): () => void {
  const key = buildPluginUiSessionKey(scope);
  receivers.set(key, receive);
  return () => {
    if (receivers.get(key) === receive) receivers.delete(key);
  };
}

/** 修复：window 事件只按 sessionId 过滤，会把相同 session 的上下文投给其它 workspace。 */
export function dispatchPluginUiModelContextAdd(
  scope: PluginUiSessionScope,
  context: PluginUiModelContext,
): boolean {
  const receive = receivers.get(buildPluginUiSessionKey(scope));
  if (!receive || scope.sessionId !== context.sessionId) return false;
  receive(context);
  return true;
}

export function usePluginUiModelContexts(
  input: Omit<PluginUiSessionScope, "sessionId"> & { sessionId: string | null },
): {
  contexts: readonly PluginUiModelContext[];
  hasContexts: boolean;
  removeContext: (id: string) => void;
  clearContexts: () => void;
} {
  const [contexts, setContexts] = useState<readonly PluginUiModelContext[]>([]);
  const key = input.sessionId
    ? buildPluginUiSessionKey({ ...input, sessionId: input.sessionId })
    : null;
  const { sessionId, workspacePath, workspaceIdentity } = input;
  useEffect(() => {
    setContexts([]);
  }, [key]);
  useEffect(() => {
    if (!sessionId) return;
    return registerPluginUiModelContextReceiver(
      { workspacePath, workspaceIdentity, sessionId },
      (context) => {
        setContexts((items) => {
          const index = items.findIndex((item) => item.id === context.id);
          return index < 0
            ? [...items, context]
            : items.map((item) => (item.id === context.id ? context : item));
        });
      },
    );
  }, [sessionId, workspacePath, workspaceIdentity]);
  const removeContext = useCallback(
    (id: string) => setContexts((items) => items.filter((item) => item.id !== id)),
    [],
  );
  const clearContexts = useCallback(() => setContexts([]), []);
  return { contexts, hasContexts: contexts.length > 0, removeContext, clearContexts };
}
