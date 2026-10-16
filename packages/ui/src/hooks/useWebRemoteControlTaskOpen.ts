import { useCallback, useMemo, useState } from "react";
import type {
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function buildWebRemoteControlTaskRowKey(task: WebRemoteControlTaskTarget): string {
  return `${resolveWebRemoteControlWorkspaceKey(task)}:${task.taskId}`;
}

interface OpenWebRemoteControlTaskOptions {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  task: WebRemoteControlTaskTarget;
  markTaskReadOnOpen?: boolean;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onNavigateToChat?: () => void;
  onTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onSwitchingChange?: (switching: boolean) => void;
  onNavigateHome?: () => void;
  setSwitchingTaskKey?: (taskKey: string | null) => void;
  setError?: (error: string | null) => void;
}

function isDisconnectedRemoteWorkspaceBridgeError(message: string): boolean {
  return message.includes("远程工作区尚未连接") || message.includes("请先重连");
}

export async function openWebRemoteControlTask({
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  setError,
  setSwitchingTaskKey,
  switcher,
  task,
}: OpenWebRemoteControlTaskOptions): Promise<void> {
  const activeWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  const isCrossWorkspace = taskWorkspaceKey !== activeWorkspaceKey;
  onTaskOpen?.({ crossWorkspace: isCrossWorkspace });

  if (!isCrossWorkspace) {
    if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {
      const logReadFailure = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // 未读写入失败不能阻止用户打开任务；返回首页后由权威 tasks-index 快照恢复蓝点。
        logger.warn("[useWebRemoteControlTaskOpen] 标记手机端 task 已读失败", {
          error: message,
          taskId: task.taskId,
          workspaceKey: taskWorkspaceKey,
        });
      };
      try {
        // 修复原因：手机首页蓝点来自 desktop 推送快照，当前 Root 的 query cache
        // 可能尚未水合。这里显式表达“用户已查看”，不能继续依赖桌面选择逻辑的 cache 命中。
        void switcher.markTaskRead(task).catch(logReadFailure);
      } catch (err) {
        logReadFailure(err);
      }
    }
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    try {
      await switcher.updateMobileViewState?.(taskWorkspaceKey, task.taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[useWebRemoteControlTaskOpen] 更新手机端查看状态失败", {
        error: message,
        taskId: task.taskId,
        workspaceKey: taskWorkspaceKey,
      });
    }
    onNavigateToChat?.();
    return;
  }

  const rowKey = buildWebRemoteControlTaskRowKey(task);
  onSwitchingChange?.(true);
  setSwitchingTaskKey?.(rowKey);
  setError?.(null);
  logger.info("[useWebRemoteControlTaskOpen] 开始切换远控 workspace", {
    taskId: task.taskId,
    workspaceKey: taskWorkspaceKey,
  });

  try {
    await switcher.switchWorkspace(taskWorkspaceKey, {
      taskId: task.taskId,
      ...(mobileNavigationIntent ? { mobileNavigationIntent } : {}),
      ...(markTaskReadOnOpen && typeof task.unreadAt === "number"
        ? { markTaskReadExpectedUnreadAt: task.unreadAt }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[useWebRemoteControlTaskOpen] 打开远程 task 失败", {
      error: message,
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
    setSwitchingTaskKey?.(null);
    onSwitchingChange?.(false);
    if (isDisconnectedRemoteWorkspaceBridgeError(message)) {
      // Bugfix: 手机端重连后 workspace list 可能还没同步到新的 remoteSessionId，
      // 此时打开 task 会被 desktop main 拒绝创建 bridge。这里退回任务首页，
      // 让用户看到断开态和重连按钮，而不是停在聊天页错误提示里。
      onNavigateHome?.();
      return;
    }
    setError?.(message);
  }
}

export function useWebRemoteControlTaskOpen({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  switcher,
}: Omit<OpenWebRemoteControlTaskOptions, "setError" | "setSwitchingTaskKey" | "task">) {
  const [switchingTaskKey, setSwitchingTaskKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspaceKey = useMemo(
    () =>
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath],
  );
  const openTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      void openWebRemoteControlTask({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        markTaskReadOnOpen,
        mobileNavigationIntent,
        onNavigateHome,
        onNavigateToChat,
        onSelectTask,
        onSwitchingChange,
        onTaskOpen,
        setError,
        setSwitchingTaskKey,
        switcher,
        task,
      });
    },
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      markTaskReadOnOpen,
      mobileNavigationIntent,
      onNavigateHome,
      onNavigateToChat,
      onSelectTask,
      onSwitchingChange,
      onTaskOpen,
      switcher,
    ],
  );

  return {
    activeWorkspaceKey,
    error,
    openTask,
    switchingTaskKey,
  };
}
