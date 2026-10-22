import { useCallback, useLayoutEffect, useRef } from "react";
import type {
  ProjectSidebarProps,
  ProjectTree,
  IRemoteProjectService,
} from "@/project-sidebar/contract.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { openWebRemoteControlTask } from "@/hooks/useWebRemoteControlTaskOpen.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

/** 打开任务才绑定 workspace；列表 mutation 不借导航创建 scope。 */
export function useProjectTaskNavigation(
  props: ProjectSidebarProps,
  tree: ProjectTree,
  remoteService?: IRemoteProjectService,
): ProjectSidebarProps["onSelectTask"] {
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const latest = useRef({ props, tree, remoteService, activeWorkspaceIdentity });
  useLayoutEffect(() => {
    latest.current = { props, tree, remoteService, activeWorkspaceIdentity };
  });
  return useCallback((path, taskId, identity, remoteSessionId, unreadAt) => {
    const request = ++sequence.current;
    const { props, tree, remoteService, activeWorkspaceIdentity } = latest.current;
    const readFocus = () =>
      props.workspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(props.workspacePath, activeWorkspaceIdentity ?? undefined)
        : undefined;
    const originFocus = readFocus();
    // 同一目录内切换任务或新草稿也会使旧连接失效，不能仅比较 workspace 身份。
    const isCurrent = () =>
      sequence.current === request &&
      latest.current.activeWorkspaceIdentity === activeWorkspaceIdentity &&
      readFocus()?.activeTaskId === originFocus?.activeTaskId &&
      readFocus()?.draftFocusVersion === originFocus?.draftFocusVersion &&
      (!identity ||
        latest.current.tree.tasks.some(
          (task) => task.taskId === taskId && task.workspaceIdentity === identity,
        ));
    const open = async () => {
      const task = tree.tasks.find(
        (item) =>
          item.taskId === taskId &&
          (item.workspaceIdentity || item.workspacePath) === (identity || path),
      );
      if (props.webRemoteControlWorkspaceSwitcher) {
        if (!task) throw new Error("project.task-not-found");
        await openWebRemoteControlTask({
          switcher: props.webRemoteControlWorkspaceSwitcher,
          activeWorkspacePath: props.workspacePath,
          activeWorkspaceIdentity: activeWorkspaceIdentity ?? undefined,
          activeTaskId: null,
          task: {
            ...task,
            workspacePath: path,
            workspaceIdentity: identity,
            taskId,
            unreadAt,
            workspaceLabel: path,
            workspaceKind: task.hostId === "local" ? "local" : "remote",
          },
          markTaskReadOnOpen: true,
          mobileNavigationIntent: "chat",
          onSelectTask: props.onSelectTask,
          onTaskOpen: props.onWebRemoteTaskOpen,
          onSwitchingChange: props.onWebRemoteTaskSwitchingChange,
          setError: (error) => {
            if (error) toast(error);
          },
        });
        return;
      }
      if (identity && task && remoteService) {
        const directory = await remoteService.readDirectory();
        if (!isCurrent()) return;
        if (directory.hosts.some((host) => host.id === task.hostId)) {
          remoteSessionId = await attachRemoteProjectWorkspace({
            hostId: task.hostId,
            workspacePath: path,
            workspaceIdentity: identity,
            remoteService,
            isCurrent,
            findSession: (key) =>
              Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
                (session) => session.workspaceIdentity === key,
              ),
            connect: props.onConnectRemote,
            bind: (sessionId, workspacePath, guard) =>
              props.onSelectRemoteProject(sessionId, workspacePath, undefined, identity, guard),
            cancel: props.onCancelRemoteProject,
          });
        }
      }
      props.onSelectTask(path, taskId, identity, remoteSessionId, unreadAt);
    };
    void open().catch((error) => {
      logger.error("[project-sidebar] 打开任务失败", error);
      toast(String(error));
    });
  }, []);
}
