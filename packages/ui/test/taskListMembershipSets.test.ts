import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  armTaskListMembershipRefreshHoldForE2E,
  fetchTaskListMembershipSets,
  getTaskListMembershipRefreshHoldStateForE2E,
  releaseTaskListMembershipRefreshHoldForE2E,
} from "@/lib/taskListMembershipSets.js";

function task(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}` as ZCodeTaskMeta["traceId"],
    title: taskId,
    workspacePath: "/ws",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    ...overrides,
  };
}

describe("fetchTaskListMembershipSets", () => {
  afterEach(() => {
    releaseTaskListMembershipRefreshHoldForE2E();
  });

  it("collects legacy task-index title overrides from active, pinned and archived membership reads", async () => {
    const result = await fetchTaskListMembershipSets({
      service: {
        listPinnedTaskIds: vi.fn(async () => ["pinned"]),
        listArchivedTasks: vi.fn(async () => [
          task("archived", {
            title: "归档自定义标题",
            titleOverridden: true,
          }),
        ]),
        listTasks: vi.fn(async () => [
          task("active", {
            title: "活跃自定义标题",
            titleOverridden: true,
            status: "error",
            cronAutomationId: "automation-active",
          }),
          task("plain", { title: "普通标题" }),
        ]),
        listPinnedTasks: vi.fn(async () => [
          task("pinned", {
            title: "置顶自定义标题",
            titleOverridden: true,
            unreadAt: 123,
            status: "completed",
            cronAutomationId: "automation-pinned",
          }),
        ]),
        listDeletedTaskIds: vi.fn(async () => ["deleted"]),
      },
      scopes: [{ workspacePath: "/ws" }],
    });

    expect([...result.titleOverrideByTaskId.entries()].sort()).toEqual([
      ["active", "活跃自定义标题"],
      ["archived", "归档自定义标题"],
      ["pinned", "置顶自定义标题"],
    ]);
    expect(result.unreadAtByTaskId.get("pinned")).toBe(123);
    expect([...result.terminalStatusByTaskId.entries()].sort()).toEqual([
      ["active", "error"],
      ["pinned", "completed"],
    ]);
    expect([...result.cronAutomationIdByTaskId.entries()].sort()).toEqual([
      ["active", "automation-active"],
      ["pinned", "automation-pinned"],
    ]);
    expect(result.taskIndexItems.map((item) => item.taskId).sort()).toEqual([
      "active",
      "archived",
      "pinned",
      "plain",
    ]);
    expect([...result.deletedIds]).toEqual(["deleted"]);
  });

  it("按 workspace 聚合 deleted tombstone，旧 endpoint 缺少方法时安全降级", async () => {
    const withDeleted = await fetchTaskListMembershipSets({
      service: {
        listPinnedTaskIds: vi.fn(async () => []),
        listArchivedTasks: vi.fn(async () => []),
        listTasks: vi.fn(async () => []),
        listPinnedTasks: vi.fn(async () => []),
        listDeletedTaskIds: vi.fn(async ({ workspaceIdentity }) => [
          `deleted-${workspaceIdentity ?? "local"}`,
        ]),
      },
      scopes: [{ workspacePath: "/ws" }, { workspacePath: "/ws", workspaceIdentity: "remote::a" }],
    });

    expect([...withDeleted.deletedIds].sort()).toEqual(["deleted-local", "deleted-remote::a"]);

    const legacyEndpoint = await fetchTaskListMembershipSets({
      service: {
        listPinnedTaskIds: vi.fn(async () => []),
        listArchivedTasks: vi.fn(async () => []),
        listTasks: vi.fn(async () => []),
        listPinnedTasks: vi.fn(async () => []),
      },
      scopes: [{ workspacePath: "/ws" }],
    });
    expect(legacyEndpoint.deletedIds.size).toBe(0);
  });

  it("task 行分区读取失败时拒绝发布权威空集", async () => {
    await expect(
      fetchTaskListMembershipSets({
        service: {
          listPinnedTaskIds: vi.fn(async () => []),
          listArchivedTasks: vi.fn(async () => []),
          listTasks: vi.fn(async () => Promise.reject(new Error("offline"))),
          listPinnedTasks: vi.fn(async () => []),
        },
        scopes: [{ workspacePath: "/ws" }],
      }),
    ).rejects.toThrow("tasks-index task 行读取不完整");
  });

  it("E2E gate 会暂停已读取的旧 membership 快照，直到测试显式释放", async () => {
    armTaskListMembershipRefreshHoldForE2E();
    let settled = false;
    const request = fetchTaskListMembershipSets({
      service: {
        listPinnedTaskIds: vi.fn(async () => []),
        listArchivedTasks: vi.fn(async () => []),
        listTasks: vi.fn(async () => [task("running", { status: "running" })]),
        listPinnedTasks: vi.fn(async () => []),
      },
      scopes: [{ workspacePath: "/ws" }],
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(getTaskListMembershipRefreshHoldStateForE2E().enteredCallCount).toBe(1);
    });
    expect(settled).toBe(false);

    releaseTaskListMembershipRefreshHoldForE2E();
    expect((await request).terminalStatusByTaskId.size).toBe(0);
    expect(settled).toBe(true);
  });
});
