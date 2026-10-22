import { expect, it, vi } from "vitest";
import type { VirtualProject, RemoteProjectDirectory } from "./contract.js";
import { projectConfigTargets, readConfigCatalog } from "./index.js";
const project = (id: string, hostId: string, paths: string[]) =>
  ({
    id,
    hostId,
    name: id,
    nameOverridden: false,
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    roots: paths.map((rootPath, i) => ({ rootPath, position: i, isPrimary: i === 0 })),
  }) satisfies VirtualProject;
const remote = project("remote", "remote:server:owner", ["/same", "/unopened"]);
const directory: RemoteProjectDirectory = {
  hosts: [
    {
      id: remote.hostId,
      membershipId: "one",
      kind: "server",
      target: null,
      position: 0,
      connectionStatus: "online",
    },
  ],
  entries: [
    {
      id: "entry",
      hostId: remote.hostId,
      projectId: remote.id,
      name: remote.name,
      roots: remote.roots,
      legacyWorkspace: null,
      lastSyncedAt: 1,
    },
  ],
};
it("roots 去重且不依赖 tab，跨 host 相同路径隔离，关闭 tab 不移除目录", () => {
  const snapshot = {
    projects: [project("a", "local", ["/same", "/new"]), project("b", "local", ["/same"]), remote],
    directory,
  };
  const targets = projectConfigTargets(snapshot, []);
  expect(targets.map((x) => x.workspaceIdentity || x.workspacePath)).toEqual([
    "/same",
    "/new",
    "remote:server:owner:/same",
    "remote:server:owner:/unopened",
  ]);
  expect(targets.every((x) => !("id" in x) && !("kind" in x))).toBe(true);
  expect(projectConfigTargets(snapshot, [{ label: "old", workspacePath: "/not-a-root" }])).toEqual(
    targets,
  );
});
it("远端删除入口后的迟到目录不复活，仅调用项目读取合同", async () => {
  const readDirectory = vi
    .fn()
    .mockResolvedValueOnce(directory)
    .mockResolvedValue({ ...directory, entries: [] });
  const readProjects = vi.fn(async (input?: { hostId?: string }) =>
    input?.hostId ? [remote] : [project("local", "local", ["/repo"])],
  );
  const result = await readConfigCatalog({
    projectService: { readProjects },
    remoteProjectService: { readDirectory },
  });
  expect(result.projects.map((x) => x.id)).toEqual(["local"]);
  expect(readProjects).toHaveBeenCalledTimes(2);
});
it("同 ID host 移除后重加，拒绝旧 membership 的读取结果", async () => {
  const readDirectory = vi
    .fn()
    .mockResolvedValueOnce(directory)
    .mockResolvedValue({ ...directory, hosts: [{ ...directory.hosts[0], membershipId: "two" }] });
  const result = await readConfigCatalog({
    projectService: { readProjects: vi.fn(async () => [remote]) },
    remoteProjectService: { readDirectory },
  });
  expect(result.projects).toEqual([]);
});
