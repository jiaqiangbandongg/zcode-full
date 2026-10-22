import { expect, it, vi } from "vitest";
import { createProjectWorkspaceNavigation } from "#src/project-workspace-navigation/index.js";
import type { ProjectNavigationPort } from "#src/project-workspace-navigation/contract.js";

function fixture() {
  let member = "one";
  let entryId = "entry";
  let owner: object | undefined = {};
  const hostId = "remote:server:source";
  const project = {
    id: "p",
    hostId,
    name: "P",
    roots: [{ rootPath: "/same", position: 0, isPrimary: true }],
    nameOverridden: false,
    pinned: false,
    deleted: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const port: ProjectNavigationPort = {
    projectService: {
      readTree: vi.fn(async () => ({ projects: [], tasks: [] })),
      resolveSessionDirectories: vi.fn(async () => {
        throw new Error("unexpected task resolution");
      }),
      readProjects: vi.fn(async (input) => (input?.hostId === hostId ? [project] : [])),
      prepareSession: vi.fn(async (input) => ({
        projectId: input?.projectId ?? null,
        workspacePath: "/same",
        additionalDirectories: ["/extra"],
        ...(input?.hostId === hostId ? { workspaceIdentity: "remote:server:source:/same" } : {}),
      })),
    },
    remoteProjectService: {
      readDirectory: vi.fn<ProjectNavigationPort["remoteProjectService"]["readDirectory"]>(
        async () => ({
          hosts: member
            ? [
                {
                  id: hostId,
                  membershipId: member,
                  kind: "server",
                  target: { kind: "server", serverId: "source", url: "http://source" },
                  position: 0,
                  connectionStatus: owner ? "online" : "offline",
                },
              ]
            : [],
          entries: [
            {
              id: entryId,
              hostId,
              projectId: "p",
              name: "P",
              roots: project.roots,
              legacyWorkspace: null,
              lastSyncedAt: 1,
            },
          ],
        }),
      ),
    },
    readConnectionOwner: () => owner,
    openRemoteWorkspace: vi.fn<ProjectNavigationPort["openRemoteWorkspace"]>(
      async ({ directories, assertCurrent }) => {
        await assertCurrent();
        return {
          sourceServerId: "source",
          remoteSessionId: "scope",
          generation: 1,
          target: { kind: "server", serverId: "source", url: "http://source" },
          workspacePath: directories.workspacePath,
          workspaceIdentity: directories.workspaceIdentity,
        };
      },
    ),
  };
  return {
    port,
    service: createProjectWorkspaceNavigation(port),
    hostId,
    member: (value: string) => {
      member = value;
    },
    entry: (value: string) => {
      entryId = value;
    },
    owner: (value?: object) => {
      owner = value;
    },
  };
}
it("本地目录只准备一次；远端只为保留项目取得已有 Source 的 scope", async () => {
  const f = fixture();
  expect(await f.service.prepare({ projectId: null })).toMatchObject({
    hostId: "local",
    projectId: null,
  });
  expect(f.port.openRemoteWorkspace).not.toHaveBeenCalled();
  expect(await f.service.prepare({ hostId: f.hostId, projectId: "p" })).toMatchObject({
    projectId: "p",
    workspacePath: "/same",
    additionalDirectories: ["/extra"],
    remote: { remoteSessionId: "scope" },
  });
  expect(f.port.projectService.prepareSession).toHaveBeenCalledTimes(2);
});
it("离线和移除的 host 在目录准备前拒绝；不能用新建入口接受旧结果", async () => {
  const f = fixture();
  f.owner();
  await expect(f.service.prepare({ hostId: f.hostId, projectId: "p" })).rejects.toThrow();
  expect(f.port.projectService.prepareSession).not.toHaveBeenCalled();
  f.owner({});
  vi.mocked(f.port.projectService.prepareSession).mockImplementation(async () => {
    f.entry("readded");
    return {
      projectId: "p",
      workspacePath: "/same",
      workspaceIdentity: "remote:server:source:/same",
      additionalDirectories: [],
    };
  });
  await expect(f.service.prepare({ hostId: f.hostId, projectId: "p" })).rejects.toThrow();
  expect(f.port.openRemoteWorkspace).not.toHaveBeenCalled();
});
it("scope admission 期间物理 owner 或 membership 换代使原请求失效", async () => {
  for (const change of ["owner", "member"] as const) {
    const f = fixture();
    vi.mocked(f.port.openRemoteWorkspace).mockImplementation(async ({ assertCurrent }) => {
      if (change === "owner") f.owner({});
      else f.member("readded");
      await assertCurrent();
      throw new Error("unexpected commit");
    });
    await expect(f.service.prepare({ hostId: f.hostId, projectId: "p" })).rejects.toThrow(
      "project.navigation-stale",
    );
  }
});

it("opens an existing task from its authoritative immutable cwd without preparing a draft", async () => {
  const { service, port, hostId } = fixture();
  const workspaceIdentity = "remote:server:source:/original";
  const task = {
    hostId,
    taskId: "existing",
    workspacePath: "/original",
    workspaceIdentity,
    projectId: "p",
  };
  Object.assign(port.projectService, {
    readTree: vi.fn(async () => ({
      projects: await port.projectService.readProjects({ hostId }),
      tasks: [task],
    })),
    resolveSessionDirectories: vi.fn(async () => ({
      projectId: "p",
      workspacePath: "/original",
      workspaceIdentity,
      additionalDirectories: ["/same"],
    })),
  });
  const result = await service.prepare({
    hostId,
    task: { taskId: "existing", workspaceKey: workspaceIdentity },
  });
  expect(result.workspacePath).toBe("/original");
  expect(result.additionalDirectories).toEqual(["/same"]);
  expect(port.projectService.prepareSession).not.toHaveBeenCalled();
  expect(port.openRemoteWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      directories: expect.objectContaining({ workspacePath: "/original" }),
    }),
  );
});
it("rejects a forged task workspace key without allocating a directory or binding a scope", async () => {
  const { service, port, hostId } = fixture();
  Object.assign(port.projectService, {
    readTree: vi.fn(async () => ({
      projects: [],
      tasks: [
        {
          hostId,
          taskId: "existing",
          workspacePath: "/same",
          workspaceIdentity: "remote:server:source:/same",
          projectId: null,
        },
      ],
    })),
    resolveSessionDirectories: vi.fn(),
  });
  await expect(
    service.prepare({
      hostId,
      task: { taskId: "existing", workspaceKey: "remote:server:another:/same" },
    }),
  ).rejects.toThrow("project.task-not-found");
  expect(port.projectService.prepareSession).not.toHaveBeenCalled();
  expect(port.openRemoteWorkspace).not.toHaveBeenCalled();
});

it.each(["workspacePath", "workspaceIdentity"] as const)(
  "MRO01：目录解析结果的 %s 不匹配仍拒绝打开任务",
  async (field) => {
    const f = fixture();
    const task = {
      taskId: "existing",
      hostId: f.hostId,
      workspacePath: "/same",
      workspaceIdentity: "remote:server:source:/same",
      projectId: "p",
    };
    Object.assign(f.port.projectService, {
      readTree: async () => ({
        tasks: [task],
        projects: await f.port.projectService.readProjects({ hostId: f.hostId }),
      }),
      resolveSessionDirectories: async () => ({
        ...task,
        additionalDirectories: [],
        [field]: field === "workspacePath" ? "/other" : "remote:server:another:/same",
      }),
    });
    await expect(
      f.service.prepare({
        hostId: f.hostId,
        task: { taskId: task.taskId, workspaceKey: task.workspaceIdentity },
      }),
    ).rejects.toThrow("project.task-directory-mismatch");
    expect(f.port.openRemoteWorkspace).not.toHaveBeenCalled();
  },
);
