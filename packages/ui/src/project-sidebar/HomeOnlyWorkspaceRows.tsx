import { SidebarNativeTooltip } from "@/ControlHintTooltip.js";
import { useState } from "react";
import { Folder } from "lucide-react";
import {
  isWebRemoteControlBridgeableWorkspaceTarget,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  formatRemoteConnectionError,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { logger } from "@/logger.js";
import { useHomeOnlyWorkspaces } from "@/project-sidebar/useHomeOnlyWorkspaces.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

/** home-only 首页的工作区入口：可 bridge 的行打开工作区，其余行交给桌面已有重连 owner。 */
export function HomeOnlyWorkspaceRows({
  switcher,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
}) {
  const { intl } = useZCodeIntl();
  const { workspaces, error, reload } = useHomeOnlyWorkspaces(switcher);
  // 同一时间只允许一个打开/重连请求，避免两个 bridge 切换互相覆盖 Root。
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const run = async (workspace: WebRemoteControlWorkspaceTarget) => {
    const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
    setPendingKey(workspaceKey);
    try {
      if (isWebRemoteControlBridgeableWorkspaceTarget(workspace)) {
        await switcher.switchWorkspace(workspaceKey);
      } else {
        await switcher.reconnectWorkspace?.(workspaceKey);
        await reload();
      }
    } catch (cause) {
      logger.warn("[project-sidebar] home-only 工作区操作失败", {
        workspaceKey,
        error: getErrorMessage(cause),
      });
      toast(
        formatRemoteConnectionError({
          fallback: getErrorMessage(cause),
          reasonCode: getRemoteConnectionFailureCode(cause),
          formatMessage: intl.formatMessage,
        }),
      );
    } finally {
      setPendingKey(null);
    }
  };
  return (
    <section data-testid="home-only-workspaces" className="px-2">
      <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">
        {intl.formatMessage({ id: "webRemoteControl.homeOnlyWorkspaces" })}
      </h3>
      {workspaces?.map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        const bridgeable = isWebRemoteControlBridgeableWorkspaceTarget(workspace);
        const remote = workspace.kind === "remote";
        const presentation = resolveRemoteConnectionPresentation({
          state:
            workspace.connectionState === "connected"
              ? "online"
              : workspace.connectionState === "reconnecting"
                ? "connecting"
                : workspace.lastConnectionError
                  ? "failed"
                  : "offline",
          reconnecting: pendingKey === workspaceKey && !bridgeable,
          error: workspace.lastConnectionError,
        });
        const busy = presentation.status === "connecting";
        return (
          <SidebarNativeTooltip key={workspaceKey}>
            <button
              type="button"
              data-home-only-workspace={workspaceKey}
              title={workspace.label}
              disabled={
                pendingKey !== null || busy || (!bridgeable && !switcher.reconnectWorkspace)
              }
              onClick={() => void run(workspace)}
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:cursor-wait"
            >
              {remote ? (
                <RemoteConnectionStateIcon presentation={presentation} project />
              ) : (
                <Folder aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
              )}
              <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
              {remote ? (
                <span
                  className={cn(
                    "shrink-0 text-ui-sm",
                    presentation.status === "online"
                      ? "text-remote-foreground-muted"
                      : presentation.foreground,
                  )}
                >
                  {intl.formatMessage({ id: presentation.shortMessageId })}
                  {!bridgeable && !busy
                    ? ` · ${intl.formatMessage({ id: "remote.action.connect" })}`
                    : null}
                </span>
              ) : null}
            </button>
          </SidebarNativeTooltip>
        );
      })}
      {workspaces?.length === 0 ? (
        <p className="px-2.5 py-2 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "webRemoteControl.noSwitchableWorkspaces" })}
        </p>
      ) : null}
      {!workspaces && !error ? (
        <p className="px-2.5 py-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 px-2.5 py-1">
          <p role="alert" className="min-w-0 flex-1 text-ui-sm text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
