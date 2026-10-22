import { describe, it, expect } from "vitest";
import {
  taskGroupTitleMessageId,
  projectGroupedNodes,
  taskGroupKey,
} from "@/project-sidebar/grouped-view.js";
import type { ProjectTask, TaskGroupStructure } from "@/project-sidebar/contract.js";
const task = (id: string, patch = {}): ProjectTask => ({
  taskId: id,
  hostId: "local",
  workspacePath: "/same",
  title: id,
  traceId: id,
  mode: "build",
  projectId: "project",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  ...patch,
});
describe("grouped projection", () => {
  it("joins exact identities, keeps empty groups, and hides pinned/archived without changing membership", () => {
    const a = task("same"),
      b = task("same", { hostId: "remote:server:s", workspaceIdentity: "remote:server:s:/same" });
    const hidden = task("hidden", { archived: true });
    const structure: TaskGroupStructure = {
      groups: [{ id: "g", title: "G", color: "blue", createdAt: 1, updatedAt: 1 }],
      members: [
        { groupId: "g", workspaceKey: "/same", taskId: "same", sortOrder: 1 },
        { groupId: "g", workspaceKey: "/same", taskId: "hidden", sortOrder: 0 },
      ],
      order: [],
    };
    const before = JSON.stringify(structure);
    const rows = projectGroupedNodes([a, b, hidden], structure, new Set());
    expect(rows.map((row) => row.key)).toEqual([
      "group:g",
      `task:${taskGroupKey(a)}`,
      `task:${taskGroupKey(b)}`,
    ]);
    expect(
      projectGroupedNodes([{ ...a, pinned: true }], structure, new Set()).map((r) => r.type),
    ).toEqual(["group", "empty"]);
    expect(projectGroupedNodes([a], structure, new Set(["g"])).map((r) => r.type)).toEqual([
      "group",
    ]);
    expect(JSON.stringify(structure)).toBe(before);
  });
  it("uses persisted order without promoting a running task or losing a new row", () => {
    const a = task("a"),
      b = task("b"),
      c = task("c");
    const rows = projectGroupedNodes(
      [c, b, a],
      {
        groups: [],
        members: [],
        order: [
          { type: "task", key: taskGroupKey(a), sortOrder: 0 },
          { type: "task", key: taskGroupKey(b), sortOrder: 1 },
        ],
      },
      new Set(),
    );
    expect(rows.map((r) => r.type === "task" && r.task.taskId)).toEqual(["a", "b", "c"]);
  });
});

it("localizes only untouched system group names", () => {
  expect(taskGroupTitleMessageId({ id: "custom", title: "cron" })).toBeUndefined();
  expect(taskGroupTitleMessageId({ id: "zcode-default-group-cron", title: "cron" })).toBe(
    "taskGroup.cron",
  );
  expect(taskGroupTitleMessageId({ id: "zcode-default-group-off-peak", title: "off-peak" })).toBe(
    "taskGroup.offPeak",
  );
  expect(
    taskGroupTitleMessageId({ id: "zcode-default-group-cron", title: "renamed" }),
  ).toBeUndefined();
});
