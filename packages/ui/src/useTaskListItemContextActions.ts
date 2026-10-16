import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  providerConfigFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
  handleOpenProviderConfig: () => Promise<void>;
}

export function resolveProviderConfigOpenTargetPath(
  path: string,
  exists: boolean,
): string {
  if (exists) {
    return path;
  }

  // Bugfix: provider 主配置文件首次还没落盘时，更多菜单之前会把“前往配置”完全禁用，
  // 用户既看不到承载配置的目录，也没法就地补齐文件。这里改成回退打开父目录，
  // 保留“前往配置”的导航语义，并避免把一个不存在的文件路径直接交给编辑器。
  const trimmedPath = path.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(
    trimmedPath.lastIndexOf("/"),
    trimmedPath.lastIndexOf("\\"),
  );

  if (lastSeparatorIndex < 0) {
    return path;
  }

  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? path;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}\\`;
  }

  return parentPath || path;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
  loadProviderConfig = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (
      desc: { id: string },
      values?: Record<string, string>,
    ) => string;
  };
  loadTaskPaths?: boolean;
  loadProviderConfig?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskProvider = provider ?? "glm";
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // task session/log 路径只用于右键菜单项；菜单未打开时不要在列表重排中批量触发 RPC。
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspacePath,
    taskProvider,
    remoteSessionId,
    workspaceIdentity,
    {
      // Bugfix: 远程 workspace 里“前往配置”用于打开本机可编辑的 provider 配置入口。
      // 之前这里跟随 remote zcodeTaskService 取路径，会返回远端机器上的绝对路径（例如 /root/...），
      // 再交给本机平台层打开时就会定位到错误位置或直接失败。
      // 这里远程场景强制改走 base service，保证 UI 拿到的是本机可打开的配置路径。
      serviceScope: remoteSessionId ? "base" : "workspace",
      // Bugfix: 任务列表里每个 item 都会挂载右键菜单动作；如果挂载时就读取 provider 配置路径，
      // 远程 workspace 会按任务数量放大 base RPC 和日志。这里改成菜单真正打开时才加载。
      enabled: loadProviderConfig,
    },
  );

  const handleCopyText = useCallback(
    async (label: string, value: string | null) => {
      if (!value) {
        return;
      }

      try {
        await navigator.clipboard.writeText(value);
        logger.info(`[TaskListItem] ${label} 已复制: ${value}`);
      } catch (error) {
        logger.warn("[TaskListItem] 复制文本失败", {
          label,
          value,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [],
  );

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId ||
        workspaceIdentity?.trim() ||
        workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // 远程项目路径不是宿主机路径。无法精确解析为 WSL 时必须失败关闭，
        // 避免 SSH/Docker 的 Linux 路径误落到原生 Windows、macOS 或 Linux 文件管理器。
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL workspace 路径失败", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // Header / task 菜单里的“Open in Finder”语义应该是打开项目目录。
      // 之前这里误绑到了 task session 文件路径，菜单可用性也跟着 task 快照文件走，
      // 一旦 session 文件还没解析出来，用户会看到 Finder 入口莫名不可用。
      // 这里统一改成始终打开 workspacePath，让行为和“Copy path=项目路径”保持一致。
      logger.warn("[TaskListItem] 打开 workspace 路径失败", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  const handleOpenProviderConfig = useCallback(async () => {
    if (!providerConfigFile.path) {
      return;
    }

    const openTargetPath = resolveProviderConfigOpenTargetPath(
      providerConfigFile.path,
      providerConfigFile.exists,
    );

    try {
      const preferredEditorId = readLastSelectedEditorId();
      const editors = await platform.getInstalledEditors();
      const sortedEditors = sortInstalledEditorsForOpenWith(editors);
      const preferredEditor =
        sortedEditors.find((editor) => editor.id === preferredEditorId) ??
        sortedEditors[0] ??
        null;

      // Bugfix: task 右键菜单位于侧边栏，拿不到 Header 里的 selectedEditor 本地状态。
      // 如果这里直接硬编码某个编辑器，Header 和侧边栏会对“Go to config”走出两条不同路径。
      // 这里改为读取持久化的 editor 偏好，和 Header editor 按钮共用同一份用户选择。
      if (preferredEditor) {
        const result = await platform.openInEditor(
          preferredEditor.id,
          openTargetPath,
        );
        if (result.success) {
          return;
        }
      }

      const result = await platform.openInFileManager(openTargetPath);
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 provider 配置失败", {
          taskId,
          provider: taskProvider,
          path: providerConfigFile.path,
          openTargetPath,
          error: result.error ?? "unknown-error",
        });
      }
    } catch (error) {
      logger.warn("[TaskListItem] 打开 provider 配置失败", {
        taskId,
        provider: taskProvider,
        path: providerConfigFile.path,
        openTargetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    platform,
    providerConfigFile.exists,
    providerConfigFile.path,
    taskId,
    taskProvider,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (
    desc: { id: string },
    values?: Record<string, string>,
  ) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
