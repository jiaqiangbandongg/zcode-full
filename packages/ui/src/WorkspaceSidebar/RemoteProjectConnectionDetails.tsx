import { formatRemoteWorkspaceDisplayLabel } from "@/lib/remoteWorkspaceHistory.js";
import { Button } from "@/components/ui/button.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { Cloud } from "lucide-react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  formatRemoteConnectionDescription,
  type RemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";

export function RemoteProjectConnectionDetails({
  tab,
  deviceName,
  presentation,
  error,
  onConnect,
  onDisconnect,
  onEdit,
  onManage,
}: {
  tab: WorkspaceTabState;
  deviceName: string;
  presentation: RemoteConnectionPresentation;
  error?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onEdit?: () => void;
  onManage?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const color = presentation.foreground;
  const state = presentation.status;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-ui-sm text-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Cloud className={cn("size-4 shrink-0", color)} />
        <strong className="min-w-0 flex-1 break-words font-medium">
          {formatRemoteWorkspaceDisplayLabel(tab.label, tab.remoteTarget)}
        </strong>
        <RemoteConnectionStatusTag presentation={presentation} className="ml-auto" />
      </div>
      {presentation.recovery ? (
        <p className={presentation.foreground}>
          {intl.formatMessage(
            { id: presentation.recovery.messageId },
            presentation.recovery.values,
          )}
        </p>
      ) : null}
      {presentation.reason ? (
        <p className={presentation.foreground}>
          {presentation.reasonText ??
            intl.formatMessage({ id: presentation.reason.reasonId }, presentation.reason.values)}
        </p>
      ) : null}
      {error && presentation.reason ? (
        <details className="text-ui-xs text-remote-foreground-muted">
          <summary>{intl.formatMessage({ id: "remote.error.details" })}</summary>
          <pre className="whitespace-pre-wrap break-words">{error}</pre>
        </details>
      ) : null}
      <div className="-mx-3 border-t border-border" />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "workspaceSidebar.projectDevice" })}
        </dt>
        <dd className="min-w-0 break-all">{deviceName}</dd>
        <dt className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "workspaceSidebar.projectLine" })}
        </dt>
        <dd className="min-w-0 break-all">{formatRemoteConnectionDescription(tab.remoteTarget)}</dd>
        <dt className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "workspaceSidebar.projectPath" })}
        </dt>
        <dd className="min-w-0 break-all rounded-sm bg-surface px-2 py-1 font-mono">
          {tab.workspacePath}
        </dd>
      </dl>
      <div className="-mx-3 flex flex-wrap gap-2 border-t border-border px-3 pt-3">
        {(state === "online" ? onDisconnect : onConnect) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={state === "connecting"}
            onClick={state === "online" ? onDisconnect : onConnect}
          >
            {intl.formatMessage({
              id: state === "online" ? "remote.action.disconnect" : "remote.action.connect",
            })}
          </Button>
        ) : null}
        {onEdit ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
            {intl.formatMessage({ id: "settings.source.editConnectionTitle" })}
          </Button>
        ) : null}
        {onManage ? (
          <Button size="sm" variant="ghost" onClick={onManage}>
            {intl.formatMessage({ id: "workspaceSidebar.manageDevice" })}
          </Button>
        ) : null}
      </div>
      <p className="text-remote-foreground-muted">
        {intl.formatMessage({
          id:
            state === "online"
              ? "workspaceSidebar.openProjectHint"
              : state === "connecting"
                ? "workspaceSidebar.connecting"
                : "workspaceSidebar.reconnectProjectHint",
        })}
      </p>
    </div>
  );
}
