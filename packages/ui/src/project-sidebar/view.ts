import {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type {
  ProjectTask,
  ProjectTree,
  VirtualProject,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  ProjectAvailability,
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@/project-sidebar/contract.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { compareTaskListItemsByTime, compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@/project-sidebar/contract.js";
import {
  areStabilizedValuesEquivalent,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";

/** 活动态只覆盖已有行的 UI sidecar；Controller 快照不能替代项目树的行集合和事实。 */
export function applyProjectTaskActivities(
  tree: ProjectTree,
  activities: readonly {
    address: WindowHostTaskAddress;
    activity: WindowHostControllerTaskActivity;
  }[],
): ProjectTree {
  const byKey = new Map(
    activities.map(({ address, activity }) => [buildTaskEntityKey(address), activity]),
  );
  return {
    ...tree,
    tasks: tree.tasks.map((task) => {
      const activity = byKey.get(buildTaskEntityKey(task));
      return activity ? attachTaskListRowActivity(task, activity) : task;
    }),
  };
}

/** 复用等价对象以保留行 memo；组织变化和 activity 都参加比较，不把旧项目归属粘在行上。 */
export function stabilizeProjectTree(previous: ProjectTree, next: ProjectTree): ProjectTree {
  const previousProjects = new Map(
    previous.projects.map((project) => [projectKey(project), project]),
  );
  let sameProjects = previous.projects.length === next.projects.length;
  const projects = next.projects.map((project, index) => {
    const old = previousProjects.get(projectKey(project));
    const stable = old && areStabilizedValuesEquivalent(old, project) ? old : project;
    if (previous.projects[index] !== stable) sameProjects = false;
    return stable;
  });
  const tasks = stabilizeTaskListItems(previous.tasks, next.tasks);
  return sameProjects &&
    tasks === previous.tasks &&
    areStabilizedValuesEquivalent(previous.deletedTasks, next.deletedTasks)
    ? previous
    : { ...next, projects: sameProjects ? previous.projects : projects, tasks };
}

export type ProjectRowSelection =
  | { kind: "project"; projectId: string | null; hostId?: string }
  | { kind: "timeline" }
  | { kind: "pinned" };

/** 选择器和行列表共用同一比较器，避免时间线在渲染时又被运行优先覆盖。 */
export function compareProjectTaskRows(
  left: ProjectTask,
  right: ProjectTask,
  kind: "project" | "pinned" | "timeline",
): number {
  return (
    (kind === "timeline"
      ? compareTaskListItemsByTime(left, right, "updated")
      : compareZCodeTaskListItems(left, right, "updated")) ||
    JSON.stringify([right.hostId, buildTaskEntityKey(right)]).localeCompare(
      JSON.stringify([left.hostId, buildTaskEntityKey(left)]),
    )
  );
}
/** 只从 Host 已提交的行派生显示；相同 cwd 不代表相同项目。 */
export function selectProjectRows(
  tree: ProjectTree,
  selection: ProjectRowSelection,
): ProjectTask[] {
  return tree.tasks
    .filter((task) => {
      if (selection.kind === "pinned") return task.pinned && !task.archived;
      if (selection.kind === "timeline") return !task.archived;
      return (
        task.projectId === selection.projectId &&
        (!selection.hostId || task.hostId === selection.hostId) &&
        !task.archived &&
        !task.pinned
      );
    })
    .sort((left, right) => compareProjectTaskRows(left, right, selection.kind));
}

export function projectHasUnread(
  tree: ProjectTree,
  project: Pick<VirtualProject, "id" | "hostId">,
): boolean {
  // 置顶只改变显示位置，不改变项目归属；不能只从截断/排除置顶的可见行汇总。
  return tree.tasks.some(
    (task) =>
      task.projectId === project.id &&
      task.hostId === project.hostId &&
      !task.archived &&
      Boolean(task.unreadAt),
  );
}

/**
 * 任务栏/托盘角标的未读总数：与侧栏蓝点同源（host readTree 的权威树），
 * 过滤条件与 projectHasUnread 一致（非归档 + 有 unreadAt），按 host+workspace+task 去重。
 * 不能改读 renderer 的 taskListCache/taskQueryCache：它们只装载活跃 workspace 的列表，
 * 背景工作区有蓝点时这两份缓存是空的，角标会丢数。
 */
export function countProjectTreeUnreadTasks(tree: ProjectTree): number {
  // 只统计侧边栏实际渲染的项目（非软删）：孤儿任务（项目不存在）与已删项目的
  // 未读在界面上没有蓝点落点，计入只会产生「有角标没蓝点」的幽灵提醒。
  const renderedProjectKeys = new Set(
    tree.projects
      .filter((project) => !project.deleted)
      .map((project) => `${project.hostId}::${project.id}`),
  );
  const seen = new Set<string>();
  for (const task of tree.tasks) {
    if (task.archived || !task.unreadAt) {
      continue;
    }

    // 可见性对齐渲染分区：置顶区跨项目渲染；本地无项目任务区只渲染
    // host=local 的 null-project 任务；其余任务必须归属渲染项目。
    const visible =
      task.pinned ||
      (task.projectId == null && task.hostId === "local") ||
      renderedProjectKeys.has(`${task.hostId}::${task.projectId}`);
    if (!visible) {
      continue;
    }

    seen.add(
      JSON.stringify([
        task.hostId,
        task.workspaceIdentity?.trim() || task.workspacePath,
        task.taskId,
      ]),
    );
  }

  return seen.size;
}

export function projectKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return JSON.stringify([project.hostId, project.id]);
}

export function resolveEntryProject(
  entry: RemoteProjectEntry,
  tree: ProjectTree,
): VirtualProject | undefined {
  const exact = tree.projects.find(
    (project) => project.hostId === entry.hostId && project.id === entry.projectId,
  );
  if (exact) return exact;
  const legacyRoot =
    entry.projectId?.startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX) && entry.roots.length === 1
      ? entry.roots[0]!.rootPath
      : entry.projectId
        ? undefined
        : entry.legacyWorkspace?.workspacePath;
  const candidates = tree.projects.filter(
    (project) =>
      project.hostId === entry.hostId &&
      !project.deleted &&
      legacyRoot !== undefined &&
      project.roots.some((root) => root.rootPath === legacyRoot),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** 聚合是展示投影，不复制远端事实；离线后只保留本机入口基础缓存。 */
export function mergeProjectTrees(
  local: ProjectTree,
  directory: RemoteProjectDirectory,
  remote: ReadonlyMap<string, ProjectTree>,
): {
  tree: ProjectTree;
  availability: Map<string, ProjectAvailability>;
} {
  const projects = [...local.projects];
  const tasks = [...local.tasks];
  const deletedTasks = [...(local.deletedTasks ?? [])];
  const availability = new Map(
    local.projects.map((project) => [projectKey(project), { online: true } as ProjectAvailability]),
  );
  const retainedHosts = new Set(directory.hosts.map((host) => host.id));
  for (const entry of directory.entries) {
    if (!retainedHosts.has(entry.hostId)) continue;
    const tree = remote.get(entry.hostId);
    const resolved = tree && resolveEntryProject(entry, tree);
    const source: VirtualProject = resolved ?? {
      id: entry.projectId ?? `legacy:${entry.id}`,
      hostId: entry.hostId,
      name: entry.name,
      roots: entry.roots,
      pinned: false,
      deleted: false,
      nameOverridden: false,
      position: projects.length,
      createdAt: 0,
      updatedAt: 0,
    };
    const project =
      entry.initialPosition == null ? source : { ...source, position: entry.initialPosition };
    const key = projectKey(project);
    if (!availability.has(key)) projects.push(project);
    availability.set(key, {
      entryId: entry.id,
      ...(entry.initialPosition == null ? {} : { upgradeEntryId: entry.id }),
      online: Boolean(resolved),
      ...(!resolved && tree ? { unresolved: true } : {}),
    });
  }
  for (const [hostId, tree] of remote) {
    if (!retainedHosts.has(hostId)) continue;
    deletedTasks.push(...(tree.deletedTasks ?? []).filter((task) => task.hostId === hostId));
    for (const task of tree.tasks) {
      if (task.hostId !== hostId) continue;
      if (
        task.projectId == null ||
        availability.get(projectKey({ hostId, id: task.projectId }))?.online
      )
        tasks.push(task);
    }
  }
  return {
    tree: { projects, tasks, ...(deletedTasks.length ? { deletedTasks } : {}) },
    availability,
  };
}

/** Host position 仅作为控制端首次初始化的种子；实际显示顺序由侧栏偏好覆盖。 */
export function selectSortedProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects
    .filter((project) => !project.deleted)
    .sort((a, b) => a.position - b.position);
}

export function projectSourceServerId(project: VirtualProject): string | undefined {
  return project.hostId === "local"
    ? undefined
    : parseRemoteWorkspaceIdentity(
        buildRemoteHostWorkspaceIdentity(project.hostId, project.roots[0]?.rootPath ?? "/"),
      )?.sourceServerId;
}

/** 内部错误码只用于判断；展示边界翻译已知状态，保留未知服务错误的诊断信息。 */
export function formatProjectError(
  cause: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const code = cause instanceof Error ? cause.message : String(cause);
  if (code === "remote-project.host-removed") return formatMessage({ id: "project.hostRemoved" });
  if (code === "project.connection-unavailable")
    return formatMessage({ id: "project.connectionUnavailable" });
  return String(cause);
}
