import type {
  GroupNode,
  MoveGroupNode,
  ProjectTask,
  TaskGroupStructure,
} from "@/project-sidebar/contract.js";
import { groupTaskRef, projectGroupedNodes } from "@/project-sidebar/grouped-view.js";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
} from "@/project-sidebar/grouped/types.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";

/** 旧组件只消费展示树；任务事实与组织结构仍来自当前唯一 owner。 */
export function buildGroupedTaskView(
  tasks: ProjectTask[],
  structure: TaskGroupStructure,
): ZCodeGroupedTaskView {
  const nodes: ZCodeGroupedTaskViewNode[] = [];
  const groups = new Map<string, Extract<ZCodeGroupedTaskViewNode, { type: "group" }>>();
  for (const row of projectGroupedNodes(tasks, structure, new Set())) {
    if (row.type === "group") {
      const node = { type: "group" as const, group: row.group, tasks: [] as ProjectTask[] };
      groups.set(row.group.id, node);
      nodes.push(node);
    } else if (row.type === "task") {
      if (row.groupId) groups.get(row.groupId)?.tasks.push(row.task);
      else nodes.push({ type: "task", task: row.task });
    }
  }
  return { nodes };
}

function locate(view: ZCodeGroupedTaskView, source: GroupNode) {
  for (const [index, node] of view.nodes.entries()) {
    if (source.type === "group" && node.type === "group" && node.group.id === source.groupId)
      return { groupId: null, index, siblings: view.nodes };
    if (source.type !== "task") continue;
    if (node.type === "task" && taskKey(node.task) === taskKey(source.task))
      return { groupId: null, index, siblings: view.nodes };
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === taskKey(source.task));
      if (taskIndex >= 0)
        return {
          groupId: node.group.id,
          index: taskIndex,
          siblings: node.tasks.map((task) => ({ type: "task" as const, task })),
        };
    }
  }
  return null;
}
const ref = (node: ZCodeGroupedTaskViewNode): GroupNode =>
  node.type === "group"
    ? { type: "group", groupId: node.group.id }
    : { type: "task", task: groupTaskRef(node.task) };

/** 旧版整表 applyOrder 会覆盖不可见成员；恢复交互时只提交被拖动节点和相邻锚点。 */
export function groupedMoveCommand(
  origin: ZCodeGroupedTaskView,
  preview: ZCodeGroupedTaskView,
  source: GroupNode,
): MoveGroupNode | null {
  const before = locate(origin, source),
    after = locate(preview, source);
  if (!before || !after || (before.groupId === after.groupId && before.index === after.index))
    return null;
  const next = after.siblings[after.index + 1],
    previous = after.siblings[after.index - 1];
  return {
    node: source,
    sourceGroupId: before.groupId,
    groupId: after.groupId,
    ...(next
      ? { anchor: { node: ref(next), side: "before" as const } }
      : previous
        ? { anchor: { node: ref(previous), side: "after" as const } }
        : {}),
  };
}
