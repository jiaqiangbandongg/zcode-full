import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";

export type ArchiveSort = "updated" | "created";
export interface ArchiveGroup {
  key: string;
  hostId: string;
  project?: VirtualProject;
  projectId: string | null;
  tasks: ProjectTask[];
}
export const archiveTaskKey = (task: ProjectTask) =>
  JSON.stringify([task.hostId, task.workspaceIdentity?.trim() || task.workspacePath, task.taskId]);
const groupKey = (hostId: string, id: string | null) => JSON.stringify([hostId, id]);
export function buildArchiveGroups(
  tree: ProjectTree,
  filter: { query?: string; sort?: ArchiveSort; project?: string } = {},
): ArchiveGroup[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const projects = new Map(tree.projects.map((p) => [groupKey(p.hostId, p.id), p]));
  const groups = new Map<string, ArchiveGroup>();
  for (const task of tree.tasks) {
    if (!task.archived || !task.title.toLocaleLowerCase().includes(query)) continue;
    const key = groupKey(task.hostId, task.projectId);
    if (filter.project && filter.project !== "all" && key !== filter.project) continue;
    // cwd 可属于多个虚拟项目，不能再用目录叶名和路径合并归档。
    const group = groups.get(key) ?? {
      key,
      hostId: task.hostId,
      projectId: task.projectId,
      project: projects.get(key),
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const time = filter.sort === "created" ? "createdAt" : "updatedAt";
  for (const group of groups.values())
    group.tasks.sort(
      (a, b) => b[time] - a[time] || archiveTaskKey(a).localeCompare(archiveTaskKey(b)),
    );
  return [...groups.values()];
}

/** 项目选项不随搜索或最后一条取消归档消失，保留当前筛选的身份。 */
export function buildArchiveProjectOptions(tree: ProjectTree): ArchiveGroup[] {
  const archived = buildArchiveGroups(tree);
  const byKey = new Map(archived.map((group) => [group.key, group]));
  for (const project of tree.projects) {
    const key = groupKey(project.hostId, project.id);
    if (!project.deleted && !byKey.has(key))
      byKey.set(key, { key, hostId: project.hostId, projectId: project.id, project, tasks: [] });
  }
  return [...byKey.values()];
}
