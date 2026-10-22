import { expect, it, vi } from "vitest";
import type { IProjectService } from "#src/project/contract.js";
import { bindRemoteProjectIdentities } from "#src/project/index.js";

it("prepares empty remote project roots before publishing the tree, deduplicating task directories", async () => {
  const tree = {
    projects: [
      { roots: [{ rootPath: "/empty" }, { rootPath: "/shared" }] },
      { roots: [{ rootPath: "/shared" }] },
    ],
    tasks: [
      { taskId: "one", workspacePath: "/shared" },
      { taskId: "two", workspacePath: "/history" },
    ],
  };
  const resolve = vi.fn(async (path: string) => `stable:${path}`);
  const service = bindRemoteProjectIdentities(
    { readTree: async () => tree } as unknown as IProjectService,
    resolve,
  );
  const result = await service.readTree();
  expect(new Set(resolve.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/empty", "/shared", "/history"]),
  );
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(result.projects).toBe(tree.projects);
  expect(result.tasks.map((task) => task.workspaceIdentity)).toEqual([
    "stable:/shared",
    "stable:/history",
  ]);
});

it("does not publish an empty remote project when identity preparation fails", async () => {
  const service = bindRemoteProjectIdentities(
    {
      readTree: async () => ({ projects: [{ roots: [{ rootPath: "/empty" }] }], tasks: [] }),
    } as unknown as IProjectService,
    async () => {
      throw new Error("identity preparation failed");
    },
  );
  await expect(service.readTree()).rejects.toThrow("identity preparation failed");
});
