import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  useRemoteProjectPresentationFacts,
  useRemoteProjectReconnect,
} from "@/hooks/RemoteProjectPresentationContext.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";

export function useRemoteProjectConnectionPresentation(scope: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const workspaceKey = resolveWorkspaceKey(scope);
  const tab = useTabStore((state) =>
    state.tabs.find(
      (entry) => isWorkspaceTab(entry) && resolveWorkspaceKey(entry) === workspaceKey,
    ),
  );
  const workspaceTab = tab && isWorkspaceTab(tab) ? tab : null;
  const sourceId = getWorkspaceSourceServerId(workspaceTab ?? scope);
  const device = useRemoteDevicePresentationInput(sourceId ?? undefined);
  const facts = useRemoteProjectPresentationFacts(workspaceKey);
  const attached = useRemoteWorkspaceSessionStore((state) => {
    const id = state.sessionIdByWorkspaceIdentity[workspaceKey] ?? workspaceTab?.remoteSessionId;
    return Boolean(id && state.sessionsById[id]?.services);
  });
  const controller = useOptionalRemoteWorkspaceController();
  const onReconnect = useRemoteProjectReconnect();
  const presentation = resolveRemoteConnectionPresentation({ ...device, ...facts, attached });
  return {
    tab: workspaceTab,
    deviceName: device?.displayName ?? workspaceTab?.label ?? scope.workspacePath,
    presentation,
    busy:
      facts.reconnecting ||
      ["bootstrapping", "retrying", "connecting", "updating"].includes(device?.state ?? ""),
    error: facts.projectError ?? device?.error,
    reconnect: async () => {
      try {
        if (onReconnect) await onReconnect(workspaceKey);
        else await controller?.dispatch({ type: "reconnect-workspace", workspaceKey });
      } catch (error) {
        toast(
          formatRemoteConnectionError({
            fallback: String(error),
            reasonCode: getRemoteConnectionFailureCode(error),
            formatMessage: intl.formatMessage,
          }),
        );
      }
    },
  };
}
