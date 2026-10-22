import { useEffect } from "react";
import type { IPlatformService, WebRemoteControlWorkspaceTarget } from "@zcode/shared";
import { isWorkspaceTab, type WindowTabState } from "@/store/tabStore.js";

export function buildWebRemoteControlWorkspaceTargets({
  tabs,
  reconnectingRemoteWorkspaceKeys = [],
  remoteWorkspaceErrorByWorkspaceKey = {},
}: {
  tabs: WindowTabState[];
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
}): WebRemoteControlWorkspaceTarget[] {
  const reconnectingWorkspaceKeySet = new Set(reconnectingRemoteWorkspaceKeys);

  return tabs.filter(isWorkspaceTab).map((tab) => {
    const isRemote = Boolean(tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId);
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    const lastConnectionError = remoteWorkspaceErrorByWorkspaceKey[workspaceKey]?.trim();
    return {
      workspacePath: tab.workspacePath,
      label: tab.label,
      kind: isRemote ? "remote" : "local",
      ...(isRemote
        ? {
            connectionState: reconnectingWorkspaceKeySet.has(workspaceKey)
              ? ("reconnecting" as const)
              : tab.remoteSessionId
                ? ("connected" as const)
                : ("disconnected" as const),
          }
        : {}),
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      ...(isRemote && lastConnectionError ? { lastConnectionError } : {}),
    };
  });
}

export function buildConnectedRemoteWorkspaceSessionTargets({
  tabs,
}: {
  tabs: WindowTabState[];
}): WebRemoteControlWorkspaceTarget[] {
  return tabs
    .filter(isWorkspaceTab)
    .filter((tab) => tab.remoteSessionId && tab.workspaceIdentity)
    .map((tab) => ({
      workspacePath: tab.workspacePath,
      label: tab.label,
      kind: "remote" as const,
      connectionState: "connected" as const,
      workspaceIdentity: tab.workspaceIdentity!,
      remoteSessionId: tab.remoteSessionId!,
    }));
}

export function shouldPublishCompleteWorkspaceSnapshot(
  hasCompletedFullTabRestore: boolean,
): boolean {
  return hasCompletedFullTabRestore;
}

/** workspace 同步只有一个完整快照入口，不依赖远控是否已有 runtime。 */
export function useWebRemoteControlWorkspaceSync({
  platform,
  tabs,
  isDesktop,
  featureEnabled,
  hasCompletedFullTabRestore,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
}: {
  platform: Pick<IPlatformService, "syncWebRemoteControlWorkspaces">;
  tabs: WindowTabState[];
  isDesktop: boolean;
  featureEnabled: boolean;
  hasCompletedFullTabRestore: boolean;
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
}): void {
  useEffect(() => {
    if (!isDesktop || !hasCompletedFullTabRestore) return;
    // 未运行时也必须发布本地+远端完整列表，否则登录后仅剩远端局部列表，丢失本地恢复目标。
    // 特性关闭时仍保留 Bot 已连接远端的绑定入口。
    const workspaces = featureEnabled
      ? buildWebRemoteControlWorkspaceTargets({
          tabs,
          reconnectingRemoteWorkspaceKeys,
          remoteWorkspaceErrorByWorkspaceKey,
        })
      : buildConnectedRemoteWorkspaceSessionTargets({ tabs });
    platform.syncWebRemoteControlWorkspaces?.(workspaces);
  }, [
    platform,
    tabs,
    isDesktop,
    featureEnabled,
    hasCompletedFullTabRestore,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
  ]);
}
