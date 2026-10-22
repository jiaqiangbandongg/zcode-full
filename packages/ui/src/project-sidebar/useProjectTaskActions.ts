import { useCallback, useContext, useMemo } from "react";
import { mutateProjectTask, type ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** UI 命令适配：复用原 Host 入口，成功后仅处理本窗口展示，不保存会话事实。 */
export function useProjectTaskActions(task: ProjectTask, refresh: () => Promise<void>) {
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const { onPin } = useContext(ProjectTaskListContext);
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const { intl } = useZCodeIntl();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    task.workspacePath,
    undefined,
    task.workspaceIdentity,
  );
  const target = useMemo(
    () => ({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      taskId: task.taskId,
    }),
    [task.workspacePath, task.workspaceIdentity, task.taskId],
  );
  const mutate = useCallback(
    (mutation: ProjectTaskMutation) =>
      mutateProjectTask({ service, controller }, target, mutation, remoteSessionId),
    [service, controller, target, remoteSessionId],
  );
  const report = useCallback(
    (kind: string, error: unknown) => {
      logger.error("[project-sidebar] 任务操作失败", { ...target, kind, error });
      toast(intl.formatMessage({ id: `taskList.${kind}Failed` }));
    },
    [intl, target],
  );
  const rename = useCallback(
    async (_id: string, title: string) => {
      const result = await mutate({ kind: "rename", title });
      await refresh();
      return result ?? null;
    },
    [mutate, refresh],
  );
  const pin = useCallback(
    async (_id: string, pinned: boolean) => {
      try {
        const commit = async () => {
          const result = await mutate({ kind: "pin", pinned });
          await refresh();
          return result ?? null;
        };
        if (onPin) {
          await onPin(task, pinned, commit);
          return null;
        }
        return await commit();
      } catch (error) {
        report("pin", error);
        return null;
      }
    },
    [mutate, refresh, onPin, task, report],
  );
  const archive = useCallback(async () => {
    try {
      const result = await mutate({ kind: "archive", archived: !task.archived });
      // 重构漏掉了归档后的 UI 清理，导致侧栏消失而主区继续显示；与 Header 保持同一语义。
      if (!task.archived) removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
      await refresh();
      return result ?? null;
    } catch (error) {
      report("archive", error);
      return null;
    }
  }, [mutate, refresh, task, removeTaskState, report]);
  const unread = useCallback(
    async (_id: string, value: boolean) => {
      try {
        const result = await mutate(
          value ? { kind: "mark-unread" } : { kind: "mark-read", expectedUnreadAt: task.unreadAt },
        );
        await refresh();
        return result ?? null;
      } catch (error) {
        report("markAsUnread", error);
        return null;
      }
    },
    [mutate, refresh, task.unreadAt, report],
  );
  return { remoteSessionId, rename, pin, archive, unread };
}
