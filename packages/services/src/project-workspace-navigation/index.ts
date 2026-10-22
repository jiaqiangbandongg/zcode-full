import { z } from "zod";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import { readProjectCatalog } from "#src/project-catalog/index.js";
import type {
  ProjectNavigationPort,
  ProjectWorkspaceNavigation,
} from "#src/project-workspace-navigation/contract.js";
export type {
  ProjectNavigationRequest,
  ProjectNavigationResult,
  ProjectNavigationPort,
} from "#src/project-workspace-navigation/contract.js";

const requestSchema = z
  .object({
    projectId: z.string().min(1).nullable().optional(),
    hostId: z.string().min(1).optional(),
    draftId: z.string().uuid().optional(),
    reuseDraft: z.boolean().optional(),
    task: z
      .object({ taskId: z.string().min(1), workspaceKey: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (request) =>
      (!request.task || (request.projectId === undefined && request.draftId === undefined)) &&
      (!request.draftId || !request.projectId) &&
      (!request.reuseDraft || Boolean(request.draftId)),
    "Task navigation cannot prepare a draft",
  );

export function createProjectWorkspaceNavigation(
  port: ProjectNavigationPort,
): ProjectWorkspaceNavigation {
  return {
    async prepare(input) {
      const request = requestSchema.parse(input);
      const hostId = request.hostId ?? "local";
      // 导航必须先有远程项目，不能因设备在线就分配无归属目录和 logical scope。
      if (hostId !== "local" && !request.task && !request.projectId)
        throw new Error("project.remote-project-required");
      const params = {
        hostId,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        ...(request.draftId ? { draftId: request.draftId, reuseDraft: request.reuseDraft } : {}),
      };
      const readTask = async () => {
        if (!request.task) return undefined;
        const tree = await port.projectService.readTree({ hostId, includeDeleted: true });
        const task = tree.tasks.find(
          (item) =>
            item.hostId === hostId &&
            item.taskId === request.task?.taskId &&
            (item.workspaceIdentity?.trim() || item.workspacePath) === request.task.workspaceKey,
        );
        if (!task) throw new Error("project.task-not-found");
        return {
          task,
          project: tree.projects.find(
            (project) => project.id === task.projectId && project.hostId === hostId,
          ),
        };
      };
      const resolveDirectories = async (existing: Awaited<ReturnType<typeof readTask>>) => {
        if (!existing) return port.projectService.prepareSession(params);
        const directories = await port.projectService.resolveSessionDirectories(
          existing.task,
          hostId,
        );
        if (
          directories.workspacePath !== existing.task.workspacePath ||
          directories.workspaceIdentity !== existing.task.workspaceIdentity
        )
          throw new Error("project.task-directory-mismatch");
        return directories;
      };
      if (hostId === "local") return { ...(await resolveDirectories(await readTask())), hostId };
      const before = await readProjectCatalog(port);
      const host = before.directory.hosts.find((item) => item.id === hostId);
      const owner = port.readConnectionOwner(hostId);
      if (!host?.target || !owner || host.connectionStatus !== "online")
        throw new Error("project.host-offline");
      const existing = await readTask();
      const project =
        existing?.project ??
        (request.projectId
          ? before.projects.find((item) => item.id === request.projectId && item.hostId === hostId)
          : undefined);
      if (existing?.task.projectId && !project) throw new Error("project.not-retained");
      if (request.projectId && !project) throw new Error("project.not-retained");
      const entries = before.directory.entries.filter(
        (entry) =>
          entry.hostId === hostId &&
          project &&
          (entry.projectId === project.id ||
            (entry.projectId === null &&
              entry.legacyWorkspace &&
              project.roots.some(
                (root) => root.rootPath === entry.legacyWorkspace?.workspacePath,
              ))),
      );
      const assertCurrent = async () => {
        const current = await port.remoteProjectService.readDirectory();
        if (
          port.readConnectionOwner(hostId) !== owner ||
          !current.hosts.some(
            (item) => item.id === hostId && item.membershipId === host.membershipId,
          ) ||
          (project &&
            !entries.some((entry) => current.entries.some((item) => item.id === entry.id)))
        )
          throw new Error("project.navigation-stale");
      };
      const prepared = await resolveDirectories(existing);
      const directories = {
        ...prepared,
        workspaceIdentity:
          prepared.workspaceIdentity ??
          buildRemoteHostWorkspaceIdentity(hostId, prepared.workspacePath),
      };
      await assertCurrent();
      // Registry 在 provisional scope 提交前再次调用；迟到失败只撤销本次尚未发布的 scope。
      const remote = await port.openRemoteWorkspace({ host, directories, owner, assertCurrent });
      return { ...directories, hostId, remote };
    },
  };
}
