import {
  parseRemoteWorkspaceIdentity,
  type SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface WorkspaceSourceResolutionOptions {
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
}

export function getWorkspaceSourceServerId(
  tab: Pick<WorkspaceTabState, "workspaceIdentity" | "workspacePath" | "remoteTarget">,
  options: WorkspaceSourceResolutionOptions = {},
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
