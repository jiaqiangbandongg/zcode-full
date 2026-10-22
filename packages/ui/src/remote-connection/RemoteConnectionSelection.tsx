import { useState, type ReactNode } from "react";
import type {
  ConnectionProfile,
  DockerContainerInfo,
  RemoteTarget,
  SourceServerManagementSnapshot,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import {
  BoxIcon,
  CloudIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { findPreferredSourceConnectionProfile } from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  formatConnectionProfileTarget,
  RemoteConnectionStatusTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import { getRecentRemoteWorkspaceHistory } from "@/RemoteConnectionDialogContent.js";
import type { AppSettingsConversationWorkspaceMap } from "@/remote/remoteWorkspaceProjection.js";

const icons = { ssh: ServerIcon, docker: BoxIcon, wsl: TerminalIcon, server: CloudIcon };

function SelectionRow({
  name,
  description,
  kind,
  status,
  onClick,
  disabled,
}: {
  name: string;
  description: string;
  kind: RemoteTarget["kind"];
  status?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const Icon = icons[kind];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-remote-foreground-muted">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-medium">{name}</span>
        <span className="block break-all font-mono text-ui-sm text-remote-foreground-muted">
          {description}
        </span>
      </span>
      {status}
    </button>
  );
}

export function RemoteConnectionSelection({
  snapshot,
  aliases,
  distros,
  containers,
  availableKinds,
  dockerAvailable,
  loading,
  discoveryError,
  onSelectProfile,
  onSelectAlias,
  onSelectTarget,
  onNewConnection,
  remoteConversationWorkspaceBySourceServerId,
}: {
  snapshot: SourceServerManagementSnapshot | null;
  aliases: SSHConfigAliasOption[];
  distros: WSLDistro[];
  containers: DockerContainerInfo[];
  availableKinds: RemoteTarget["kind"][];
  dockerAvailable: boolean | null;
  loading: boolean;
  discoveryError: string;
  onSelectProfile: (profile: ConnectionProfile, path?: string) => void;
  onSelectAlias: (alias: SSHConfigAliasOption) => void;
  onSelectTarget: (target: RemoteTarget) => void;
  onNewConnection: (kind: RemoteTarget["kind"]) => void;
  remoteConversationWorkspaceBySourceServerId: AppSettingsConversationWorkspaceMap;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const matches = (...values: Array<string | undefined>) =>
    values.join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const devices = (snapshot?.servers ?? []).filter((server) =>
    matches(
      server.displayName,
      ...snapshot!.profiles
        .filter((profile) => profile.sourceServerId === server.sourceServerId)
        .map(formatConnectionProfileTarget),
      ...snapshot!.workspaceHistory
        .filter((entry) => entry.sourceServerId === server.sourceServerId)
        .map((entry) => entry.workspacePath),
    ),
  );
  const filteredAliases = aliases.filter((alias) =>
    matches(alias.alias, alias.host, alias.username),
  );
  const filteredDistros = availableKinds.includes("wsl")
    ? distros.filter((distro) => matches(distro.name))
    : [];
  const filteredContainers = dockerAvailable
    ? containers.filter((container) => matches(container.name, container.id, container.image))
    : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-remote-foreground-muted" />
        <Input
          autoFocus
          type="search"
          aria-label={intl.formatMessage({ id: "remote.selection.search" })}
          placeholder={intl.formatMessage({ id: "remote.selection.search" })}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 pl-9"
        />
      </div>
      <div
        className="min-h-0 space-y-4 overflow-y-auto"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          );
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
          event.preventDefault();
        }}
      >
        {devices.length > 0 && snapshot ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.saved" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.saved" })}
            </p>
            {devices.map((server) => {
              const profile = findPreferredSourceConnectionProfile(snapshot, server.sourceServerId);
              const history = getRecentRemoteWorkspaceHistory(
                snapshot.workspaceHistory.filter(
                  (entry) => entry.sourceServerId === server.sourceServerId,
                ),
                remoteConversationWorkspaceBySourceServerId,
              ).slice(0, 3);
              return (
                <div
                  key={server.sourceServerId}
                  data-remote-source-server-id={server.sourceServerId}
                  className="mb-2"
                >
                  <SelectionRow
                    name={server.displayName}
                    description={profile ? formatConnectionProfileTarget(profile) : ""}
                    kind={profile?.transport ?? "ssh"}
                    disabled={!profile}
                    onClick={() => profile && onSelectProfile(profile)}
                    status={
                      <RemoteConnectionStatusTag
                        presentation={resolveRemoteConnectionPresentation(
                          getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
                        )}
                      />
                    }
                  />
                  <div className="ml-13 flex flex-wrap gap-1">
                    {history.map((entry) => {
                      const historyProfile =
                        snapshot.profiles.find(
                          (candidate) =>
                            candidate.profileId === entry.profileId &&
                            candidate.sourceServerId === server.sourceServerId &&
                            candidate.lifecycleState !== "retired",
                        ) ?? profile;
                      return historyProfile ? (
                        <button
                          key={entry.workspacePath}
                          type="button"
                          title={entry.workspacePath}
                          onClick={() => onSelectProfile(historyProfile, entry.workspacePath)}
                          className="flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-ui-sm text-remote-foreground-muted hover:bg-hover"
                        >
                          <FolderIcon className="size-3 shrink-0" />
                          <span className="truncate">{entry.workspacePath}</span>
                        </button>
                      ) : null;
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
        {filteredAliases.length ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.aliases" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.aliases" })}{" "}
              <span className="ml-2 font-mono text-ui-xs text-remote-foreground-muted">
                ~/.ssh/config
              </span>
            </p>
            {filteredAliases.map((alias) => (
              <SelectionRow
                key={alias.alias}
                name={alias.alias}
                kind="ssh"
                description={[
                  alias.username && `${alias.username}@`,
                  alias.host || alias.alias,
                  alias.port && `:${alias.port}`,
                ]
                  .filter(Boolean)
                  .join("")}
                onClick={() => onSelectAlias(alias)}
              />
            ))}
          </section>
        ) : null}
        {filteredDistros.length ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.wsl" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.wsl" })}
            </p>
            {filteredDistros.map((distro) => (
              <SelectionRow
                key={distro.name}
                name={distro.name}
                kind="wsl"
                description="WSL"
                onClick={() => onSelectTarget({ kind: "wsl", distro: distro.name })}
              />
            ))}
          </section>
        ) : null}
        {filteredContainers.length ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.docker" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.docker" })}
            </p>
            {filteredContainers.map((container) => (
              <SelectionRow
                key={container.id}
                name={container.name}
                kind="docker"
                description={container.image}
                onClick={() => onSelectTarget({ kind: "docker", container: container.name })}
              />
            ))}
          </section>
        ) : null}
        {loading ? (
          <p role="status" className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : !devices.length &&
          !filteredAliases.length &&
          !filteredDistros.length &&
          !filteredContainers.length ? (
          <p className="text-pretty text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.selection.empty" })}
          </p>
        ) : null}
        {discoveryError ? (
          <p role="status" className="text-ui-sm text-warning">
            {intl.formatMessage({ id: "remote.optionsLoadFailed" })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {availableKinds.map((kind) => (
            <Button
              key={kind}
              data-testid={`remote-kind-${kind}`}
              type="button"
              variant="outline"
              onClick={() => onNewConnection(kind)}
            >
              <PlusIcon className="size-3.5" />
              {intl.formatMessage({ id: `remote.selection.new.${kind}` })}
            </Button>
          ))}
        </div>
        {availableKinds.includes("server") ? (
          <p className="text-pretty text-ui-xs text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.kind.server.note" })}
          </p>
        ) : null}
      </div>
      <p className="text-pretty border-t border-border pt-3 text-ui-xs text-remote-foreground-muted">
        {intl.formatMessage({ id: "remote.selection.keyboard" })}
      </p>
    </div>
  );
}
