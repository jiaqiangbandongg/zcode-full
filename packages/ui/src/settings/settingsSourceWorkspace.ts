import { isRemoteWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export function workspaceBelongsToSettingsSource(
  tab: Pick<WorkspaceTabState, "workspaceIdentity">,
  sourceServerId: string | null,
): boolean {
  const identity = tab.workspaceIdentity?.trim();
  if (!identity) return sourceServerId === null;
  const parsed = parseRemoteWorkspaceIdentity(identity);
  if (sourceServerId === null) return !isRemoteWorkspaceIdentity(identity);
  return parsed?.kind === "server" && parsed.sourceServerId === sourceServerId;
}

export function filterWorkspaceTabsForSettingsSource<
  T extends Pick<WorkspaceTabState, "workspaceIdentity">,
>(tabs: readonly T[], sourceServerId: string | null): T[] {
  return tabs.filter((tab) => workspaceBelongsToSettingsSource(tab, sourceServerId));
}

export function buildSourceSettingsProjectionKey(
  workspacePath: string | null | undefined,
  workspaceIdentity?: string,
  authorityKey?: string,
): string {
  const targetKey = workspaceIdentity?.trim() || workspacePath || "";
  const authority = authorityKey?.trim();
  return authority ? `${authority}\0${targetKey}` : targetKey;
}

export interface SourceSettingsHomeSnapshot {
  sourceServerId: string;
  homedir: string;
}

export interface SourceSettingsValueSnapshot<T> {
  sourceServerId: string;
  value: T;
}

export function resolveSettingsSourceServerSelection(params: {
  pendingTarget: { sourceServerId: string | null } | undefined;
  persistedSourceServerId: string | null | undefined;
  sourceServerIds: readonly string[];
}): string | null {
  // Bug 原因：显式本机跳转以前被折叠成 undefined，随后错误回退到旧远端偏好。
  // pendingTarget 是否存在才表示有无导航意图；其中 null 是有效的本机 Source。
  const preferred =
    params.pendingTarget === undefined
      ? (params.persistedSourceServerId ?? null)
      : params.pendingTarget.sourceServerId;
  return preferred && params.sourceServerIds.includes(preferred) ? preferred : null;
}

export function resolveSourceSettingsValue<T>(
  snapshot: SourceSettingsValueSnapshot<T> | null,
  selectedSourceServerId: string | null,
): T | null {
  return snapshot?.sourceServerId === selectedSourceServerId ? snapshot.value : null;
}

export function isSettingsSourceOnline(
  snapshot: {
    profiles: ReadonlyArray<{
      profileId: string;
      sourceServerId?: string;
      lifecycleState?: "active" | "retired";
    }>;
    states: ReadonlyArray<{ profileId: string; state: string }>;
  } | null,
  sourceServerId: string | null,
): boolean {
  if (!snapshot || !sourceServerId) return false;
  const activeProfileIds = new Set(
    snapshot.profiles
      .filter(
        (profile) =>
          profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
      )
      .map((profile) => profile.profileId),
  );
  return snapshot.states.some(
    (state) => activeProfileIds.has(state.profileId) && state.state === "online",
  );
}

export function resolveSourceSettingsHomeDir(
  snapshot: SourceSettingsHomeSnapshot | null,
  selectedSourceServerId: string | null,
): string | undefined {
  return snapshot?.sourceServerId === selectedSourceServerId ? snapshot.homedir : undefined;
}

export function resolveSettingsUserScopeTarget(params: {
  sourceServerId: string | null;
  sourceHomeDir?: string;
  projectWorkspacePath?: string;
  projectWorkspaceIdentity?: string;
}): { workspacePath?: string; workspaceIdentity?: string; authorityKey?: string } {
  if (params.sourceServerId) {
    // user scope 不携 workspace identity；sourceServerId 只作为 renderer cache authority。
    return {
      workspacePath: params.sourceHomeDir,
      workspaceIdentity: undefined,
      authorityKey: `source-settings:${params.sourceServerId}`,
    };
  }
  return {
    workspacePath: params.projectWorkspacePath,
    workspaceIdentity: params.projectWorkspaceIdentity,
  };
}
