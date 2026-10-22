import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RemoteWorkspaceRecoveryStatus } from "@/app-shell/types.js";

interface RemoteProjectPresentationFacts {
  reconnectingKeys: readonly string[];
  errors: Readonly<Record<string, string>>;
  recovery: Readonly<Record<string, RemoteWorkspaceRecoveryStatus>>;
  onReconnect?: (workspaceKey: string) => Promise<void>;
}
const EMPTY: RemoteProjectPresentationFacts = { reconnectingKeys: [], errors: {}, recovery: {} };
const Context = createContext<RemoteProjectPresentationFacts>(EMPTY);

/** 仅向消费界面传递 Root 现有恢复 owner 的事实，不缓存或接管恢复时序。 */
export function RemoteProjectPresentationProvider({
  children,
  reconnectingKeys,
  errors,
  recovery,
  onReconnect,
}: RemoteProjectPresentationFacts & { children: ReactNode }) {
  const value = useMemo(
    () => ({ reconnectingKeys, errors, recovery, onReconnect }),
    [reconnectingKeys, errors, recovery, onReconnect],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRemoteProjectPresentationFacts(workspaceKey: string) {
  const facts = useContext(Context);
  const recovery = facts.recovery[workspaceKey];
  return {
    reconnecting: facts.reconnectingKeys.includes(workspaceKey),
    projectError: facts.errors[workspaceKey],
    recoveryAttempt: recovery?.mode === "automatic" ? recovery.attempt : undefined,
    recoveryLimit: recovery?.limit,
  };
}

/** 手机继续通过既有 shared-host RPC，桌面使用 Root 的连接意图入口。 */
export function useRemoteProjectReconnect() {
  return useContext(Context).onReconnect;
}
