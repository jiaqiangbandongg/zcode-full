import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

let tempDir: string;
// 跟踪所有创建的 repo 用于清理
const allRepos: TaskIndexRepo[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-grouped-task-view-"));
  setDataBaseDir(tempDir);
});

afterEach(async () => {
  // 先关闭所有 repo 确保 SQLite 连接释放，避免 Windows EPERM
  for (const repo of allRepos) {
    try {
      repo.close();
    } catch {
      // ignore close errors
    }
  }
  allRepos.length = 0;
  setDataBaseDir(null);
  // Windows 需要等待一下让文件句柄释放
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows 有时仍会有权限问题，忽略即可
  }
});

// 辅助函数：创建并跟踪repo
function createTrackedRepo(): TaskIndexRepo {
  const repo = new TaskIndexRepo();
  allRepos.push(repo);
  return repo;
}

function createTask(
  taskId: string,
  createdAt: number,
  overrides: Partial<ZCodeTaskMeta> = {},
): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/repo",
    createdAt,
    updatedAt: createdAt,
    mode: "build",
    status: "completed",
    ...overrides,
  };
}

async function seedTask(
  repo: TaskIndexRepo,
  taskId: string,
  createdAt: number,
  overrides: Partial<ZCodeTaskMeta> = {},
): Promise<ZCodeTaskMeta> {
  return repo.syncTaskMeta({ meta: createTask(taskId, createdAt, overrides) });
}

async function listNodeIds(repo: TaskIndexRepo): Promise<string[]> {
  const view = await repo.queryGroupedTaskView({
    workspaceScopes: [{ workspacePath: "/repo" }],
  });
  return view.nodes.map((node) =>
    node.type === "group" ? `group:${node.group.id}` : node.task.taskId,
  );
}

async function listNodeOrders(repo: TaskIndexRepo): Promise<
  Array<{
    id: string;
    sortOrder: number | null;
  }>
> {
  const view = await repo.queryGroupedTaskView({
    workspaceScopes: [{ workspacePath: "/repo" }],
  });
  return view.nodes.map((node) => ({
    id: node.type === "group" ? `group:${node.group.id}` : node.task.taskId,
    sortOrder: node.sortOrder ?? null,
  }));
}

async function listGroupTaskOrders(
  repo: TaskIndexRepo,
  groupId: string,
): Promise<Array<{ id: string; sortOrder: number | null }>> {
  await repo.queryGroupedTaskView({
    workspaceScopes: [{ workspacePath: "/repo" }],
  });
  return getRepoDatabase(repo)
    .prepare(
      `SELECT task_id, sort_order
      FROM task_group_members
      WHERE group_id = ?
      ORDER BY sort_order`,
    )
    .all(groupId)
    .map((row) => ({
      id: String(row.task_id),
      sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    }));
}

function getRepoDatabase(repo: TaskIndexRepo): {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  exec(sql: string): void;
} {
  return (
    repo as unknown as {
      getDatabase(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
          all(...params: unknown[]): Array<Record<string, unknown>>;
        };
      };
    }
  ).getDatabase();
}

it("rolls back the task row when grouped root admission cannot write its order", async () => {
  const repo = createTrackedRepo();
  // 先初始化 schema，再用 trigger 模拟 grouped order 写失败，证明 task row 不会部分提交。
  await repo.queryGroupedTaskView({ workspaceScopes: [{ workspacePath: "/repo" }] });
  const database = getRepoDatabase(repo);
  database.exec(`
    CREATE TRIGGER reject_grouped_root_order
    BEFORE INSERT ON task_group_view_node_orders
    WHEN NEW.node_type = 'task'
    BEGIN
      SELECT RAISE(ABORT, 'reject grouped root order');
    END
  `);

  await expect(
    repo.syncTaskMetaAtGroupedTop({ meta: createTask("atomic-task", 100) }),
  ).rejects.toThrow("reject grouped root order");

  expect(
    database
      .prepare("SELECT task_id FROM tasks WHERE workspace_key = ? AND task_id = ?")
      .get("/repo", "atomic-task"),
  ).toBeUndefined();
});

