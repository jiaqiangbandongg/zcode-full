import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ProjectRepositoryContract, VirtualProject } from "#src/project-storage/contract.js";
import { createProjectService } from "#src/project/index.js";

it("PD07 同一草稿重复准备只分配一个目录，不影响无参调用", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-draft-prepare-"));
  const service = createProjectService({ workspaceDirectory: root, repository: vi.fn() });
  const draftId = "cc29167e-5a72-4c24-9e31-adcc584c73b4";
  try {
    const [a, b] = await Promise.all([
      service.prepareSession({ draftId }),
      service.prepareSession({ draftId }),
    ]);
    expect(a.workspacePath).toBe(b.workspacePath);
    expect(await readdir(root)).toHaveLength(1);
    expect((await service.prepareSession()).workspacePath).not.toBe(a.workspacePath);
    await expect(service.prepareSession({ draftId: "../../escape" })).rejects.toThrow();
    expect(await readdir(root)).toHaveLength(2);
    await rm(a.workspacePath, { recursive: true });
    await expect(service.prepareSession({ draftId, reuseDraft: true })).rejects.toThrow();
    expect(await readdir(root)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not return a preparation result after its project was deleted during directory validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-prepare-delete-"));
  const project = {
    id: "p",
    hostId: "remote:server:s",
    roots: [{ rootPath: root, isPrimary: true, position: 0 }],
  } as VirtualProject;
  const readTree = vi
    .fn()
    .mockReturnValueOnce({ projects: [project], tasks: [] })
    .mockReturnValue({ projects: [], tasks: [] });
  const service = createProjectService({
    ownerHostId: project.hostId,
    workspaceDirectory: root,
    repository: async () => ({ readTree }) as unknown as ProjectRepositoryContract,
  });
  try {
    await expect(service.prepareSession({ projectId: "p" })).rejects.toThrow("project.not-found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects remote unclassified and empty-project creation before allocating a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-project-required-"));
  const initializeProjectRoot = vi.fn();
  const project = {
    id: "empty",
    roots: [],
    hostId: "remote:server:s",
  } as unknown as VirtualProject;
  const service = createProjectService({
    ownerHostId: project.hostId,
    workspaceDirectory: root,
    repository: async () =>
      ({
        readTree: () => ({ projects: [project], tasks: [] }),
        initializeProjectRoot,
      }) as unknown as ProjectRepositoryContract,
  });
  try {
    await expect(service.prepareSession()).rejects.toThrow("project.remote-project-required");
    await expect(service.prepareSession({ projectId: project.id })).rejects.toThrow(
      "project.remote-single-root-required",
    );
    await expect(
      service.prepareSession({ hostId: "local", projectId: project.id }),
    ).rejects.toThrow("project.host-offline");
    expect(initializeProjectRoot).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
