import {
  parseRemoteWorkspaceIdentity,
  type SourceServerConnectionStateSnapshot,
  type SourceServerManagementSnapshot,
  type SourceServerRecord,
  type SourceServerWorkspaceHistoryEntry,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  buildAggregatedSourceStatusMap,
  type AggregatedSourceStatus,
} from "@/lib/remoteConnectionPresentation.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

// 旧侧栏 Source 分组（lib/workspaceSourceGroups.ts）随 Group 视图下线；这是其中唯一仍被
// 远端投影使用的推导，迁到这里以免为 3 行逻辑保留 250 行死文件。
function getWorkspaceSourceServerId(
  tab: Pick<WorkspaceTabState, "workspaceIdentity" | "workspacePath" | "remoteTarget">,
  options: { workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[] } = {},
): string | null {
  // Direct URL Server 不属于 Source 管理域；不能仅凭相同的 identity 格式冒充 Source 设备。
  if (tab.remoteTarget?.kind === "server") return null;
  const parsed = tab.workspaceIdentity ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity) : null;
  if (parsed?.kind === "server") return parsed.sourceServerId ?? null;

  const legacyWorkspaceIdentity = tab.workspaceIdentity?.trim();
  if (!legacyWorkspaceIdentity) return null;
  const matchingSourceServerIds = new Set(
    options.workspaceHistory
      ?.filter(
        (entry) =>
          entry.workspacePath === tab.workspacePath &&
          entry.legacyWorkspaceIdentity?.trim() === legacyWorkspaceIdentity &&
          Boolean(entry.sourceServerId?.trim()),
      )
      .map((entry) => entry.sourceServerId!.trim()) ?? [],
  );
  // 修复原因：旧版本回退兼容会在 lastWorkspaceSession 中保留 route identity，
  // 即使 Source Directory 已经确认设备，侧栏也会把同一个 tab 再画成“待识别线路”。
  // 这里只消费 Directory 已持久化的精确 legacy alias，不改写旧数据，也不按 hostname/账号猜测；
  // 若换代历史产生歧义则继续保持待识别，避免把 workspace 归到错误设备。
  return matchingSourceServerIds.size === 1
    ? (matchingSourceServerIds.values().next().value ?? null)
    : null;
}

export type WorkspaceAttachmentViewState =
  | "disconnected"
  | "attaching"
  | "ready"
  | "recovering"
  | "failed";

export interface RemoteWorkspaceAttachmentFact {
  remoteSessionId: string;
  workspaceKey: string;
  sourceServerId?: string;
  state?: WorkspaceAttachmentViewState;
}

export interface RemoteDeviceView {
  sourceServerId: string;
  displayName: string;
  osUser?: string;
  hostname?: string;
  aggregatedStatus: AggregatedSourceStatus;
  profiles: SourceServerManagementSnapshot["profiles"];
  knownProjects: SourceServerWorkspaceHistoryEntry[];
}

export interface RemoteOpenWorkspaceView {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  purpose: WorkspacePurpose;
  sourceServerId?: string;
  sourceDisplayName?: string;
  sourceStatus?: AggregatedSourceStatus;
  remoteSessionId?: string;
  attachmentState: WorkspaceAttachmentViewState;
  lastConnectionError?: string;
}

export interface RemoteExecutionContextView {
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspacePurpose: WorkspacePurpose;
  sourceServerId?: string;
  sourceDisplayName?: string;
  attachmentState?: WorkspaceAttachmentViewState;
}

export interface RemoteWorkspaceProjection {
  devices: RemoteDeviceView[];
  openWorkspaces: RemoteOpenWorkspaceView[];
  projectHistory: SourceServerWorkspaceHistoryEntry[];
  executionContexts: RemoteExecutionContextView[];
}

export interface RemoteWorkspaceProjectionInput {
  managementSnapshot?: SourceServerManagementSnapshot | null;
  tabs: readonly WorkspaceTabState[];
  attachments?: readonly RemoteWorkspaceAttachmentFact[];
  remoteConversationWorkspaceBySourceServerId?: AppSettingsConversationWorkspaceMap;
}

export type AppSettingsConversationWorkspaceMap = Readonly<
  Record<string, { workspacePath: string; lastResolvedAt: number }>
>;

function stateForOpenWorkspace(
  tab: WorkspaceTabState,
  attachment: RemoteWorkspaceAttachmentFact | undefined,
  sourceStatus: AggregatedSourceStatus | undefined,
): WorkspaceAttachmentViewState {
  if (attachment?.state) return attachment.state;
  if (!tab.remoteSessionId) return "disconnected";
  if (sourceStatus === "offline" || sourceStatus === "failed") return "disconnected";
  // remoteSessionId 只代表逻辑 session 存在；没有可信 attachment fact 时仍可能处于
  // bind/reattach 中，不能把“Source online”提前投影成 workspace ready。
  return "attaching";
}