it.each([false, true])(
  "deleting a task atomically removes its grouped membership and task order (guarded=%s)",
  async (guarded) => {
    const repo = createTrackedRepo();
    const task = await seedTask(repo, "deleted-task", 100);
    const group = await repo.createTaskGroup({ title: "Group" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [{ type: "group", groupId: group.id }],
      groups: [
        {
          groupId: group.id,
          taskRefs: [
            {
              workspacePath: task.workspacePath,
              workspaceIdentity: task.workspaceIdentity,
              taskId: task.taskId,
            },
          ],
        },
      ],
    });
    if (guarded)
      await repo.updateTaskState({
        workspacePath: task.workspacePath,
        taskId: task.taskId,
        patch: { archived: true },
      });
    const database = getRepoDatabase(repo);
    const insertOrder = database.prepare(
      `INSERT INTO task_group_view_node_orders (
      node_type, node_key, sort_order, created_at, updated_at
    ) VALUES ('task', ?, ?, ?, ?)`,
    );
    insertOrder.run(JSON.stringify(["/repo", task.taskId]), 2000, 100, 100);
    // 早期 NUL node_key 经 node:sqlite 读取后只剩 workspace key，也一并验证清理。
    insertOrder.run("/repo", 3000, 100, 100);

    await (guarded
      ? repo.deleteArchivedTask({ workspacePath: task.workspacePath, taskId: task.taskId })
      : repo.updateTaskState({
          workspacePath: task.workspacePath,
          taskId: task.taskId,
          patch: { deleted: true },
        }));

    expect(
      database
        .prepare("SELECT deleted FROM tasks WHERE workspace_key = ? AND task_id = ?")
        .get("/repo", task.taskId),
    ).toEqual({ deleted: 1 });
    expect(
      database
        .prepare("SELECT task_id FROM task_group_members WHERE workspace_key = ? AND task_id = ?")
        .get("/repo", task.taskId),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all(),
    ).toEqual([]);
  },
);

it.each([false, true])(
  "rolls back the deleted flag when grouped reference cleanup fails (guarded=%s)",
  async (guarded) => {
    const repo = createTrackedRepo();
    const task = await seedTask(repo, "rollback-delete", 100);
    const group = await repo.createTaskGroup({ title: "Group" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [{ type: "group", groupId: group.id }],
      groups: [
        {
          groupId: group.id,
          taskRefs: [
            {
              workspacePath: task.workspacePath,
              taskId: task.taskId,
            },
          ],
        },
      ],
    });
    if (guarded)
      await repo.updateTaskState({
        workspacePath: task.workspacePath,
        taskId: task.taskId,
        patch: { archived: true },
      });
    const database = getRepoDatabase(repo);
    database.exec(`
    CREATE TRIGGER reject_deleted_task_membership_cleanup
    BEFORE DELETE ON task_group_members
    WHEN OLD.task_id = 'rollback-delete'
    BEGIN
      SELECT RAISE(ABORT, 'reject deleted task cleanup');
    END
  `);

    await expect(
      guarded
        ? repo.deleteArchivedTask({ workspacePath: task.workspacePath, taskId: task.taskId })
        : repo.updateTaskState({
            workspacePath: task.workspacePath,
            taskId: task.taskId,
            patch: { deleted: true },
          }),
    ).rejects.toThrow("reject deleted task cleanup");

  expect(
    database
      .prepare("SELECT deleted FROM tasks WHERE workspace_key = ? AND task_id = ?")
      .get("/repo", task.taskId),
  ).toEqual({ deleted: 0 });
  expect(
    database
      .prepare("SELECT task_id FROM task_group_members WHERE workspace_key = ? AND task_id = ?")
      .get("/repo", task.taskId),
  ).toEqual({ task_id: task.taskId });
});

