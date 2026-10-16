import type { WebRemoteControlWorkspaceTarget } from "@zcode/shared";
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