export function isRemoteWorkspaceTab(tab: WorkspaceTabState): boolean {
  return Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
}

export function buildRemoteWorkspaceProjection(
  input: RemoteWorkspaceProjectionInput,
): RemoteWorkspaceProjection {
  const snapshot = input.managementSnapshot ?? null;
  const statuses = buildAggregatedSourceStatusMap(snapshot);
  const serverById = new Map(
    snapshot?.servers.map((server) => [server.sourceServerId, server]) ?? [],
  );
  const attachments = input.attachments ?? [];
  const attachmentBySessionId = new Map(
    attachments.map((attachment) => [attachment.remoteSessionId, attachment]),
  );
  const attachmentByWorkspaceKey = new Map(
    attachments.map((attachment) => [attachment.workspaceKey, attachment]),
  );

  const devices = (snapshot?.servers ?? []).map((server: SourceServerRecord) => ({
    sourceServerId: server.sourceServerId,
    displayName: server.displayName,
    ...(server.osUser ? { osUser: server.osUser } : {}),
    ...(server.hostname ? { hostname: server.hostname } : {}),
    aggregatedStatus: statuses.get(server.sourceServerId) ?? "offline",
    profiles: (snapshot?.profiles ?? []).filter(
      (profile) =>
        profile.sourceServerId === server.sourceServerId && profile.lifecycleState !== "retired",
    ),
    knownProjects: (snapshot?.workspaceHistory ?? []).filter(
      (entry) =>
        entry.sourceServerId === server.sourceServerId &&
        input.remoteConversationWorkspaceBySourceServerId?.[server.sourceServerId]
          ?.workspacePath !== entry.workspacePath,
    ),
  }));

  // Bug 根因：Projection 之前把 local tab 也当成 open remote workspace，
  // 随后因没有 remoteSessionId 被投影成 disconnected。openWorkspaces 是远端集合，
  // local tab 必须只留在 executionContexts，避免未来消费者把本地 workspace 当断连设备。
  const remoteTabs = input.tabs.filter(isRemoteWorkspaceTab);
  const openWorkspaces = remoteTabs.map((tab): RemoteOpenWorkspaceView => {
    const workspaceKey = buildWorkspaceSessionKey(tab);
    const sourceServerId = getWorkspaceSourceServerId(tab, {
      workspaceHistory: snapshot?.workspaceHistory,
    });
    const source = sourceServerId ? serverById.get(sourceServerId) : undefined;
    const sourceStatus = sourceServerId ? statuses.get(sourceServerId) : undefined;
    const attachment =
      (tab.remoteSessionId ? attachmentBySessionId.get(tab.remoteSessionId) : undefined) ??
      attachmentByWorkspaceKey.get(workspaceKey);
    return {
      workspaceKey,
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      purpose: tab.workspacePurpose ?? "project",
      ...(sourceServerId ? { sourceServerId } : {}),
      ...(source?.displayName ? { sourceDisplayName: source.displayName } : {}),
      ...(sourceStatus ? { sourceStatus } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      attachmentState: stateForOpenWorkspace(tab, attachment, sourceStatus),
    };
  });

  const projectHistory = (snapshot?.workspaceHistory ?? []).filter(
    (entry) =>
      entry.sourceServerId === undefined ||
      input.remoteConversationWorkspaceBySourceServerId?.[entry.sourceServerId]?.workspacePath !==
        entry.workspacePath,
  );

  const openWorkspaceByKey = new Map(
    openWorkspaces.map((workspace) => [workspace.workspaceKey, workspace]),
  );
  const executionContexts: RemoteExecutionContextView[] = input.tabs.map((tab) => {
    const open = isRemoteWorkspaceTab(tab)
      ? openWorkspaceByKey.get(buildWorkspaceSessionKey(tab))
      : undefined;
    return {
      kind: isRemoteWorkspaceTab(tab) ? "remote" : "local",
      workspaceKey: buildWorkspaceSessionKey(tab),
      workspacePath: tab.workspacePath,
      workspacePurpose: tab.workspacePurpose ?? "project",
      ...(open?.sourceServerId ? { sourceServerId: open.sourceServerId } : {}),
      ...(open?.sourceDisplayName ? { sourceDisplayName: open.sourceDisplayName } : {}),
      ...(open ? { attachmentState: open.attachmentState } : {}),
    };
  });

  return { devices, openWorkspaces, projectHistory, executionContexts };
}

export function resolveSourceStatus(
  snapshot: SourceServerManagementSnapshot | null | undefined,
  sourceServerId: string,
): AggregatedSourceStatus {
  return buildAggregatedSourceStatusMap(snapshot).get(sourceServerId) ?? "offline";
}

export function isSourceConnectionStateOnline(
  states: readonly SourceServerConnectionStateSnapshot[],
  sourceServerId: string,
): boolean {
  return states.some(
    (state) => state.sourceServerId === sourceServerId && state.state === "online",
  );
}
