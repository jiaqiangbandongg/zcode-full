import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type RemoteTarget,
} from "@zcode/shared";
import type { BotRemoteWorkspaceResolver } from "@zcode/services";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import type { WindowRemoteLogicalSessionSnapshot } from "./windowRemoteConnectionRegistry.js";

/** Bot 与 Renderer 共用 Directory/Registry 的事实，旧回退快照不再决定 R3 路由。 */
export async function resolveBotRemoteWorkspace(
  workspace: Parameters<BotRemoteWorkspaceResolver>[0],
  purpose: Parameters<BotRemoteWorkspaceResolver>[1],
  deps: {
    directory: Pick<SourceServerDirectory, "snapshot" | "resolveProfileTarget">;
    listSessions(): WindowRemoteLogicalSessionSnapshot[];
    getLegacyServerTarget?(identity: string): Promise<RemoteTarget | null>;
  },
): ReturnType<BotRemoteWorkspaceResolver> {
  const identity = workspace.workspaceIdentity.trim();
  const parsed = parseRemoteWorkspaceIdentity(identity);
  if (!parsed) return null;
  const snapshot = await deps.directory.snapshot();
  let sourceServerId = parsed.sourceServerId;
  let workspacePath = parsed.workspacePath;
  if (parsed.kind !== "server") {
    const historical = snapshot.workspaceHistory.filter(
      (entry) => entry.legacyWorkspaceIdentity === identity && entry.sourceServerId,
    );
    const sources = new Set(historical.map((entry) => entry.sourceServerId!));
    // retired Profile 也参与消歧，避免相同 host/port 被新设备占用后把旧授权移给新 Source。
    for (const profile of snapshot.profiles) {
      if (
        profile.sourceServerId &&
        buildRemoteWorkspaceIdentity(parsed.workspacePath, profile.target) === identity
      )
        sources.add(profile.sourceServerId);
    }
    if (sources.size !== 1) return null;
    sourceServerId = [...sources][0];
    const paths = new Set(historical.map((entry) => entry.workspacePath));
    if (paths.size > 1) return null;
    workspacePath = [...paths][0] ?? parsed.workspacePath;
  }
  const server = snapshot.servers.find((candidate) => candidate.sourceServerId === sourceServerId);
  // dev server 没有 Source Directory；保留显式 server target 的既有路由，不猜 SSH 线路。
  if (!server) {
    if (parsed.kind !== "server") return null;
    const sessions = deps
      .listSessions()
      .filter(
        (session) =>
          session.target.kind === "server" &&
          session.workspaceIdentity === identity &&
          session.workspacePath === workspace.workspacePath &&
          session.state === "online" &&
          session.sourceAvailability === "online",
      );
    if (sessions.length > 1) return null;
    const session = sessions[0];
    const target = session?.target ?? (await deps.getLegacyServerTarget?.(identity));
    return target?.kind === "server"
      ? {
          ...workspace,
          workspaceIdentity: identity,
          target,
          ...(session
            ? { runtimeKey: JSON.stringify([session.remoteSessionId, session.generation]) }
            : {}),
        }
      : null;
  }
  if (
    workspace.workspacePath !== workspacePath &&
    !snapshot.workspaceHistory.some(
      (entry) =>
        (entry.workspaceIdentity === identity || entry.legacyWorkspaceIdentity === identity) &&
        entry.sourceServerId === sourceServerId &&
        entry.workspacePath === workspacePath,
    )
  )
    return null;
  const stableIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: server.sourceServerId,
    workspacePath,
  });
  const sessions = deps
    .listSessions()
    .filter(
      (session) =>
        session.workspaceIdentity === stableIdentity &&
        session.workspacePath === workspacePath &&
        session.state === "online" &&
        session.sourceAvailability === "online",
    );
  if (sessions.length > 1) return null;
  const session = sessions[0];
  if (session)
    return {
      workspacePath,
      workspaceIdentity: stableIdentity,
      target: session.target,
      runtimeKey: JSON.stringify([session.remoteSessionId, session.generation]),
    };
  const profiles = snapshot.profiles
    .filter(
      (profile) =>
        profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
    )
    .sort((a, b) => {
      if (a.profileId === server.preferredProfileId) return -1;
      if (b.profileId === server.preferredProfileId) return 1;
      return (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0);
    });
  const profile = profiles[0];
  if (!profile) return null;
  return {
    workspacePath,
    workspaceIdentity: stableIdentity,
    target:
      purpose === "reconnect"
        ? await deps.directory.resolveProfileTarget(profile.profileId)
        : profile.target,
  };
}
