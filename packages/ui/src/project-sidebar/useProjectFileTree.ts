import { useCallback, useEffect, useRef } from "react";
import type {
  IRemoteProjectService,
  ProjectSidebarProps,
  ProjectTask,
  RemoteProjectDirectory,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { getPathLeaf } from "@/lib/path.js";
import { resolveProjectFileTarget } from "@/project-sidebar/project-file-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

export function useProjectFileTree(
  props: ProjectSidebarProps,
  directory: RemoteProjectDirectory,
  remoteService?: IRemoteProjectService,
) {
  const request = useRef(0);
  const consumedRequest = useRef<ProjectSidebarProps["fileTreeOpenRequest"]>(null);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    const next = props.fileTreeOpenRequest;
    if (!next || consumedRequest.current === next || !props.onOpenFileManager) return;
    consumedRequest.current = next;
    request.current++;
    props.onOpenFileManager(next.target);
  }, [props.fileTreeOpenRequest, props.onOpenFileManager]);
  const openFiles = useCallback(
    async (project: VirtualProject, rootPath: string) => {
      const generation = ++request.current;
      const target = await resolveProjectFileTarget({
        project,
        rootPath,
        props,
        remoteService,
        isRemote: directory.hosts.some((host) => host.id === project.hostId),
        findSession: (identity) =>
          Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
            (session) => session.workspaceIdentity === identity,
          ),
      });
      // 原因：连接完成可能晚于另一次查看/关闭，旧目标不得覆盖最新文件树选择。
      if (target && generation === request.current) props.onOpenFileManager?.(target);
    },
    [props, directory, remoteService],
  );

  const openTaskFiles = useCallback(
    async (task: ProjectTask, remoteSessionId?: string) => {
      const generation = ++request.current;
      const identity = task.workspaceIdentity?.trim();
      const key = identity || task.workspacePath;
      if (
        props.webRemoteControlWorkspaceSwitcher &&
        (props.workspaceIdentity?.trim() || props.workspacePath) !== key
      ) {
        await props.webRemoteControlWorkspaceSwitcher.switchWorkspace(key, {
          taskHostId: task.hostId,
          fileTreeTaskId: task.taskId,
          mobileNavigationIntent: "chat",
        });
        // 跨 workspace 由新 Root 消费文件请求，旧页面不能再次创建标签。
        return;
      }
      if (generation !== request.current) return;
      const sessions = useRemoteWorkspaceSessionStore.getState();
      const sessionId = identity
        ? (sessions.sessionIdByWorkspaceIdentity[identity] ?? remoteSessionId)
        : undefined;
      const session = sessionId ? sessions.sessionsById[sessionId] : undefined;
      // 原因：远端 cwd 可与本地同名；只接受该任务 identity 对应的 session，不能退回本机读取。
      // 手机 bridge 将 identity 绑定单独保存在索引，不一定重复写入 session 元数据。
      if (
        identity &&
        (!session ||
          (sessions.sessionIdByWorkspaceIdentity[identity] !== sessionId &&
            session.workspaceIdentity !== identity))
      )
        throw new Error("project.connection-unavailable");
      props.onOpenFileManager?.({
        workspacePath: task.workspacePath,
        workspaceName: getPathLeaf(task.workspacePath) || task.workspacePath,
        ...(identity ? { workspaceIdentity: identity, workspaceRemoteSessionId: sessionId } : {}),
      });
    },
    [
      props.webRemoteControlWorkspaceSwitcher,
      props.workspaceIdentity,
      props.workspacePath,
      props.onOpenFileManager,
    ],
  );
  return { openFiles, openTaskFiles };
}
