import { expect, it } from "vitest";
import { readProjectCatalog, projectSelectionId } from "#src/project-catalog/index.js";
import type { VirtualProject } from "#src/project-catalog/contract.js";
it("同 cwd 的不同项目保持独立，空 roots 可选择", async () => {
  const make = (id: string, roots: string[]): VirtualProject => ({
    id,
    hostId: "local",
    name: id,
    roots: roots.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
    nameOverridden: false,
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  });
  const projects = [make("one", ["/same"]), make("two", ["/same"]), make("empty", [])];
  expect(
    (await readProjectCatalog({ projectService: { readProjects: async () => projects } })).projects,
  ).toEqual(projects);
  expect(new Set(projects.map(projectSelectionId)).size).toBe(3);
  expect(projectSelectionId({ hostId: "a:b", id: "c" })).not.toBe(
    projectSelectionId({ hostId: "a", id: "b:c" }),
  );
});
