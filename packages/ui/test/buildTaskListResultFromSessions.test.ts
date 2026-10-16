import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import { buildTaskListResult, type TaskListKind } from "@/v4/buildTaskListResultFromSessions.js";
import {
  attachTaskListRowActivity,
  getTaskListRowActivity,
  isTaskListRowRunning,
} from "@/v4/taskListRowActivity.js";

function task(id: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    title: id,
    workspacePath: "/ws",
    createdAt: 0,
    updatedAt: Number(id.replace(/\D/g, "")) || 0,
    mode: "default",
    ...overrides,
  } as ZCodeTaskMeta;
}

const taskIndexItems = [
  task("t1", { updatedAt: 10, title: "alpha" }),
  task("t2", { updatedAt: 30, title: "beta" }),
  task("t3", { updatedAt: 20, title: "gamma" }),
];

function build(kind: TaskListKind, extra: Partial<Parameters<typeof buildTaskListResult>[0]> = {}) {
  return buildTaskListResult({
    taskIndexItems,
    sessions: [],
    kind,
    pinnedIds: new Set(extra.pinnedIds ?? []),
    archivedIds: new Set(extra.archivedIds ?? []),
    sortBy: "updated",
    ...extra,
  });
}

describe("buildTaskListResult", () => {
  it("timeline：非 pinned 非 archived，按 updatedAt 降序", () => {
    const r = build("timeline");
    expect(r.items.map((t) => t.taskId)).toEqual(["t2", "t3", "t1"]);
    expect(r.total).toBe(3);
  });

  it("timeline 排除 pinned + archived", () => {
    const r = build("timeline", { pinnedIds: new Set(["t2"]), archivedIds: new Set(["t3"]) });
    expect(r.items.map((t) => t.taskId)).toEqual(["t1"]);
  });

  it("pinned：只 pinned 且非 archived", () => {
    const r = build("pinned", { pinnedIds: new Set(["t1", "t2"]), archivedIds: new Set(["t2"]) });
    expect(r.items.map((t) => t.taskId)).toEqual(["t1"]);
  });

  it("archived：只 archived", () => {
    const r = build("archived", { archivedIds: new Set(["t3"]) });
    expect(r.items.map((t) => t.taskId)).toEqual(["t3"]);
  });

  it("active：非 archived（含 pinned）", () => {
    const r = build("active", { pinnedIds: new Set(["t2"]), archivedIds: new Set(["t1"]) });
    expect(r.items.map((t) => t.taskId).sort()).toEqual(["t2", "t3"]);
  });

  it("deleted tombstone 优先于所有 kind，普通 archived 对照仍只在归档列表", () => {
    const extra = {
      pinnedIds: new Set(["t2"]),
      archivedIds: new Set(["t2", "t3"]),
      deletedIds: new Set(["t2"]),
    };

    expect(build("timeline", extra).items.map((item) => item.taskId)).toEqual(["t1"]);
    expect(build("active", extra).items.map((item) => item.taskId)).toEqual(["t1"]);
    expect(build("pinned", extra).items).toEqual([]);
    expect(build("archived", extra).items.map((item) => item.taskId)).toEqual(["t3"]);
  });

  it("search 子串过滤 + limit 分页", () => {
    const r = build("timeline", { search: "a" });
    expect(r.total).toBe(3);
    const limited = build("timeline", { limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(3);
  });

  it("sortBy=created", () => {
    const r = buildTaskListResult({
      taskIndexItems: [task("t1", { createdAt: 5 }), task("t2", { createdAt: 9 })],
      sessions: [],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "created",
    });
    expect(r.items.map((t) => t.taskId)).toEqual(["t2", "t1"]);
  });

  it("两层排序：session running 置顶且 running 内按 createdAt 稳定排序", () => {
    const parent = attachTaskListRowActivity(
      task("parent", { createdAt: 10, updatedAt: 1_000, status: "running" }),
      { phase: "running", lastActivityAt: 1_000, hasBackgroundWork: false },
    );
    const fork = attachTaskListRowActivity(
      task("fork", { createdAt: 20, updatedAt: 1, status: "running" }),
      { phase: "running", lastActivityAt: 1, hasBackgroundWork: false },
    );
    const completed = attachTaskListRowActivity(
      task("completed", { createdAt: 30, updatedAt: 2_000, status: "completed" }),
      { phase: "completedSuccess", lastActivityAt: 2_000, hasBackgroundWork: false },
    );
    const r = buildTaskListResult({
      taskIndexItems: [
        task("parent", { createdAt: 10 }),
        task("fork", { createdAt: 20 }),
        task("completed", { createdAt: 30 }),
      ],
      sessions: [parent, fork, completed],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });

    expect(r.items.map((item) => item.taskId)).toEqual(["fork", "parent", "completed"]);
  });

  it("unreadAtByTaskId join：命中补 unreadAt，未命中不带", () => {
    const r = build("timeline", {
      unreadAtByTaskId: new Map([["t3", 123]]),
    });
    const byId = new Map(r.items.map((t) => [t.taskId, t]));
    expect(byId.get("t3")?.unreadAt).toBe(123);
    expect(byId.get("t2")?.unreadAt).toBeUndefined();
    expect(byId.get("t2")).toBe(taskIndexItems[1]);
  });

  it("unreadAtByTaskId join：map 已加载但未命中时清掉旧 unreadAt", () => {
    const stale = task("t4", { unreadAt: 456 });
    const r = buildTaskListResult({
      taskIndexItems: [stale],
      sessions: [],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
      unreadAtByTaskId: new Map(),
    });

    expect(r.items[0]?.unreadAt).toBeUndefined();
    expect(r.items[0]).not.toBe(stale);
  });

  it("terminalStatusByTaskId join：补历史终态，但不覆盖 session activity", () => {
    const persisted = [
      task("t4", { status: "completed" }),
      task("t5", { status: "running" }),
      task("t6", { status: "error" }),
      task("t7"),
    ];
    const liveRunning = attachTaskListRowActivity(task("t5", { status: "running" }), {
      phase: "running",
      lastActivityAt: 50,
      hasBackgroundWork: false,
    });
    const r = buildTaskListResult({
      taskIndexItems: persisted,
      sessions: [liveRunning],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
      terminalStatusByTaskId: new Map([
        ["t4", "error"],
        ["t5", "error"],
        ["t6", "completed"],
        ["t7", "completed"],
      ]),
    });
    const byId = new Map(r.items.map((item) => [item.taskId, item]));

    expect(byId.get("t4")?.status).toBe("error");
    expect(byId.get("t5")?.status).toBe("running");
    expect(byId.get("t6")?.status).toBe("error");
    expect(byId.get("t7")?.status).toBe("completed");
  });

  it("旧 task-index 手动标题覆盖 generated summary，session custom 标题反向胜出", () => {
    const legacyOverride = task("legacy", { title: "旧手动标题", titleOverridden: true });
    const generated = attachTaskListRowActivity(task("legacy", { title: "自动标题" }), {
      phase: "completedSuccess",
      lastActivityAt: 10,
      hasBackgroundWork: false,
    });
    const customTask = task("custom", { title: "旧 task-index 标题", titleOverridden: true });
    const custom = attachTaskListRowActivity(
      task("custom", { title: "新的自定义标题", titleOverridden: true }),
      { phase: "completedSuccess", lastActivityAt: 20, hasBackgroundWork: false },
    );
    const r = buildTaskListResult({
      taskIndexItems: [legacyOverride, customTask],
      sessions: [generated, custom],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });
    const byId = new Map(r.items.map((item) => [item.taskId, item]));

    expect(byId.get("legacy")?.title).toBe("旧手动标题");
    expect(byId.get("custom")?.title).toBe("新的自定义标题");
  });

  it("tasks-index 行数是列表权威：25 个 task + 5 个 summary 仍返回 25 行", () => {
    const persisted = Array.from({ length: 25 }, (_, index) =>
      task(`p${index + 1}`, { updatedAt: index + 1 }),
    );
    const sessionDetails = persisted
      .slice(0, 5)
      .map((item) =>
        attachTaskListRowActivity(
          task(item.taskId, { title: `live-${item.taskId}`, updatedAt: 1_000 }),
          { phase: "completedSuccess", lastActivityAt: 1_000, hasBackgroundWork: false },
        ),
      );

    const r = buildTaskListResult({
      taskIndexItems: persisted,
      sessions: sessionDetails,
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });

    expect(r.total).toBe(25);
    expect(r.items).toHaveLength(25);
    expect(r.items.filter((item) => getTaskListRowActivity(item) !== null)).toHaveLength(5);
  });

  it("summary 缺失时保留 task row，但历史 running 不产生实时 spinner", () => {
    const persisted = task("persisted", { status: "running" });
    const r = buildTaskListResult({
      taskIndexItems: [persisted],
      sessions: [],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });

    expect(r.items).toEqual([persisted]);
    expect(isTaskListRowRunning(r.items[0]!)).toBe(false);
  });

  it("session-only 冷摘要不绕过 tasks-index 进入持久列表", () => {
    const r = buildTaskListResult({
      taskIndexItems: [],
      sessions: [task("session-only")],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });

    expect(r.items).toEqual([]);
  });

  it("session detail 按 workspace identity + taskId join，同 path 不同 identity 不串行", () => {
    const persisted = task("shared", {
      title: "identity-a",
      workspacePath: "/same-path",
      workspaceIdentity: "remote::a",
    });
    const otherIdentity = attachTaskListRowActivity(
      task("shared", {
        title: "identity-b-live",
        workspacePath: "/same-path",
        workspaceIdentity: "remote::b",
      }),
      { phase: "running", lastActivityAt: 999, hasBackgroundWork: false },
    );
    const r = buildTaskListResult({
      taskIndexItems: [persisted],
      sessions: [otherIdentity],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });

    expect(r.items[0]?.title).toBe("identity-a");
    expect(getTaskListRowActivity(r.items[0]!)).toBeNull();
  });

  it("远端 task identity 命中 running summary 后附加 loading activity", () => {
    const workspaceIdentity = "remote:ssh:dev.example.test:22:coder:/same-path";
    const persisted = task("remote-running", {
      workspacePath: "/same-path",
      workspaceIdentity,
      status: "running",
    });
    const running = attachTaskListRowActivity(
      task("remote-running", {
        workspacePath: "/same-path",
        workspaceIdentity,
        status: "running",
      }),
      { phase: "running", lastActivityAt: 999, hasBackgroundWork: false },
    );
    const r = buildTaskListResult({
      taskIndexItems: [persisted],
      sessions: [running],
      kind: "timeline",
      pinnedIds: new Set(),
      archivedIds: new Set(),
      sortBy: "updated",
    });

    const item = r.items[0]!;
    const activity = getTaskListRowActivity(item);
    expect(activity?.phase).toBe("running");
    expect(deriveTaskLeadingIndicator(item, activity)).toBe("loading");
  });
});
