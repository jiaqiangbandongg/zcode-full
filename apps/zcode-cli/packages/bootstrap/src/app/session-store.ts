import { isAbsolute, resolve } from "node:path";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  parseModelSelectionValue,
  type SessionId,
  type SessionStorePort,
  type CollaborationMode,
  type InputHistoryStorePort,
  type LocalSettingStorePort,
  type ProjectId,
} from "@zcode/contracts";
import type { ModelSelection } from "@zcode/provider";
import { isHighspeedProviderId } from "@zcode/shared";
import { StartupTimer } from "../startup-logging.js";

export function isClosableSessionStore(
  store: SessionStorePort,
): store is SessionStorePort & { close(): void } {
  return "close" in store && typeof store.close === "function";
}

export function asInputHistoryStore(store: SessionStorePort): InputHistoryStorePort | undefined {
  const candidate = store as Partial<InputHistoryStorePort>;
  return typeof candidate.recordInputHistory === "function" &&
    typeof candidate.recallPreviousInputHistory === "function"
    ? (store as SessionStorePort & InputHistoryStorePort)
    : undefined;
}

export function asLocalSettingStore(store: SessionStorePort): LocalSettingStorePort | undefined {
  const candidate = store as Partial<LocalSettingStorePort>;
  return typeof candidate.getProjectPermissionMode === "function" &&
    typeof candidate.saveProjectPermissionMode === "function"
    ? (store as SessionStorePort & LocalSettingStorePort)
    : undefined;
}

export function readProjectPermissionMode(
  store: LocalSettingStorePort | undefined,
  projectID: ProjectId,
): CollaborationMode | undefined {
  if (!store) return undefined;
  const mode = store.getProjectPermissionMode(projectID);
  return isPromiseLike(mode) ? undefined : (mode ?? undefined);
}

/** 读取 Session 自己最近一次显式选择；恢复时它高于 Environment 默认值。 */
export async function readSessionModelSelection(
  store: Pick<SessionStorePort, "sessionEntries">,
  sessionID: SessionId,
): Promise<ModelSelection | undefined> {
  if (!store.sessionEntries) return undefined;
  const entries = await store.sessionEntries({
    sessionID,
    type: SESSION_ENTRY_MODEL_SELECTION,
  });
  const data = entries.at(-1)?.data;
  const complete = parseModelSelectionValue(data);
  if (complete) return residentModelSelection(complete);
  // reasoning 的错误类型不能抹掉可恢复的当前模型身份；这里只读取新字段，
  // 不借旧 thoughtLevel/消息/default 补值。执行前仍由 Registry 严格校验。
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const current = data as Record<string, unknown>;
    return residentModelSelection(
      parseModelSelectionValue({ providerId: current.providerId, modelId: current.modelId }),
    );
  }
  return undefined;
}

/**
 * 加速卡 Provider 是 `selectionScope=execution` 的单轮执行身份，永远不能当作会话常驻选型
 * （highspeed-card-spec §5.1）。旧版本分叉会把分叉点消息上的加速选型写进 child 的
 * model_selection entry，这类会话恢复后常驻在一个无凭据、且不在模型列表里的隐藏 Provider 上，
 * 还会经 restoredModelSelection 投影成界面选中态与 contextWindow。读取时直接丢弃，
 * 会话回到「未绑定」而不是借默认模型补齐（恢复语义见 runtime-config 的 initialModelSelection），
 * 由用户重新选一次模型，避免隐藏身份继续在存储与投影里传播。
 */
function residentModelSelection(selection: ModelSelection | undefined): ModelSelection | undefined {
  if (!selection) return undefined;
  return isHighspeedProviderId(selection.providerId) ? undefined : selection;
}

export function closeSessionStore(store: SqliteSessionStore): void {
  store.close();
}

export async function openStartupSessionStore(
  configResult: ConfigResult,
  startupTimer: StartupTimer,
): Promise<SqliteSessionStore> {
  const dbPath = getSessionDbPath(configResult);
  startupTimer.start("ZCode SQLite migration started", {
    context: { dbPath },
    event: "bootstrap.app.startup.sqlite_migration.started",
    stage: "migrate_session_db",
  });
  const store = await SqliteSessionStore.openStartup(
    { dbPath },
    {
      onProgress: async (progress) => {
        startupTimer.mark("SQLite startup state", {
          event: "bootstrap.app.startup.storage_state",
          stage: "migrate_session_db",
          context: { ...progress },
        });
      },
    },
  );
  startupTimer.mark("ZCode SQLite migration completed", {
    context: { dbPath },
    event: "bootstrap.app.startup.sqlite_migration.completed",
    stage: "migrate_session_db",
  });
  return store;
}

export function getSessionDbPath(configResult: ConfigResult, workingDirectory?: string): string {
  const configured = configResult.config.storage.sessionDbPath;
  // 存储 Worker 不能 chdir；显式传入业务实际 cwd，保持相对路径与普通 Agent 一致。
  if (workingDirectory && !isAbsolute(configured) && !configured.startsWith("~/"))
    return resolve(workingDirectory, configured);
  return resolvePath(configured);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
