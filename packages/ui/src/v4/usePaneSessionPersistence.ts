// pane ↔ session 绑定的本地持久化（pane 绑定属 Layout 层本地 UI 态）。
// 动机：旧链路靠 useTaskRestore（已删）
// 恢复选中 task；v4 下 renderer 刷新后 zustand 选择态归零，若不持久化，刷新会把用户
// 踢回 draft pane，正在输出的会话"消失"。CLI/host 进程在 renderer 刷新时继续运行，
// 恢复选择态后 pane 重订阅即可拿到 snapshot+续流。
// Renderer reload 或 TabStore 标记的启动激活页签可恢复；显式 workspace-only 入口保持草稿。
import { useCallback, useEffect, useRef } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

const STORAGE_PREFIX = "zcode-v4-last-session:v1:";

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

export function readPersistedPaneSession(workspaceKey: string): string | null {
  try {
    return localStorage.getItem(storageKey(workspaceKey));
  } catch {
    return null;
  }
}

export function persistPaneSession(workspaceKey: string, sessionId: string | null): void {
  try {
    if (sessionId) {
      localStorage.setItem(storageKey(workspaceKey), sessionId);
    } else {
      localStorage.removeItem(storageKey(workspaceKey));
    }
  } catch {
    // 无 storage 环境（测试/隐身）静默降级：刷新恢复不可用，但不影响正常会话。
  }
}

/** 查询始终跟随当前 attachment；远端未就绪时不暴露查询入口。 */
export function useRemotePaneSessionLookup(
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string,
) {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId ?? null,
    workspaceIdentity ?? null,
  );
  const lookup = useCallback(
    async (taskId: string) => {
      const meta = await resolution.services.zcodeTaskService.getTaskMeta({
        workspacePath,
        workspaceIdentity,
        taskId,
      });
      return meta !== null;
    },
    [resolution.services, workspacePath, workspaceIdentity],
  );
  return resolution.connectionKind === "remote-ready" ? lookup : undefined;
}

export interface UsePaneSessionPersistenceParams {
  workspaceKey: string;
  activeSessionId: string | null;
  /** startDraft 的显式用户意图代次；大于 0 时 null 表示草稿，不是待恢复。 */
  draftFocusVersion: number;
  /** 手机 /remote 不消费 desktop pane 的本地恢复状态。 */
  enabled?: boolean;
  /** TabStore 恢复的启动激活页签；不用于显式打开项目或手机入口。 */
  restoreOnStartup?: boolean;
  /** 恢复入口：与用户点击任务列表同一条选择路径，保证副作用（已读清理等）一致。 */
  selectSession: (sessionId: string) => void;
  /** 仅已挂回的远端提供权威查询；未就绪时不传，禁止本地 fallback。 */
  lookupSession?: (sessionId: string) => Promise<boolean>;
  onSessionMissing?: () => void;
}

export function shouldRestorePersistedPaneSession(params: {
  activeSessionId: string | null;
  draftFocusVersion: number;
  enabled: boolean;
  rendererReload: boolean;
  restoreOnStartup?: boolean;
}): boolean {
  return (
    params.enabled &&
    (params.rendererReload || params.restoreOnStartup === true) &&
    params.activeSessionId === null &&
    params.draftFocusVersion === 0
  );
}

/**
 * 挂载时恢复上次绑定的 session；此后跟随选择态写入/清除。
 * 只在每个 workspaceKey 首次挂载时恢复一次——用户显式回到 draft（新任务）
 * 属于选择变化，会把持久化键清掉，不会被反复拉回旧会话。
 */
export function usePaneSessionPersistence({
  workspaceKey,
  activeSessionId,
  draftFocusVersion,
  enabled = true,
  restoreOnStartup = false,
  selectSession,
  lookupSession,
  onSessionMissing,
}: UsePaneSessionPersistenceParams): void {
  const restoredKeysRef = useRef<Set<string>>(new Set());
  // 只允许首个 workspace 消费启动选择；等待挂回期间切换项目属于新的用户意图。
  const startupRestoreAvailableRef = useRef(true);
  const pendingRestoreRef = useRef<{
    workspaceKey: string;
    sessionId: string;
  } | null>(null);
  const selectSessionRef = useRef(selectSession);
  selectSessionRef.current = selectSession;
  const onSessionMissingRef = useRef(onSessionMissing);
  onSessionMissingRef.current = onSessionMissing;

  const lastLookupRef = useRef<{
    workspaceKey: string;
    lookupSession: typeof lookupSession;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const attachmentChanged =
      lastLookupRef.current?.workspaceKey !== workspaceKey ||
      lastLookupRef.current?.lookupSession !== lookupSession;
    lastLookupRef.current = { workspaceKey, lookupSession };
    const restoringSession = pendingRestoreRef.current;
    // 新任务 ACK 先于 task-index 异步落盘；只能校验启动恢复或挂回瞬间已有的选择。
    // 稳定 attachment 内的正常选择/新建不能因暂时查空而退回草稿。
    const restoringSelection =
      restoringSession?.workspaceKey === workspaceKey &&
      restoringSession.sessionId === activeSessionId;
    if (!lookupSession || !activeSessionId || (!attachmentChanged && !restoringSelection)) return;
    let cancelled = false;
    void lookupSession(activeSessionId)
      .then((exists) => {
        // 切项目、会话、草稿或 attachment 换代后，旧查询无权清除新的选择。
        if (cancelled || exists) return;
        pendingRestoreRef.current = null;
        persistPaneSession(workspaceKey, null);
        onSessionMissingRef.current?.();
      })
      .catch((error: unknown) => {
        // 断线、超时不等于 task 已删除；保留目标交给原连接恢复流程处理。
        if (!cancelled)
          logger.warn("[usePaneSessionPersistence] 验证恢复会话失败", { workspaceKey, error });
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, draftFocusVersion, enabled, lookupSession, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    if (restoredKeysRef.current.has(workspaceKey)) return;
    restoredKeysRef.current.add(workspaceKey);
    const startupRestoreAvailable = startupRestoreAvailableRef.current;
    startupRestoreAvailableRef.current = false;
    if (
      !shouldRestorePersistedPaneSession({
        activeSessionId,
        draftFocusVersion,
        enabled,
        rendererReload: startupRestoreAvailable && isRendererReloadNavigation(),
        restoreOnStartup: startupRestoreAvailable && restoreOnStartup,
      })
    ) {
      // 显式 workspace-only 或新任务意图不能被上次运行留下的会话选择覆盖。
      if (activeSessionId === null) {
        persistPaneSession(workspaceKey, null);
      }
      return;
    }
    const stored = readPersistedPaneSession(workspaceKey);
    if (stored) {
      pendingRestoreRef.current = { workspaceKey, sessionId: stored };
      selectSessionRef.current(stored);
    }
    // activeSessionId/draftFocusVersion 故意不进依赖：恢复只看 workspace 首次挂载瞬间，
    // 之后的显式新建与选择变化走下面的持久化 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, restoreOnStartup, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    // 恢复完成前不要把初始 null 写进去（会覆盖掉待恢复的值）。
    if (!restoredKeysRef.current.has(workspaceKey)) return;
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore?.workspaceKey === workspaceKey) {
      if (activeSessionId === null) {
        return;
      }
      // 恢复 effect 和持久化 effect 属于同一次 commit，后者闭包仍可能
      // 读到恢复前的 null。等选择态真正回填后再允许写，避免先删掉 reload 恢复键。
      pendingRestoreRef.current = null;
    }
    persistPaneSession(workspaceKey, activeSessionId);
  }, [activeSessionId, enabled, workspaceKey]);
}
