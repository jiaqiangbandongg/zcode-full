import { describe, expect, it } from "vitest";
import type { ProjectTask, TaskGroupStructure } from "@/project-sidebar/contract.js";
import { buildGroupedTaskView, groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import {
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveGroupAroundTopLevelNode,
  moveTaskToTopByMenu,
} from "@/project-sidebar/grouped/view.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import { groupTaskRef, taskGroupKey } from "@/project-sidebar/grouped-view.js";

const task = (id: string, extra = {}): ProjectTask => ({
  taskId: id,
  workspacePath: "/workspace",
  hostId: "local",
  projectId: null,
  title: id,
  mode: "build",
  traceId: id,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const a = task("a"),
  b = task("b"),
  hidden = task("hidden", { archived: true });
const structure: TaskGroupStructure = {
  groups: [
    { id: "g", title: "Group", color: "blue", createdAt: 1, updatedAt: 1 },
    { id: "empty", title: "Empty", color: "gray", createdAt: 1, updatedAt: 1 },
  ],
  members: [
    { groupId: "g", workspaceKey: a.workspacePath, taskId: a.taskId, sortOrder: 0 },
    { groupId: "g", workspaceKey: hidden.workspacePath, taskId: hidden.taskId, sortOrder: 1 },
  ],
  order: [
    { type: "group", key: "g", sortOrder: 0 },
    { type: "task", key: taskGroupKey(b), sortOrder: 1 },
    { type: "group", key: "empty", sortOrder: 2 },
  ],
};
const origin = () => buildGroupedTaskView([a, b, hidden], structure);

describe("GRP11：旧拖动语义只提交单节点，不回写可见列表", () => {
  it("拖进空组保持旧 preview，提交保留来源且不包含隐藏成员", () => {
    const view = origin();
    const preview = moveTaskToGroupStart(view, { activeTaskKey: taskKey(a), groupId: "empty" });
    expect(groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(a) })).toEqual({
      node: { type: "task", task: groupTaskRef(a) },
      sourceGroupId: "g",
      groupId: "empty",
    });
    expect(structure.members).toHaveLength(2);
    expect(view.nodes[0]).toMatchObject({ type: "group", tasks: [a] });
  });
  it("拖过折叠组保留旧顶层前后位置，不能误当成入组", () => {
    const view = origin();
    const preview = moveTaskToRootAroundGroup(view, {
      activeTaskKey: taskKey(a),
      groupId: "empty",
      position: "after",
    });
    expect(groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(a) })).toEqual({
      node: { type: "task", task: groupTaskRef(a) },
      sourceGroupId: "g",
      groupId: null,
      anchor: { node: { type: "group", groupId: "empty" }, side: "after" },
    });
  });
  it("组和顶层任务混排只移动当前组", () => {
    const view = origin();
    const preview = moveGroupAroundTopLevelNode(view, {
      activeGroupId: "empty",
      over: { type: "task", taskKey: taskKey(b) },
      position: "before",
    });
    expect(groupedMoveCommand(view, preview, { type: "group", groupId: "empty" })).toEqual({
      node: { type: "group", groupId: "empty" },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "task", task: groupTaskRef(b) }, side: "before" },
    });
  });
  it("旧移到顶部只调整所在层级，不置顶、不改项目", () => {
    const view = origin();
    const preview = moveTaskToTopByMenu(view, b);
    expect(groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(b) })).toEqual({
      node: { type: "task", task: groupTaskRef(b) },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "group", groupId: "g" }, side: "before" },
    });
    expect(b.pinned).toBe(false);
    expect(b.projectId).toBeNull();
  });
  it("取消、无移动和分屏接管不产生组织命令", () => {
    const view = origin();
    expect(groupedMoveCommand(view, view, { type: "task", task: groupTaskRef(a) })).toBeNull();
  });
  it("同路径同 taskId 的两个 Host 不串行", () => {
    const remote = task("a", {
      workspaceIdentity: "remote:server:other:/workspace",
      hostId: "remote:server:other",
    });
    const view = buildGroupedTaskView([a, remote], structure);
    const preview = moveTaskToGroupStart(view, { activeTaskKey: taskKey(remote), groupId: "g" });
    expect(
      groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(remote) }),
    ).toMatchObject({
      node: { task: { workspaceIdentity: remote.workspaceIdentity, hostId: remote.hostId } },
      sourceGroupId: null,
      groupId: "g",
    });
  });
});
