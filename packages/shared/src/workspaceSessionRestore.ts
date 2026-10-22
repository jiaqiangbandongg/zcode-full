import type { PersistedWorkspaceSessionEntry } from "./protocol.js";

function findLocalWorkspaceSessionIndex(
  persistedSessions: readonly PersistedWorkspaceSessionEntry[],
  startIndex: number,
  endIndexExclusive: number,
): number | null {
  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    if (persistedSessions[index]?.kind === "local") {
      return index;
    }
  }

  return null;
}

export function resolveStartupLocalWorkspaceSessionIndex(
  persistedSessions: readonly PersistedWorkspaceSessionEntry[],
  lastActiveTabIndex: number | undefined,
): number | null {
  if (persistedSessions.length === 0) {
    return null;
  }

  const startIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), persistedSessions.length - 1);
  const nextLocalIndex = findLocalWorkspaceSessionIndex(
    persistedSessions,
    startIndex,
    persistedSessions.length,
  );
  if (nextLocalIndex != null) {
    return nextLocalIndex;
  }

  // Bugfix: 启动时远程 workspace 只恢复为断连 tab，本地 host 不能把它当作可预热目标。
  // 从上次 active 位置找不到本地项时回绕；这里只选 Main 本地预热目标，Renderer 另按持久化索引恢复导航。
  return findLocalWorkspaceSessionIndex(persistedSessions, 0, startIndex);
}
