import { describe, expect, it, vi } from "vitest";
import type { IZCodeTaskService } from "@zcode/services";
import {
  collectArchivedTaskDeletion,
  deleteArchivedTaskSelection,
  type ArchivedTaskDeletionWorkspace,
} from "@/lib/archivedTaskDeletion.js";

function workspace(identity?: string, count = 25): ArchivedTaskDeletionWorkspace {
  return {
    workspacePath: "/repo",
    workspaceIdentity: identity,
    label: identity ?? "local",
    service: {
      listArchivedTasks: vi.fn(async () =>
        Array.from({ length: count }, (_, index) => ({
          taskId: `task-${index}`,
          workspacePath: "/repo",
          workspaceIdentity: identity,
        })),
      ) as unknown as IZCodeTaskService["listArchivedTasks"],
      deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
        deletedTaskIds: taskIds,
        skippedTaskIds: [],
        failedTaskIds: [],
      })),
    },
  };
}

describe("归档任务批量删除", () => {
  it("完整收集跨 workspace 目标，重复 workspace 去重，超过 20 条也不截断；收集不写入", async () => {
    const local = workspace();
    const remote = workspace("remote:ssh:host:/repo", 2);
    const selection = await collectArchivedTaskDeletion([local, local, remote]);
    expect(selection.count).toBe(27);
    expect(local.service!.listArchivedTasks).toHaveBeenCalledTimes(1);
    expect(local.service!.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(remote.service!.listArchivedTasks).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: remote.workspaceIdentity,
    });
  });

  it("不连接不可访问项目，单 source 查询失败不阻断其它 source", async () => {
    const failed = workspace("remote:ssh:failed:/repo");
    vi.mocked(failed.service!.listArchivedTasks).mockRejectedValue(new Error("offline"));
    const offline = { ...workspace("remote:ssh:offline:/repo"), service: undefined };
    const selection = await collectArchivedTaskDeletion([workspace(), failed, offline]);
    expect(selection.count).toBe(25);
    expect(selection.unavailableWorkspaces).toEqual([failed.label, offline.label]);
  });

  it("只提交确认时的集合；跳过项和失败项不移除，后续项继续处理", async () => {
    const local = workspace(undefined, 4);
    const selection = await collectArchivedTaskDeletion([local]);
    vi.mocked(local.service!.listArchivedTasks).mockResolvedValue([]);
    vi.mocked(local.service!.deleteArchivedTasks).mockResolvedValueOnce({
      deletedTaskIds: ["task-0", "task-3"],
      skippedTaskIds: ["task-1"],
      failedTaskIds: ["task-2"],
    });
    const onDeleted = vi.fn();
    const result = await deleteArchivedTaskSelection(selection, onDeleted);
    expect(result).toMatchObject({ deleted: 2, skipped: 1, failed: 1 });
    expect(onDeleted.mock.calls.map(([target]) => target.taskId)).toEqual(["task-0", "task-3"]);
    expect(local.service!.listArchivedTasks).toHaveBeenCalledTimes(1);
    expect(local.service!.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      taskIds: ["task-0", "task-1", "task-2", "task-3"],
    });
  });

  it("每个 workspace 只提交一次批次；一个 source 失败不阻断同路径其它 identity", async () => {
    const local = workspace(undefined, 72);
    const remote = workspace("remote:ssh:host:/repo", 8);
    vi.mocked(remote.service!.deleteArchivedTasks).mockRejectedValueOnce(new Error("offline"));
    const selection = await collectArchivedTaskDeletion([local, remote]);
    const onDeleted = vi.fn();
    expect(await deleteArchivedTaskSelection(selection, onDeleted)).toMatchObject({
      deleted: 72,
      skipped: 0,
      failed: 8,
    });
    expect(onDeleted).toHaveBeenCalledTimes(72);
    expect(local.service!.deleteArchivedTasks).toHaveBeenCalledTimes(1);
    expect(remote.service!.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/repo",
      workspaceIdentity: remote.workspaceIdentity,
      taskIds: Array.from({ length: 8 }, (_, i) => `task-${i}`),
    });
  });

  it("空 workspace 不发送删除请求", async () => {
    const empty = workspace(undefined, 0);
    const selection = await collectArchivedTaskDeletion([empty]);
    expect(await deleteArchivedTaskSelection(selection, vi.fn())).toMatchObject({
      deleted: 0,
      skipped: 0,
      failed: 0,
    });
    expect(empty.service!.deleteArchivedTasks).not.toHaveBeenCalled();
  });
});
