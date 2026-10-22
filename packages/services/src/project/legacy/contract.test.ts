import { describe, expect, it, vi } from "vitest";
import { appSettingsSchema, type ZCodeTaskMeta } from "@zcode/shared";
import { createLegacySingleRootProjectService } from "#src/project/index.js";

function fixture() {
  const get = vi.fn(async () =>
    appSettingsSchema.parse({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/a" },
        { kind: "local", workspacePath: "/chat", workspacePurpose: "conversation" },
      ],
      recentProjects: ["/a", "/b"],
    }),
  );
  const row = (workspacePath: string, suffix: string) =>
    ({
      taskId: `${workspacePath}-${suffix}`,
      workspacePath,
      title: suffix,
      updatedAt: 1,
    }) as ZCodeTaskMeta;
  const tasks = {
    listTasks: vi.fn(async ({ workspacePath }: { workspacePath: string }) => [
      row(workspacePath, "active"),
    ]),
    listPinnedTasks: vi.fn(async ({ workspacePath }: { workspacePath: string }) => [
      row(workspacePath, "pin"),
    ]),
    listArchivedTasks: vi.fn(async ({ workspacePath }: { workspacePath: string }) => [
      row(workspacePath, "archived"),
    ]),
  };
  const ensureConversation = vi.fn(async () => "/new-chat");
  const directories = {
    info: vi.fn(async () => ({ homedir: "/home/remote", platform: "linux" })),
    read: vi.fn(async (_input: { path: string; includeHidden?: boolean }) => []),
  };
  const service = createLegacySingleRootProjectService({
    directories,
    hostId: "remote:server:old",
    readSettings: get,
    readTasks: ({ workspacePath, kind }) =>
      kind === "pinned"
        ? tasks.listPinnedTasks({ workspacePath })
        : kind === "archived"
          ? tasks.listArchivedTasks({ workspacePath })
          : tasks.listTasks({ workspacePath }),
    ensureConversation,
  });
  return { service, tasks, ensureConversation, get, directories };
}

