import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRepositoryContract, VirtualProject } from "#src/project-storage/contract.js";
import type { IProjectService } from "#src/project/contract.js";
import { createProjectService, bindRemoteProjectIdentities } from "#src/project/index.js";

it("projects live primary directory status without changing roots, and rejects stale create requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-primary-"));
  const primary = join(root, "primary");
  const extra = join(root, "extra");
  const moved = join(root, "moved");
  const project: VirtualProject = {
    id: "project",
    hostId: "local",
    name: "Project",
    nameOverridden: true,
    roots: [
      { rootPath: extra, position: 0, isPrimary: false },
      { rootPath: primary, position: 1, isPrimary: true },
    ],
    pinned: false,
    deleted: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const readTree = vi.fn(() => ({ projects: [project], tasks: [] }));
  const initializeProjectRoot = vi.fn();
  const afterChange = vi.fn();
  const service = createProjectService({
    repository: async () =>
      ({ readTree, initializeProjectRoot }) as unknown as ProjectRepositoryContract,
    workspaceDirectory: root,
    afterChange,
  });
  try {
    await Promise.all([mkdir(primary), mkdir(extra)]);
    expect((await service.readTree()).projects[0]?.primaryRootStatus).toBe("available");
    await rename(primary, moved);
    expect((await service.readTree()).projects[0]?.primaryRootStatus).toBe("missing");
    expect((await service.readProjects())[0]?.primaryRootStatus).toBe("missing");
    await expect(service.prepareSession({ projectId: project.id })).rejects.toThrow(
      "project.primaryRootMissing",
    );
    expect(initializeProjectRoot).not.toHaveBeenCalled();
    expect(afterChange).not.toHaveBeenCalled();
    expect(project.primaryRootStatus).toBeUndefined();
    expect(project.roots[1]?.rootPath).toBe(primary);
    await rename(moved, primary);
    // 附加目录失效不代表主目录失效；不能选择数组首项替代 isPrimary。
    await rm(extra, { recursive: true });
    expect((await service.readTree()).projects[0]?.primaryRootStatus).toBe("available");
    readTree.mockClear();
    await expect(service.prepareSession({ projectId: project.id })).resolves.toMatchObject({
      workspacePath: primary,
      additionalDirectories: [extra],
      projectId: project.id,
    });
    // 新建只依赖项目和目录；无关历史任务不能进入准备与删除复检的读路径。
    expect(readTree).toHaveBeenCalledTimes(2);
    expect(readTree.mock.calls).toEqual([[{ includeTasks: false }], [{ includeTasks: false }]]);
    await rm(primary, { recursive: true });
    await writeFile(primary, "not a directory");
    expect((await service.readTree()).projects[0]?.primaryRootStatus).toBe("missing");
    await expect(service.prepareSession({ projectId: project.id })).rejects.toThrow(
      "project.primaryRootMissing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not classify an empty project as missing and keeps its normal first-root initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-empty-"));
  const project = { id: "empty", roots: [] } as unknown as VirtualProject;
  const initializeProjectRoot = vi.fn((id: string, rootPath: string) => ({
    ...project,
    id,
    roots: [{ rootPath, position: 0, isPrimary: true }],
  }));
  const service = createProjectService({
    repository: async () =>
      ({
        readTree: () => ({ projects: [project], tasks: [] }),
        initializeProjectRoot,
      }) as unknown as ProjectRepositoryContract,
    workspaceDirectory: root,
  });
  try {
    expect((await service.readProjects())[0]?.primaryRootStatus).toBeUndefined();
    await expect(service.prepareSession({ projectId: project.id })).resolves.toMatchObject({
      workspacePath: join(root, project.id),
      projectId: project.id,
    });
    expect(initializeProjectRoot).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves remote primary status without checking foreign paths on this Host", async () => {
  const remoteProject = {
    id: "remote",
    roots: [{ rootPath: "/not-on-this-host", isPrimary: true }],
    primaryRootStatus: "available",
  };
  const remote = {
    readTree: vi.fn(async () => ({ projects: [remoteProject], tasks: [] })),
    readProjects: vi.fn(async () => [remoteProject]),
  } as unknown as IProjectService;
  const repository = vi.fn();
  const service = createProjectService({
    repository,
    workspaceDirectory: tmpdir(),
    resolveHost: async () => remote,
  });
  expect((await service.readTree({ hostId: "remote-owner" })).projects[0]).toBe(remoteProject);
  expect((await service.readProjects({ hostId: "remote-owner" }))[0]).toBe(remoteProject);
  expect(repository).not.toHaveBeenCalled();
});

it("returns attachment identity with prepared remote directories", async () => {
  const prepareSession = vi.fn(async () => ({
    projectId: "p",
    workspacePath: "/remote",
    additionalDirectories: ["/extra"],
  }));
  const resolve = vi.fn(async () => "remote:server:s:/remote");
  const service = bindRemoteProjectIdentities(
    { prepareSession } as unknown as IProjectService,
    resolve,
  );
  await expect(service.prepareSession({ projectId: "p" })).resolves.toMatchObject({
    workspacePath: "/remote",
    workspaceIdentity: "remote:server:s:/remote",
    additionalDirectories: ["/extra"],
  });
  expect(resolve).toHaveBeenCalledWith("/remote");
});

