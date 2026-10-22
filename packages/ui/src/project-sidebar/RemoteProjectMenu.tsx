import { Cloud, FolderOpen, Plus } from "lucide-react";
import { type SourceServerManagementSnapshot } from "@zcode/shared";
import { TID_VIRTUAL_PROJECT_ADD } from "@zcode/shared/test-ids";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";

export function RemoteProjectMenu({
  snapshot,
  onOpenFolder,
  onOpenRemoteWorkspace,
}: {
  snapshot?: SourceServerManagementSnapshot | null;
  onOpenFolder: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_VIRTUAL_PROJECT_ADD}
          className="text-foreground-subtle hover:text-foreground data-[state=open]:text-foreground"
          aria-label={intl.formatMessage({ id: "workspaceSidebar.addProject" })}
        >
          <Plus className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onOpenFolder}>
          <FolderOpen className="size-4" />
          {intl.formatMessage({ id: "workspace.openFolder" })}
        </DropdownMenuItem>
        {onOpenRemoteWorkspace ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Cloud className="size-4" />
              {intl.formatMessage({ id: "workspaceSidebar.openRemoteProject" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64 max-w-[calc(100vw-24px)]">
              {snapshot?.servers.map((server) => {
                const presentation = resolveRemoteConnectionPresentation(
                  getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
                );
                return (
                  <DropdownMenuItem
                    key={server.sourceServerId}
                    data-remote-project-device={server.sourceServerId}
                    disabled={presentation.status === "connecting"}
                    onSelect={() =>
                      onOpenRemoteWorkspace(
                        presentation.profileId
                          ? { preferredProfileId: presentation.profileId }
                          : { preferredSourceServerId: server.sourceServerId },
                      )
                    }
                  >
                    <RemoteConnectionStateIcon presentation={presentation} project />
                    <span className="min-w-0 flex-1 truncate">{server.displayName}</span>
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: presentation.shortMessageId })}
                    </span>
                  </DropdownMenuItem>
                );
              })}
              {snapshot?.servers.length ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => onOpenRemoteWorkspace()}>
                <Plus className="size-4" />
                {intl.formatMessage({ id: "workspaceSidebar.newRemoteConnection" })}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
