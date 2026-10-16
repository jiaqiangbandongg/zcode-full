// M5 ②：grouped 客户端 join（分组原始结构 + sessions-index 会话 → 旧 listGroupedTaskView 同形视图）。
import { describe, expect, it } from "vitest";
import type { ZCodeGroupedTaskViewStructure, ZCodeTaskGroup } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildGroupedTaskViewFromSessions } from "@/lib/buildGroupedTaskViewFromSessions.js";

function task(id: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    title: id,
    workspacePath: "/ws",
    createdAt: 0,
    updatedAt: 0,
    mode: "default",
    traceId: `trace-${id}`,
    ...overrides,
  } as ZCodeTaskMeta;
}

function group(id: string, createdAt = 0): ZCodeTaskGroup {
  return { id, title: id, color: "blue", createdAt, updatedAt: createdAt };
}

function structure(
  overrides: Partial<ZCodeGroupedTaskViewStructure> = {},
): ZCodeGroupedTaskViewStructure {
  return { groups: [], members: [], topLevelOrders: [], ...overrides };
}

function describeView(
  view: ReturnType<typeof buildGroupedTaskViewFromSessions>,
): Array<string | string[]> {
  return view.nodes.map((node) =>
    node.type === "group"
      ? [node.group.id, ...node.tasks.map((item) => item.taskId)]
      : node.task.taskId,
  );
}