it("validates every root before mutating storage and deduplicates normalized paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-service-"));
  try {
    await mkdir(join(root, "present"));
    const saveProject = vi.fn((input) => input as VirtualProject);
    const repository = { saveProject } as unknown as ProjectRepositoryContract;
    const port: IProjectService = createProjectService({
      repository: async () => repository,
      workspaceDirectory: root,
    });
    await expect(
      port.saveProject({ roots: [join(root, "present"), join(root, "missing")] }),
    ).rejects.toThrow();
    expect(saveProject).not.toHaveBeenCalled();
    await port.saveProject({ roots: [join(root, "present"), join(root, "present", ".")] });
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ roots: [join(root, "present")] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("project directory resolution failures", () => {
  it("does not convert a database failure into an unclassified task", async () => {
    const port = createProjectService({
      repository: async () => {
        throw new Error("disk failed");
      },
      workspaceDirectory: tmpdir(),
    });
    await expect(
      port.resolveSessionDirectories({ workspacePath: "/cwd", taskId: "s" }),
    ).rejects.toThrow("disk failed");
  });
});

it("readTree only reads the snapshot and never archives or broadcasts", async () => {
  const readTree = vi.fn(() => ({ projects: [], tasks: [] }));
  const repository = { readTree } as unknown as ProjectRepositoryContract;
  const afterChange = vi.fn();
  const service = createProjectService({
    repository: async () => repository,
    workspaceDirectory: tmpdir(),
    afterChange,
  });
  await expect(service.readTree()).resolves.toEqual({ projects: [], tasks: [] });
  expect(readTree).toHaveBeenCalledTimes(1);
  expect(afterChange).not.toHaveBeenCalled();
});

it("routes every foreign project operation to its existing owner and never falls back to the local repository", async () => {
  const repository = vi.fn(async () => {
    throw new Error("must not read local storage");
  });
  const remote = {
    readDirectory: vi.fn(async () => ({ path: "/remote-home", entries: [] })),
    readProjects: vi.fn(async () => [] as VirtualProject[]),
    readTree: vi.fn(async () => ({ projects: [], tasks: [] })),
    saveProject: vi.fn(async () => ({ id: "remote-p" }) as VirtualProject),
    deleteProject: vi.fn(async () => {}),
    moveTask: vi.fn(async () => {}),
    reorderProjects: vi.fn(async () => {}),
    prepareSession: vi.fn(async () => ({
      projectId: "remote-p",
      workspacePath: "/remote",
      additionalDirectories: ["/extra"],
    })),
    resolveSessionDirectories: vi.fn(async () => ({
      projectId: "remote-p",
      workspacePath: "/remote",
      additionalDirectories: ["/extra"],
    })),
  } satisfies IProjectService;
  const resolveHost = vi.fn(async (hostId: string) => {
    if (hostId === "offline") throw new Error("project.host-offline");
    return remote;
  });
  const service = createProjectService({ repository, workspaceDirectory: tmpdir(), resolveHost });
  await service.readTree({ hostId: "source" });
  await service.readProjects({ hostId: "source" });
  await service.readDirectory({ hostId: "source", path: "/remote" });
  await service.saveProject({ hostId: "source", roots: ["/missing-local-path"] });
  await service.deleteProject("remote-p", "source");
  await service.moveTask({
    hostId: "source",
    projectId: "remote-p",
    task: { workspacePath: "/remote", taskId: "s" },
    addMissingRoot: true,
  });
  await service.reorderProjects(["remote-p"], "source");
  expect(await service.prepareSession({ hostId: "source", projectId: "remote-p" })).toMatchObject({
    workspacePath: "/remote",
  });
  await service.resolveSessionDirectories({ workspacePath: "/remote", taskId: "s" }, "source");
  for (const method of Object.values(remote)) expect(method).toHaveBeenCalledTimes(1);
  expect(repository).not.toHaveBeenCalled();
  await expect(service.readTree({ hostId: "offline" })).rejects.toThrow("project.host-offline");
  expect(repository).not.toHaveBeenCalled();
});

it("browses owner directories without touching project storage or admitting a session", async () => {
  const repository = vi.fn();
  const directories = { home: async () => "/owner", read: vi.fn(async () => []) };
  const service = createProjectService({
    repository,
    workspaceDirectory: "/workspace",
    directories,
  });
  expect(await service.readDirectory()).toEqual({ path: "/owner", entries: [] });
  expect(directories.read).toHaveBeenCalledWith({ path: "/owner" });
  await service.readDirectory({ path: "/another", includeHidden: true });
  expect(directories.read).toHaveBeenLastCalledWith({ path: "/another", includeHidden: true });
  await expect(service.readDirectory({ path: "relative" })).rejects.toThrow(
    "project.absolute-path-required",
  );
  expect(await service.readDirectory({ path: "/owner/child/../folder" })).toEqual({
    path: "/owner/folder",
    entries: [],
  });
  expect(directories.read).toHaveBeenLastCalledWith({ path: "/owner/folder" });
  expect(repository).not.toHaveBeenCalled();
});

it("binds every remote task directory through the existing workspace identity resolver", async () => {
  const readTree = vi.fn(async () => ({
    projects: [],
    tasks: [
      { taskId: "one", workspacePath: "/repo", workspaceIdentity: "remote:ssh:old:22:u:/repo" },
      { taskId: "two", workspacePath: "/repo", workspaceIdentity: "remote:ssh:old:22:u:/repo" },
    ],
  }));
  const resolve = vi.fn(async (path: string) => `stable:${path}`);
  const service = bindRemoteProjectIdentities({ readTree } as unknown as IProjectService, resolve);
  const result = await service.readTree();
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(result.tasks.map((task) => task.workspaceIdentity)).toEqual([
    "stable:/repo",
    "stable:/repo",
  ]);
});