it("cleans historical deleted task grouping references when the index reopens", async () => {
  const repo = createTrackedRepo();
  const task = await seedTask(repo, "historical-deleted", 100);
  const group = await repo.createTaskGroup({ title: "Group" });
  await repo.applyGroupedTaskViewOrder({
    workspaceScopes: [{ workspacePath: "/repo" }],
    topLevelNodes: [{ type: "group", groupId: group.id }],
    groups: [
      {
        groupId: group.id,
        taskRefs: [{ workspacePath: task.workspacePath, taskId: task.taskId }],
      },
    ],
  });
  const database = getRepoDatabase(repo);
  database
    .prepare("UPDATE tasks SET deleted = 1 WHERE workspace_key = ? AND task_id = ?")
    .run("/repo", task.taskId);
  database
    .prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type, node_key, sort_order, created_at, updated_at
      ) VALUES ('task', ?, ?, ?, ?)`,
    )
    .run(JSON.stringify(["/repo", task.taskId]), 2000, 100, 100);
  repo.close();

  const reopenedRepo = createTrackedRepo();
  await reopenedRepo.ensureReady();
  const reopenedDatabase = getRepoDatabase(reopenedRepo);

  expect(
    reopenedDatabase
      .prepare("SELECT task_id FROM task_group_members WHERE workspace_key = ? AND task_id = ?")
      .get("/repo", task.taskId),
  ).toBeUndefined();
  expect(
    reopenedDatabase
      .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
      .all(),
  ).toEqual([]);
});

describe("grouped task view order", () => {
  it("keeps conversation tasks ungrouped during the legacy workspace bootstrap", async () => {
    const repo = createTrackedRepo();
    await seedTask(repo, "conversation-task", 100, {
      workspacePath: "/Users/demo/.zcode/workspace/default",
      workspacePurpose: "conversation",
    });

    const view = await repo.queryGroupedTaskView({
      workspaceScopes: [
        {
          workspacePath: "/Users/demo/.zcode/workspace/default",
          workspacePurpose: "conversation",
        },
      ],
    });

    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]?.type).toBe("task");
  });

  it("stamps conversation purpose from the query scope onto task-list results", async () => {
    const repo = createTrackedRepo();
    const workspacePath = "/Users/demo/.zcode/workspace/default";
    await seedTask(repo, "conversation-list-task", 100, { workspacePath });

    const result = await repo.queryTaskList({
      kind: "timeline",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath, workspacePurpose: "conversation" }],
    });

    expect(result.items[0]?.workspacePurpose).toBe("conversation");
  });

  it("bootstraps workspace groups by updated time and gives new manual groups top order", async () => {
    const repo = createTrackedRepo();
    await seedTask(repo, "old-task", 100);
    await seedTask(repo, "new-task", 200);

    const bootstrappedView = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const workspaceGroupNode = bootstrappedView.nodes[0];
    expect(workspaceGroupNode?.type).toBe("group");
    if (workspaceGroupNode?.type !== "group") {
      throw new Error("expected workspace group node");
    }
    expect(workspaceGroupNode.group.id).toMatch(/^workspace-group-/u);
    expect(workspaceGroupNode.tasks.map((task) => task.taskId)).toEqual(["new-task", "old-task"]);
    expect(await listGroupTaskOrders(repo, workspaceGroupNode.group.id)).toEqual([
      { id: "new-task", sortOrder: 1000 },
      { id: "old-task", sortOrder: 2000 },
    ]);

    const group = await repo.createTaskGroup({ title: "Group" });
    expect(await listNodeIds(repo)).toEqual([
      `group:${group.id}`,
      `group:${workspaceGroupNode.group.id}`,
    ]);
    expect(await listNodeOrders(repo)).toEqual([
      { id: `group:${group.id}`, sortOrder: 0 },
      { id: `group:${workspaceGroupNode.group.id}`, sortOrder: 1000 },
    ]);
  });

  it("can list grouped tasks across workspaces without being limited to opened workspace scopes", async () => {
    const repo = createTrackedRepo();
    await seedTask(repo, "open-task", 100, { workspacePath: "/repo/open" });
    await seedTask(repo, "closed-task", 200, { workspacePath: "/repo/closed" });

    const scopedView = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo/open" }],
    });
    const allWorkspaceView = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo/open" }],
      includeAllWorkspaces: true,
    });

    const readTaskIds = (view: Awaited<ReturnType<typeof repo.queryGroupedTaskView>>) =>
      view.nodes.flatMap((node) =>
        node.type === "group" ? node.tasks.map((task) => task.taskId) : [node.task.taskId],
      );

    expect(readTaskIds(scopedView)).toEqual(["open-task"]);
    expect(readTaskIds(allWorkspaceView).sort()).toEqual(["closed-task", "open-task"]);
  });

  it("initializes missing group member orders by added time", async () => {
    const repo = createTrackedRepo();
    const oldTask = await seedTask(repo, "old-task", 100);
    const newTask = await seedTask(repo, "new-task", 200);
    const group = await repo.createTaskGroup({ title: "Group" });

    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [{ type: "group", groupId: group.id }],
      groups: [
        {
          groupId: group.id,
          taskRefs: [
            {
              workspacePath: oldTask.workspacePath,
              workspaceIdentity: oldTask.workspaceIdentity,
              taskId: oldTask.taskId,
            },
            {
              workspacePath: newTask.workspacePath,
              workspaceIdentity: newTask.workspaceIdentity,
              taskId: newTask.taskId,
            },
          ],
        },
      ],
    });
    getRepoDatabase(repo).prepare("UPDATE task_group_members SET sort_order = NULL").run();
    getRepoDatabase(repo)
      .prepare("UPDATE task_group_members SET added_at = ? WHERE task_id = ?")
      .run(100, oldTask.taskId);
    getRepoDatabase(repo)
      .prepare("UPDATE task_group_members SET added_at = ? WHERE task_id = ?")
      .run(200, newTask.taskId);

    expect(await listGroupTaskOrders(repo, group.id)).toEqual([
      { id: "new-task", sortOrder: 1000 },
      { id: "old-task", sortOrder: 2000 },
    ]);
  });

  it("renames task groups without changing membership", async () => {
    const repo = createTrackedRepo();
    const task = await seedTask(repo, "task", 100);
    const group = await repo.createTaskGroup({ title: "Group", color: "blue" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [{ type: "group", groupId: group.id }],
      groups: [
        {
          groupId: group.id,
          taskRefs: [
            {
              workspacePath: task.workspacePath,
              workspaceIdentity: task.workspaceIdentity,
              taskId: task.taskId,
            },
          ],
        },
      ],
    });

    const renamedGroup = await repo.renameTaskGroup({
      groupId: group.id,
      title: "  Renamed group  ",
    });
    const view = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const groupNode = view.nodes.find(
      (node) => node.type === "group" && node.group.id === group.id,
    );

    expect(renamedGroup).toMatchObject({
      id: group.id,
      title: "Renamed group",
      color: "blue",
    });
    expect(groupNode?.type === "group" ? groupNode.tasks.map((item) => item.taskId) : []).toEqual([
      task.taskId,
    ]);
  });

  it("updates task group color without changing membership", async () => {
    const repo = createTrackedRepo();
    const task = await seedTask(repo, "task", 100);
    const group = await repo.createTaskGroup({ title: "Group", color: "gray" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [{ type: "group", groupId: group.id }],
      groups: [
        {
          groupId: group.id,
          taskRefs: [
            {
              workspacePath: task.workspacePath,
              workspaceIdentity: task.workspaceIdentity,
              taskId: task.taskId,
            },
          ],
        },
      ],
    });

    const updatedGroup = await repo.updateTaskGroupColor({
      groupId: group.id,
      color: "green",
    });
    const view = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const groupNode = view.nodes.find(
      (node) => node.type === "group" && node.group.id === group.id,
    );

    expect(updatedGroup).toMatchObject({
      id: group.id,
      title: "Group",
      color: "green",
    });
    expect(groupNode?.type === "group" ? groupNode.tasks.map((item) => item.taskId) : []).toEqual([
      task.taskId,
    ]);
  });
});
