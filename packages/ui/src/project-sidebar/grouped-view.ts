import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import type {
  GroupTaskRef,
  ProjectTask,
  TaskGroup,
  TaskGroupStructure,
} from "@/project-sidebar/contract.js";
export function taskGroupKey(
  task: Pick<GroupTaskRef, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return JSON.stringify([task.workspaceIdentity?.trim() || task.workspacePath, task.taskId]);
}
export function groupTaskRef(task: ProjectTask): GroupTaskRef {
  return {
    hostId: task.hostId,
    taskId: task.taskId,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
}
export type GroupedRow =
  | { type: "group"; key: string; group: TaskGroup }
  | { type: "task"; key: string; task: ProjectTask; groupId: string | null }
  | { type: "empty"; key: string; groupId: string };
/** 任务存在性只来自 Host 树；分组结构保留不可见成员，投影不能反向删写。 */
export function projectGroupedNodes(
  tasks: ProjectTask[],
  structure: TaskGroupStructure,
  collapsed: ReadonlySet<string>,
): GroupedRow[] {
  const visible = new Map(
    tasks
      .filter((task) => !task.pinned && !task.archived)
      .map((task) => [taskGroupKey(task), task]),
  );
  const groups = new Map(structure.groups.map((group) => [group.id, group]));
  const memberKeys = new Set<string>();
  const members = new Map<string, ProjectTask[]>();
  for (const member of [...structure.members].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!groups.has(member.groupId)) continue;
    const key = JSON.stringify([member.workspaceKey, member.taskId]);
    memberKeys.add(key);
    const task = visible.get(key);
    if (task) {
      const rows = members.get(member.groupId) ?? [];
      rows.push(task);
      members.set(member.groupId, rows);
    }
  }
  const root = [...structure.order].sort((a, b) => a.sortOrder - b.sortOrder);
  const ordered = new Set(root.map((row) => `${row.type}:${row.key}`));
  for (const group of structure.groups)
    if (!ordered.has(`group:${group.id}`))
      root.push({ type: "group", key: group.id, sortOrder: 0 });
  for (const [key] of visible)
    if (!ordered.has(`task:${key}`) && !memberKeys.has(key))
      root.push({ type: "task", key, sortOrder: 0 });
  return root.flatMap((node): GroupedRow[] => {
    if (node.type === "task") {
      const task = visible.get(node.key);
      return task && !memberKeys.has(node.key)
        ? [{ type: "task", key: `task:${node.key}`, task, groupId: null }]
        : [];
    }
    const group = groups.get(node.key);
    if (!group) return [];
    const header: GroupedRow = { type: "group", key: `group:${group.id}`, group };
    if (collapsed.has(group.id)) return [header];
    const children = members.get(group.id) ?? [];
    return [
      header,
      ...(children.length
        ? children.map(
            (task): GroupedRow => ({
              type: "task",
              key: `task:${taskGroupKey(task)}`,
              task,
              groupId: group.id,
            }),
          )
        : [{ type: "empty" as const, key: `empty:${group.id}`, groupId: group.id }]),
    ];
  });
}

export function taskGroupTitleMessageId(
  group: Pick<TaskGroup, "id" | "title">,
): string | undefined {
  if (group.id === CRON_DEFAULT_GROUP_ID && group.title === "cron") return "taskGroup.cron";
  if (group.id === OFF_PEAK_DEFAULT_GROUP_ID && group.title === "off-peak")
    return "taskGroup.offPeak";
  return undefined;
}
