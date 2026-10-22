import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { bindRemoteProjectIdentities, createProjectService } from "#src/project/index.js";
import { createProjectWorkspaceNavigation } from "#src/project-workspace-navigation/index.js";
import type { ProjectNavigationPort } from "#src/project-workspace-navigation/contract.js";

it("MRO01：真实远端目录解析补齐身份后可打开已有任务，不创建替代目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-navigation-"));
  const hostId = "remote:server:source";
  const workspacePath = directory;
  const workspaceIdentity = buildRemoteHostWorkspaceIdentity(hostId, workspacePath);
  const task = { taskId: "existing", workspacePath, workspaceIdentity };
  const index = new TaskIndexRepo(undefined, hostId, join(directory, "tasks-index.sqlite"));
  try {
    const repository = await index.getProjectRepository();
    const project = repository.saveProject({ roots: [workspacePath] });
    repository.reserveCreatedTask({ task, projectId: project.id });
    await index.applyCliFacts({
      meta: {
        ...task,
        traceId: "trace-existing",
        title: "Existing task",
        mode: "default",
        provider: "glm",
        createdAt: 1,
        updatedAt: 2,
      },
      titleSource: "generated",
      lastOutcome: "completed",
    });
    const source = createProjectService({
      repository: async () => repository,
      workspaceDirectory: directory,
      ownerHostId: hostId,
    });
    const resolveIdentity = vi.fn(async (path: string) =>
      buildRemoteHostWorkspaceIdentity(hostId, path),
    );
    const service = bindRemoteProjectIdentities(source, resolveIdentity);
    const prepareDraft = vi.spyOn(source, "prepareSession");
    const before = repository.readTree();
    const owner = {};
    const openRemoteWorkspace = vi.fn<ProjectNavigationPort["openRemoteWorkspace"]>(
      async ({ directories, assertCurrent }) => {
        await assertCurrent();
        return {
          sourceServerId: "source",
          remoteSessionId: "scope",
          generation: 1,
          target: { kind: "server", serverId: "source", url: "https://example.test" },
          workspacePath: directories.workspacePath,
          workspaceIdentity: directories.workspaceIdentity,
        };
      },
    );
    const navigation = createProjectWorkspaceNavigation({
      projectService: service,
      readConnectionOwner: () => owner,
      openRemoteWorkspace,
      remoteProjectService: {
        readDirectory: async () => ({
          hosts: [
            {
              id: hostId,
              membershipId: "member",
              kind: "server",
              target: { kind: "server", serverId: "source", url: "https://example.test" },
              position: 0,
              connectionStatus: "online",
            },
          ],
          entries: [
            {
              id: "entry",
              hostId,
              projectId: project.id,
              name: project.name,
              roots: project.roots,
              legacyWorkspace: null,
              lastSyncedAt: 1,
            },
          ],
        }),
      },
    });
    await expect(
      navigation.prepare({
        hostId,
        task: { taskId: task.taskId, workspaceKey: workspaceIdentity },
      }),
    ).resolves.toMatchObject({
      hostId,
      projectId: project.id,
      workspacePath,
      workspaceIdentity,
      additionalDirectories: [],
      remote: { remoteSessionId: "scope" },
    });
    expect(prepareDraft).not.toHaveBeenCalled();
    expect(repository.readTree()).toEqual(before);
    expect(openRemoteWorkspace).toHaveBeenCalledTimes(1);

    // resolver 失败不能复制请求身份继续；跨设备输入仍由原导航校验拒绝。
    resolveIdentity.mockRejectedValueOnce(new Error("identity unavailable"));
    await expect(service.resolveSessionDirectories(task, hostId)).rejects.toThrow(
      "identity unavailable",
    );
    await expect(
      navigation.prepare({
        hostId,
        task: {
          taskId: task.taskId,
          workspaceKey: buildRemoteHostWorkspaceIdentity("remote:server:another", workspacePath),
        },
      }),
    ).rejects.toThrow("project.task-not-found");
    expect(openRemoteWorkspace).toHaveBeenCalledTimes(1);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
