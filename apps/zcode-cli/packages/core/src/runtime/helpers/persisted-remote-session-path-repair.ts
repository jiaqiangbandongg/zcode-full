import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  type RepairRemoteSessionPathsInput,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

export const REMOTE_SESSION_PATH_CORRUPTION_REASON = "remote_session_workspace_path_corrupted";

type PathFieldResolution = "clean" | "repair" | "unrelated" | "unsafe";

type RemoteSessionPathRepairStore = Pick<SessionStorePort, "getSession"> & {
  repairRemoteSessionPaths?: (input: RepairRemoteSessionPathsInput) => Promise<boolean>;
};

function buildKnownPollutedPath(workspacePath: string, workspaceIdentity: string): string {
  return workspacePath === "/" ? `/${workspaceIdentity}` : `${workspacePath}/${workspaceIdentity}`;
}

function resolvePathField(
  value: string,
  workspacePath: string,
  workspaceIdentity: string,
): PathFieldResolution {
  if (value === workspacePath) return "clean";
  if (
    value === workspaceIdentity ||
    value === buildKnownPollutedPath(workspacePath, workspaceIdentity)
  ) {
    return "repair";
  }
  return value.includes(workspaceIdentity) ? "unsafe" : "unrelated";
}

/**
 * 旧版把 workspaceIdentity 当成 cwd，或追加到真实 workspacePath 后落库。
 * 这里只修复两种已知且可证明的污染形态；包含 identity 但前缀不匹配的数据拒绝猜测。
 */
export async function repairPersistedRemoteSessionPaths(
  sessionStore: RemoteSessionPathRepairStore,
  session: SessionInfo,
  options?: { onPersistenceFailure?: (error: unknown) => void },
): Promise<SessionInfo> {
  const workspaceIdentity = session.workspaceID?.trim();
  if (!workspaceIdentity) return session;
  const remoteWorkspace = parseRemoteWorkspaceIdentity(workspaceIdentity);
  if (!remoteWorkspace) {
    if (!workspaceIdentity.startsWith("remote:")) return session;
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Persisted remote session workspace identity is invalid",
      {
        context: {
          directory: session.directory,
          path: session.path,
          reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
          sessionId: session.id,
          workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }

  const directoryResolution = resolvePathField(
    session.directory,
    remoteWorkspace.workspacePath,
    workspaceIdentity,
  );
  const pathResolution =
    session.path === undefined
      ? "clean"
      : resolvePathField(session.path, remoteWorkspace.workspacePath, workspaceIdentity);

  if (directoryResolution === "unsafe" || pathResolution === "unsafe") {
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Remote session workspace path is corrupted and cannot be repaired safely",
      {
        context: {
          directory: session.directory,
          path: session.path,
          reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
          sessionId: session.id,
          workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (directoryResolution !== "repair" && pathResolution !== "repair") return session;

  const repairedSession: SessionInfo = {
    ...session,
    ...(directoryResolution === "repair" ? { directory: remoteWorkspace.workspacePath } : {}),
    ...(pathResolution === "repair" ? { path: remoteWorkspace.workspacePath } : {}),
  };
  const repairInput: RepairRemoteSessionPathsInput = {
    sessionID: session.id,
    workspaceID: workspaceIdentity as RepairRemoteSessionPathsInput["workspaceID"],
    expectedDirectory: session.directory,
    expectedPath: session.path ?? null,
    directory: repairedSession.directory,
    path: repairedSession.path ?? null,
    timeUpdated: session.time.updated,
  };
  if (!sessionStore.repairRemoteSessionPaths) {
    const error = new Error("Session store does not support narrow remote path repair");
    options?.onPersistenceFailure?.(error);
    return repairedSession;
  }
  try {
    const persisted = await sessionStore.repairRemoteSessionPaths(repairInput);
    const refreshed = await sessionStore.getSession(session.id);
    if (persisted) return refreshed ?? repairedSession;
    if (!refreshed) {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session disappeared during path repair",
        {
          context: {
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: session.id,
            workspaceIdentity,
          },
          recoverable: true,
        },
      );
    }

    // CAS 未命中说明路径或 identity 已被并发写入；必须基于新事实重新裁决，不能返回旧快照。
    const refreshedIdentity = refreshed.workspaceID?.trim();
    if (refreshedIdentity !== workspaceIdentity) {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session workspace identity changed during path repair",
        {
          context: {
            directory: refreshed.directory,
            path: refreshed.path,
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: refreshed.id,
            workspaceIdentity: refreshedIdentity,
          },
          recoverable: true,
        },
      );
    }
    const refreshedDirectory = resolvePathField(
      refreshed.directory,
      remoteWorkspace.workspacePath,
      workspaceIdentity,
    );
    const refreshedPath =
      refreshed.path === undefined
        ? "clean"
        : resolvePathField(refreshed.path, remoteWorkspace.workspacePath, workspaceIdentity);
    if (refreshedDirectory === "unsafe" || refreshedPath === "unsafe") {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session workspace path changed to an unsafe value during repair",
        {
          context: {
            directory: refreshed.directory,
            path: refreshed.path,
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: refreshed.id,
            workspaceIdentity,
          },
          recoverable: true,
        },
      );
    }
    if (refreshedDirectory !== "repair" && refreshedPath !== "repair") return refreshed;

    // adapter 拒绝 CAS 且持久值仍是同一已知污染形态时，只使用基于最新元数据构造的
    // 确定性内存修复；下次冷读会重试，不覆盖任何并发 session 事实。
    options?.onPersistenceFailure?.(new Error("Remote session path repair CAS did not match"));
    return {
      ...refreshed,
      ...(refreshedDirectory === "repair" ? { directory: remoteWorkspace.workspacePath } : {}),
      ...(refreshedPath === "repair" ? { path: remoteWorkspace.workspacePath } : {}),
    };
  } catch (error) {
    if (isCoreError(error) && error.type === CoreErrorType.SessionCorrupted) {
      throw error;
    }
    // 路径已可确定时，暂时性写盘失败不应继续阻断本次恢复；下次读取仍会重试。
    options?.onPersistenceFailure?.(error);
    return repairedSession;
  }
}