describe("buildGroupedTaskViewFromSessions", () => {
  it("组成员按 member sort_order 排序；非成员进顶层；pinned/archived 排除", () => {
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        groups: [group("g1")],
        members: [
          {
            groupId: "g1",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "t1",
            sortOrder: 2000,
            addedAt: 1,
          },
          {
            groupId: "g1",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "t2",
            sortOrder: 1000,
            addedAt: 2,
          },
        ],
        topLevelOrders: [
          { type: "group", groupId: "g1", sortOrder: 1000 },
          { type: "task", workspaceKey: "/ws", taskId: "t3", sortOrder: 2000 },
        ],
      }),
      taskIndexItems: [task("t1"), task("t2"), task("t3"), task("t4-pinned"), task("t5-archived")],
      sessions: [],
      pinnedIds: new Set(["t4-pinned"]),
      archivedIds: new Set(["t5-archived"]),
    });
    // t3 有顶层序 2000 在 g1（1000）之后。
    expect(describeView(view)).toEqual([["g1", "t2", "t1"], "t3"]);
  });

  it("缺 sort_order 的组成员按 added_at 降序补在已有成员之后（内存补序）", () => {
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        groups: [group("g1")],
        members: [
          {
            groupId: "g1",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "t1",
            sortOrder: 1000,
            addedAt: 1,
          },
          {
            groupId: "g1",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "t2",
            sortOrder: null,
            addedAt: 5,
          },
          {
            groupId: "g1",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "t3",
            sortOrder: null,
            addedAt: 9,
          },
        ],
        topLevelOrders: [{ type: "group", groupId: "g1", sortOrder: 1000 }],
      }),
      taskIndexItems: [task("t1"), task("t2"), task("t3")],
      sessions: [],
      pinnedIds: new Set(),
      archivedIds: new Set(),
    });
    // 缺序成员 addedAt 降序（t3 先于 t2）追加在已有序成员之后。
    expect(describeView(view)).toEqual([["g1", "t1", "t3", "t2"]]);
  });

  it("不可见 bootstrap 组的成员也不出现在顶层（服务端排除规则一致）", () => {
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        // groups 已被服务端按 workspaceScopes 过滤——g-hidden 不在其中，但成员仍在全量 members 里。
        groups: [],
        members: [
          {
            groupId: "g-hidden",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "t1",
            sortOrder: 1000,
            addedAt: 1,
          },
        ],
        topLevelOrders: [],
      }),
      taskIndexItems: [task("t1"), task("t2")],
      sessions: [],
      pinnedIds: new Set(),
      archivedIds: new Set(),
    });
    expect(describeView(view)).toEqual(["t2"]);
  });

  it("顶层缺序节点按 createdAt 降序补内存序（新的在前，已有序的按序）", () => {
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        groups: [group("g1", 10)],
        topLevelOrders: [
          { type: "task", workspaceKey: "/ws", taskId: "t-ordered", sortOrder: 500 },
        ],
      }),
      taskIndexItems: [task("t-ordered", { createdAt: 1 }), task("t-new", { createdAt: 99 })],
      sessions: [],
      pinnedIds: new Set(),
      archivedIds: new Set(),
    });
    // 有序节点(500)在前；缺序节点（t-new createdAt 99 > g1 createdAt 10）按创建时间降序补在其后。
    expect(describeView(view)).toEqual(["t-ordered", "t-new", ["g1"]]);
  });

  it("workspaceIdentity 参与 join 键：同 taskId 不同 workspace 不串组", () => {
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        groups: [group("g1")],
        members: [
          {
            groupId: "g1",
            workspaceKey: "remote::x",
            workspacePath: "/ws",
            workspaceIdentity: "remote::x",
            taskId: "t1",
            sortOrder: 1000,
            addedAt: 1,
          },
        ],
        topLevelOrders: [{ type: "group", groupId: "g1", sortOrder: 1000 }],
      }),
      // 本地 /ws 的 t1 与 remote::x 的成员不是同一个 task → 留在顶层。
      taskIndexItems: [task("t1")],
      sessions: [],
      pinnedIds: new Set(),
      archivedIds: new Set(),
    });
    expect(describeView(view)).toEqual([["g1"], "t1"]);
  });

  it("sessions-index 残留 deleted 摘要时，以 tasks-index 行集合隐藏它", () => {
    const active = task("active");
    const deleted = task("deleted");
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        groups: [group("g1")],
        members: [
          {
            groupId: "g1",
            workspaceKey: "/ws",
            workspacePath: "/ws",
            taskId: "deleted",
            sortOrder: 1000,
            addedAt: 1,
          },
        ],
        topLevelOrders: [{ type: "group", groupId: "g1", sortOrder: 1000 }],
      }),
      taskIndexItems: [active],
      sessions: [active, deleted],
      pinnedIds: new Set(),
      archivedIds: new Set(),
    });

    expect(describeView(view)).toEqual([["g1"], "active"]);
  });

  it("task row 意外残留时仍以 deleted tombstone 排除", () => {
    const deleted = task("deleted");
    const view = buildGroupedTaskViewFromSessions({
      structure: structure(),
      taskIndexItems: [deleted],
      sessions: [deleted],
      pinnedIds: new Set(),
      archivedIds: new Set(),
      deletedIds: new Set(["deleted"]),
    });

    expect(describeView(view)).toEqual([]);
  });

  it("tasks-index 有 25 个 group members、sessions-index 只有 5 个摘要时仍显示 25 个", () => {
    const tasks = Array.from({ length: 25 }, (_, index) => task(`t${index + 1}`));
    const members = tasks.map((item, index) => ({
      groupId: "g1",
      workspaceKey: "/ws",
      workspacePath: "/ws",
      taskId: item.taskId,
      sortOrder: (index + 1) * 1000,
      addedAt: index + 1,
    }));
    const view = buildGroupedTaskViewFromSessions({
      structure: structure({
        groups: [group("g1")],
        members,
        topLevelOrders: [{ type: "group", groupId: "g1", sortOrder: 1000 }],
      }),
      taskIndexItems: tasks,
      sessions: tasks.slice(0, 5),
      pinnedIds: new Set(),
      archivedIds: new Set(),
    });

    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]?.type).toBe("group");
    if (view.nodes[0]?.type !== "group") throw new Error("expected grouped node");
    expect(view.nodes[0].tasks).toHaveLength(25);
  });
});
