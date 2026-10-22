import type { ProjectCatalogPort, ProjectCatalogSnapshot } from "#src/project-catalog/contract.js";
export type { ProjectCatalogPort, ProjectCatalogSnapshot } from "#src/project-catalog/contract.js";
export { projectSelectionId } from "#src/project-catalog/selection-id.js";

export async function readProjectCatalog(
  port: ProjectCatalogPort,
): Promise<ProjectCatalogSnapshot> {
  const before = (await port.remoteProjectService?.readDirectory()) ?? { hosts: [], entries: [] };
  const hosts = before.hosts.filter((host) => host.connectionStatus === "online");
  const [owned, results] = await Promise.all([
    port.projectService.readProjects(),
    Promise.allSettled(hosts.map((host) => port.projectService.readProjects({ hostId: host.id }))),
  ]);
  const directory = (await port.remoteProjectService?.readDirectory()) ?? before;
  const foreign = new Set(before.hosts.map((host) => host.id));
  const projects = owned.filter((project) => !project.deleted && !foreign.has(project.hostId));
  for (let index = 0; index < hosts.length; index++) {
    const host = hosts[index]!;
    const result = results[index]!;
    if (
      result.status !== "fulfilled" ||
      !directory.hosts.some(
        (current) =>
          current.id === host.id &&
          current.membershipId === host.membershipId &&
          current.connectionStatus === "online",
      )
    )
      continue;
    for (const entry of directory.entries.filter(
      (entry) => entry.hostId === host.id && before.entries.some((old) => old.id === entry.id),
    )) {
      const candidates = result.value.filter(
        (project) => !project.deleted && project.hostId === host.id,
      );
      const exact = candidates.find((project) => project.id === entry.projectId);
      // 尚未转换的旧入口只在目录唯一匹配时展示；不据读取结果新增/更新入口。
      const legacy =
        entry.projectId === null && entry.legacyWorkspace
          ? candidates.filter((project) =>
              project.roots.some((root) => root.rootPath === entry.legacyWorkspace?.workspacePath),
            )
          : [];
      const selected = exact ?? (legacy.length === 1 ? legacy[0] : undefined);
      if (
        selected &&
        !projects.some(
          (project) => project.hostId === selected.hostId && project.id === selected.id,
        )
      )
        projects.push(selected);
    }
  }
  return { projects, directory };
}
