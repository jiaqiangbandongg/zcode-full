// M5 ②：grouped 原始结构读取（queryGroupedTaskViewStructure）——
// 不 join tasks 表、无 normalize 写回；客户端与 sessions-index join 的服务端配套面。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

let tempDir: string;
const allRepos: TaskIndexRepo[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-grouped-structure-"));
  setDataBaseDir(tempDir);
});

afterEach(async () => {
  for (const repo of allRepos) {
    try {
      repo.close();
    } catch {
      // ignore close errors
    }
  }
  allRepos.length = 0;
  setDataBaseDir(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发权限问题，忽略
  }
});

function createTrackedRepo(): TaskIndexRepo {
  const repo = new TaskIndexRepo();
  allRepos.push(repo);
  return repo;
}

function createTask(taskId: string, createdAt: number): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/repo",
    createdAt,
    updatedAt: createdAt,
    mode: "build",
    status: "completed",
  };
}

describe("queryGroupedTaskViewStructure", () => {
  it("返回 group/member/顶层排序原始结构，不携带任务 meta", async () => {
    const repo = createTrackedRepo();
    await repo.syncTaskMeta({ meta: createTask("t1", 100) });
    await repo.syncTaskMeta({ meta: createTask("t2", 200) });
    const group = await repo.createTaskGroup({ title: "G1" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [
        { type: "group", groupId: group.id },
        { type: "task", task: { workspacePath: "/repo", taskId: "t2" } },
      ],
      groups: [
        {
          groupId: group.id,
          taskRefs: [{ workspacePath: "/repo", taskId: "t1" }],
        },
      ],
    });

    const structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });

    expect(structure.groups.map((entry) => entry.id)).toContain(group.id);
    const member = structure.members.find((entry) => entry.taskId === "t1");
    expect(member).toMatchObject({
      groupId: group.id,
      workspaceKey: "/repo",
      workspacePath: "/repo",
    });
    expect(typeof member?.sortOrder).toBe("number");
    const groupOrder = structure.topLevelOrders.find(
      (order) => order.type === "group" && order.groupId === group.id,
    );
    expect(groupOrder).toBeDefined();
    const taskOrder = structure.topLevelOrders.find(
      (order) => order.type === "task" && order.taskId === "t2",
    );
    expect(taskOrder).toMatchObject({ workspaceKey: "/repo" });
  });

  it("纯读：不触发 normalize 写回（重复查询结构一致）", async () => {
    const repo = createTrackedRepo();
    await repo.syncTaskMeta({ meta: createTask("t1", 100) });
    const first = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const second = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    // 未经过 queryGroupedTaskView 的懒补序，顶层排序表保持为空（结构读取不落库）。
    expect(first.topLevelOrders).toEqual([]);
    expect(second).toEqual(first);
  });
});