describe("legacy single-root project adapter", () => {
  it.each([
    ["linux", "/remote/parent/../folder", "/remote/folder"],
    ["win32", "C:/work/project", "C:\\work\\project"],
  ])("按远端 %s 规则匹配历史目录，保留两个原身份和任务 cwd", async (platform, raw, canonical) => {
    const { service, directories, get } = fixture();
    directories.info.mockResolvedValue({ platform, homedir: canonical });
    get.mockResolvedValue(appSettingsSchema.parse({ recentProjects: [raw, canonical] }));
    const tree = await service.readTree();
    const projects = await service.readProjects();
    const selected = await service.readDirectory({ path: raw });
    expect(selected.path).toBe(canonical);
    expect(projects.map((project) => project.directoryMatchPath)).toEqual([
      selected.path,
      selected.path,
    ]);
    expect(new Set(projects.map((project) => project.id)).size).toBe(2);
    expect(tree.projects).toEqual(projects);
    for (const [index, project] of projects.entries()) {
      const path = [raw, canonical][index]!;
      expect(project.roots[0]?.rootPath).toBe(path);
      expect(tree.tasks.filter((task) => task.projectId === project.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ workspacePath: path })]),
      );
      await expect(service.prepareSession({ projectId: project.id })).resolves.toMatchObject({
        projectId: project.id,
        workspacePath: path,
      });
    }
    await expect(service.saveProject({ roots: [canonical] })).rejects.toThrow(
      "project.legacy-read-only",
    );
  });

  it("旧远端可按所属 Host 浏览和验证目录，但仍不能创建项目", async () => {
    const { service, directories, get, tasks, ensureConversation } = fixture();
    await expect(service.readDirectory()).resolves.toEqual({ path: "/home/remote", entries: [] });
    await expect(
      service.readDirectory({ path: "/repo/../a", includeHidden: true }),
    ).resolves.toEqual({ path: "/a", entries: [] });
    expect(directories.read).toHaveBeenLastCalledWith({ path: "/a", includeHidden: true });
    await expect(service.readDirectory({ path: "relative" })).rejects.toThrow(
      "project.absolute-path-required",
    );
    await expect(
      service.readDirectory({ hostId: "remote:server:another", path: "/a" }),
    ).rejects.toThrow("project.cross-host-move");
    const denied = new Error("EACCES: remote directory denied");
    directories.read.mockRejectedValueOnce(denied);
    await expect(service.readDirectory({ path: "/denied" })).rejects.toBe(denied);
    await expect(service.saveProject({ roots: ["/a"] })).rejects.toThrow(
      "project.legacy-read-only",
    );
    expect(get).not.toHaveBeenCalled();
    expect(tasks.listTasks).not.toHaveBeenCalled();
    expect(ensureConversation).not.toHaveBeenCalled();
  });

  it("旧分区查询期间任务被置顶时，同一 task 只保留一个投影行", async () => {
    const { service, tasks } = fixture();
    tasks.listPinnedTasks.mockImplementation(async ({ workspacePath }) => [
      {
        taskId: workspacePath + "-active",
        workspacePath,
        title: "active",
        updatedAt: 1,
      } as ZCodeTaskMeta,
    ]);
    const tree = await service.readTree();
    expect(tree.tasks.filter((task) => task.taskId === "/a-active")).toHaveLength(1);
    expect(tree.tasks.find((task) => task.taskId === "/a-active")?.pinned).toBe(true);
  });
  it("目录查询不读取任务，单 root ID 稳定；conversation 不变成项目", async () => {
    const { service, tasks } = fixture();
    const first = await service.readProjects();
    expect(first.map((project) => project.roots.map((root) => root.rootPath))).toEqual([
      ["/a"],
      ["/b"],
    ]);
    expect(
      first.every((project) => project.legacySingleRoot && project.hostId === "remote:server:old"),
    ).toBe(true);
    expect(await service.readProjects()).toEqual(first);
    expect(tasks.listTasks).not.toHaveBeenCalled();
  });

  it("只投影远端 app 的三个任务分区，既有 cwd 与会话事实不改写", async () => {
    const { service } = fixture();
    const tree = await service.readTree();
    expect(tree.legacySingleRoot).toBe(true);
    expect(tree.tasks).toHaveLength(9);
    expect(tree.tasks.find((task) => task.taskId === "/a-pin")).toMatchObject({
      pinned: true,
      archived: false,
      projectId: tree.projects[0]!.id,
      title: "pin",
      updatedAt: 1,
    });
    expect(
      tree.tasks
        .filter((task) => task.workspacePath === "/chat")
        .every((task) => task.projectId === null),
    ).toBe(true);
    expect(tree.tasks.find((task) => task.taskId === "/b-archived")?.archived).toBe(true);
  });

  it("创建与恢复只返回已有 cwd/空附加目录，组织修改和跨 Host 请求明确拒绝", async () => {
    const { service, ensureConversation } = fixture();
    const project = (await service.readProjects())[0]!;
    await expect(service.prepareSession({ projectId: project.id })).resolves.toMatchObject({
      workspacePath: "/a",
      additionalDirectories: [],
      projectId: project.id,
    });
    await expect(
      service.resolveSessionDirectories({ taskId: "s", workspacePath: "/chat" }),
    ).resolves.toMatchObject({
      workspacePath: "/chat",
      additionalDirectories: [],
      projectId: null,
    });
    await expect(service.prepareSession({ projectId: "removed" })).rejects.toThrow(
      "project.not-found",
    );
    expect(ensureConversation).not.toHaveBeenCalled();
    await expect(service.prepareSession()).resolves.toMatchObject({
      workspacePath: "/new-chat",
      additionalDirectories: [],
      projectId: null,
    });
    await expect(service.saveProject({ roots: ["/a", "/b"] })).rejects.toThrow(
      "project.legacy-read-only",
    );
    await expect(service.deleteProject(project.id)).rejects.toThrow("project.legacy-read-only");
    await expect(
      service.moveTask({ task: { taskId: "s", workspacePath: "/a" }, projectId: project.id }),
    ).rejects.toThrow("project.legacy-read-only");
    await expect(service.reorderProjects([project.id])).rejects.toThrow("project.legacy-read-only");
    await expect(service.readTree({ hostId: "remote:server:another" })).rejects.toThrow(
      "project.cross-host-move",
    );
  });
});
