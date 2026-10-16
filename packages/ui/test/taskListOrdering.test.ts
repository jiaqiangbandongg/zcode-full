import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

function task(id: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    traceId: `trace-${id}`,
    title: id,
    workspacePath: "/ws",
    createdAt: 0,
    updatedAt: 0,
    mode: "default",
    ...overrides,
  };
}

function liveTask(
  id: string,
  phase: "prewarming" | "running" | "completedSuccess",
  overrides: Partial<ZCodeTaskMeta> = {},
): ZCodeTaskMeta {
  const meta = task(id, overrides);
  return attachTaskListRowActivity(meta, {
    phase,
    lastActivityAt: meta.updatedAt,
    hasBackgroundWork: false,
  });
}

function sortedIds(tasks: ZCodeTaskMeta[], sortBy: "created" | "updated"): string[] {
  return [...tasks]
    .sort((left, right) => compareZCodeTaskListItems(left, right, sortBy))
    .map((item) => item.taskId);
}

describe("taskListOrdering", () => {
  it("把 prewarming/running 放在非运行任务之前", () => {
    const tasks = [
      liveTask("completed-newest", "completedSuccess", {
        createdAt: 300,
        updatedAt: 1_000,
      }),
      liveTask("running", "running", { createdAt: 100, updatedAt: 1 }),
      liveTask("prewarming", "prewarming", { createdAt: 200, updatedAt: 2 }),
    ];

    expect(sortedIds(tasks, "updated")).toEqual(["prewarming", "running", "completed-newest"]);
    expect(sortedIds(tasks, "created")).toEqual(["prewarming", "running", "completed-newest"]);
  });

  it("并发 running 只按 createdAt 排序，updatedAt 交替时 fork 位置不抖动", () => {
    const before = [
      liveTask("parent", "running", { createdAt: 100, updatedAt: 900 }),
      liveTask("fork", "running", { createdAt: 200, updatedAt: 100 }),
    ];
    const after = [
      liveTask("parent", "running", { createdAt: 100, updatedAt: 100 }),
      liveTask("fork", "running", { createdAt: 200, updatedAt: 900 }),
    ];

    expect(sortedIds(before, "updated")).toEqual(["fork", "parent"]);
    expect(sortedIds(after, "updated")).toEqual(["fork", "parent"]);
  });

  it("running 创建时间相同时使用稳定 taskId 决胜，不读取 updatedAt", () => {
    const before = [
      liveTask("task-a", "running", { createdAt: 100, updatedAt: 900 }),
      liveTask("task-b", "running", { createdAt: 100, updatedAt: 100 }),
    ];
    const after = [
      liveTask("task-a", "running", { createdAt: 100, updatedAt: 100 }),
      liveTask("task-b", "running", { createdAt: 100, updatedAt: 900 }),
    ];

    expect(sortedIds(before, "updated")).toEqual(["task-b", "task-a"]);
    expect(sortedIds(after, "updated")).toEqual(["task-b", "task-a"]);
  });

  it("有后台工作（如 dwf run）的已收口会话进入运行层，updatedAt 交替时不换位", () => {
    // Bug 场景：两个会话各挂一个后台 workflow run，父会话 phase 已是 completedSuccess，
    // 但每条 run 进度事件都会推进 lastActivityAt；若只按 phase 判定运行层，两行会随事件互换。
    const backgrounded = (id: string, createdAt: number, updatedAt: number) =>
      attachTaskListRowActivity(task(id, { createdAt, updatedAt }), {
        phase: "completedSuccess",
        lastActivityAt: updatedAt,
        hasBackgroundWork: true,
      });
    const before = [
      backgrounded("run-a", 100, 900),
      backgrounded("run-b", 200, 100),
      liveTask("idle-newest", "completedSuccess", { createdAt: 300, updatedAt: 5_000 }),
    ];
    const after = [
      backgrounded("run-a", 100, 100),
      backgrounded("run-b", 200, 900),
      liveTask("idle-newest", "completedSuccess", { createdAt: 300, updatedAt: 5_000 }),
    ];

    expect(sortedIds(before, "updated")).toEqual(["run-b", "run-a", "idle-newest"]);
    expect(sortedIds(after, "updated")).toEqual(["run-b", "run-a", "idle-newest"]);
    expect(sortedIds(after, "created")).toEqual(["run-b", "run-a", "idle-newest"]);
  });

  it("后台工作结束后会话退出运行层，按 Updated 偏好落位", () => {
    const settled = attachTaskListRowActivity(task("settled", { createdAt: 100, updatedAt: 900 }), {
      phase: "completedSuccess",
      lastActivityAt: 900,
      hasBackgroundWork: false,
    });
    const running = liveTask("running", "running", { createdAt: 50, updatedAt: 1 });
    const older = liveTask("older", "completedSuccess", { createdAt: 300, updatedAt: 500 });

    expect(sortedIds([older, settled, running], "updated")).toEqual([
      "running",
      "settled",
      "older",
    ]);
  });

  it("非运行任务继续尊重 Created/Updated 偏好", () => {
    const tasks = [
      liveTask("newer-created", "completedSuccess", { createdAt: 20, updatedAt: 10 }),
      liveTask("newer-updated", "completedSuccess", { createdAt: 10, updatedAt: 20 }),
    ];

    expect(sortedIds(tasks, "created")).toEqual(["newer-created", "newer-updated"]);
    expect(sortedIds(tasks, "updated")).toEqual(["newer-updated", "newer-created"]);
  });

  it("不采信缺少 sessions-index activity 的历史 status=running", () => {
    const staleRunning = task("stale-running", {
      status: "running",
      createdAt: 10,
      updatedAt: 10,
    });
    const liveCompleted = liveTask("completed", "completedSuccess", {
      createdAt: 20,
      updatedAt: 20,
    });

    expect(sortedIds([staleRunning, liveCompleted], "updated")).toEqual([
      "completed",
      "stale-running",
    ]);
  });
});
