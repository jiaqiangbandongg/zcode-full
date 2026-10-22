import { seedTaskIndex } from "./helpers/taskIndexFixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getTasksIndexDatabasePath, setDataBaseDir } from "#src/paths.js";
import { projectStorage } from "#src/project-storage/index.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "zcode-task-index-unread-cas-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(tempDir, { recursive: true, force: true });
});

function createTask(unreadAt: number): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-task-1",
    title: "Task 1",
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "running",
    unreadAt,
  };
}

async function holdSqliteWriteLock(databasePath: string): Promise<Worker> {
  const worker = new Worker(
    `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData.databasePath);
      database.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
      }, 100);
    `,
    {
      eval: true,
      workerData: { databasePath },
    },
  );
  await once(worker, "message");
  return worker;
}

describe("TaskIndexRepo unread compare-and-clear", () => {
  it("reads and sorts only CLI fact columns even when legacy columns and JSON disagree", async () => {
    for (const [taskId, updatedAt] of [
      ["older", 100],
      ["newer", 200],
    ] as const) {
      await repo.applyCliFacts({
        meta: { ...createTask(0), taskId, updatedAt, title: `CLI ${taskId}`, provider: "glm" },
        lastOutcome: "error",
      });
    }
    const db = new DatabaseSync(getTasksIndexDatabasePath());
    try {
      db.exec(`UPDATE tasks SET title='legacy',task_status='running',updated_at=999999,
        meta_json=json_set(meta_json,'$.title','JSON stale','$.status','running','$.updatedAt',999999)
        WHERE task_id='older'`);
    } finally {
      db.close();
    }
    const query = {
      workspaceScopes: [{ workspacePath: "/workspace/project" }],
      kind: "active" as const,
    };
    expect((await repo.queryTaskList(query)).items.map((task) => task.taskId)).toEqual([
      "newer",
      "older",
    ]);
    expect((await repo.queryTaskList({ ...query, search: "CLI older" })).items).toEqual([
      expect.objectContaining({ title: "CLI older", updatedAt: 100, status: "error" }),
    ]);
    expect((await repo.listTaskMetas({})).map((task) => task.taskId)).toEqual(["newer", "older"]);
  });

  it("exposes a skipped backup to the startup barrier", async () => {
    const migrate = projectStorage.migrate;
    const mock = vi.spyOn(projectStorage, "migrate").mockImplementation(async (...args) => ({
      ...(await migrate(...args)),
      backupSkipped: true,
    }));
    try {
      await repo.ensureReady();
      expect(repo.migrationBackupSkipped).toBe(true);
    } finally {
      mock.mockRestore();
    }
  });

  it("materializes reserved creation from CLI facts while preserving intervening organization changes", async () => {
    const projectRepo = await repo.getProjectRepository();
    const meta = { ...createTask(100), provider: "glm" as const };
    projectRepo.reserveCreatedTask({ task: meta, projectId: null });
    await repo.updateTaskState({ ...meta, patch: { pinned: true, unreadAt: 200 } });
    await repo.applyCliFacts({ meta, titleSource: "generated", lastOutcome: "completed" });
    expect(
      await repo.listTaskMetas({
        workspacePath: meta.workspacePath,
        provider: "glm",
        pinned: true,
      }),
    ).toEqual([
      expect.objectContaining({
        taskId: meta.taskId,
        provider: "glm",
        title: "Task 1",
        unreadAt: 200,
      }),
    ]);
    expect(projectRepo.readTree().tasks[0]).toMatchObject({
      projectId: null,
      title: "Task 1",
      pinned: true,
      unreadAt: 200,
    });
  });

  it("保留用户点击后新产生的未读", async () => {
    const initialUnreadAt = 100;
    const terminalUnreadAt = 200;
    const task = createTask(initialUnreadAt);
    await seedTaskIndex(repo, { meta: task });
    await repo.updateTaskState({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      patch: { unreadAt: terminalUnreadAt },
    });

    const result = await repo.clearTaskUnreadIfMatches({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      expectedUnreadAt: initialUnreadAt,
    });

    expect(result).toEqual({
      cleared: false,
      meta: expect.objectContaining({ unreadAt: terminalUnreadAt }),
    });
    await expect(
      repo.getTaskMeta({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
      }),
    ).resolves.toEqual(expect.objectContaining({ unreadAt: terminalUnreadAt }));
  });

  it("远程 workspace 重启后在时钟回拨时仍推进未读 marker", async () => {
    const firstWorkspaceIdentity = "remote:ssh:host-a:22:user:/workspace/project";
    const secondWorkspaceIdentity = "remote:ssh:host-b:22:user:/workspace/project";
    const firstTask = {
      ...createTask(100),
      workspaceIdentity: firstWorkspaceIdentity,
    };
    const secondTask = {
      ...createTask(100),
      workspaceIdentity: secondWorkspaceIdentity,
    };
    await seedTaskIndex(repo, { meta: firstTask });
    await seedTaskIndex(repo, { meta: secondTask });
    repo.close();
    const legacyDatabase = new DatabaseSync(getTasksIndexDatabasePath());
    legacyDatabase.exec("ALTER TABLE tasks DROP COLUMN last_unread_at");
    legacyDatabase.exec("DELETE FROM tasks_schema_migration");
    legacyDatabase.close();
    repo = new TaskIndexRepo();
    const migrationLock = await holdSqliteWriteLock(getTasksIndexDatabasePath());
    try {
      await repo.ensureReady();
    } finally {
      await migrationLock.terminate();
    }

    await expect(
      repo.clearTaskUnreadIfMatches({
        taskId: firstTask.taskId,
        workspacePath: firstTask.workspacePath,
        workspaceIdentity: firstWorkspaceIdentity,
        expectedUnreadAt: 100,
      }),
    ).resolves.toEqual({
      cleared: true,
      meta: expect.objectContaining({ unreadAt: undefined }),
    });
    repo.close();
    repo = new TaskIndexRepo();

    const newerUnread = await repo.updateTaskState({
      taskId: firstTask.taskId,
      workspacePath: firstTask.workspacePath,
      workspaceIdentity: firstWorkspaceIdentity,
      patch: { unreadAt: 50 },
    });
    expect(newerUnread.unreadAt).toBe(101);

    const result = await repo.clearTaskUnreadIfMatches({
      taskId: firstTask.taskId,
      workspacePath: firstTask.workspacePath,
      workspaceIdentity: firstWorkspaceIdentity,
      expectedUnreadAt: 100,
    });
    expect(result).toEqual({
      cleared: false,
      meta: expect.objectContaining({ unreadAt: 101 }),
    });
    await expect(
      repo.getTaskMeta({
        taskId: secondTask.taskId,
        workspacePath: secondTask.workspacePath,
        workspaceIdentity: secondWorkspaceIdentity,
      }),
    ).resolves.toEqual(expect.objectContaining({ unreadAt: 100 }));
  });

  it("跨 Host 的旧 snapshot 不回滚新未读 marker", async () => {
    const task = createTask(100);
    const otherHostRepo = new TaskIndexRepo();
    try {
      await seedTaskIndex(repo, { meta: task });
      const newerUnread = await otherHostRepo.updateTaskState({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        patch: { unreadAt: 100 },
      });
      expect(newerUnread.unreadAt).toBe(101);

      const persistedSnapshot = await seedTaskIndex(repo, {
        meta: {
          ...task,
          status: "completed",
          unreadAt: 100,
        },
      });
      expect(persistedSnapshot.unreadAt).toBe(101);

      await expect(
        repo.clearTaskUnreadIfMatches({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          expectedUnreadAt: 100,
        }),
      ).resolves.toEqual({
        cleared: false,
        meta: expect.objectContaining({ unreadAt: 101 }),
      });
    } finally {
      otherHostRepo.close();
    }
  });

  it("跨 Host 写锁释放后仍能分配新未读 marker", async () => {
    const task = createTask(100);
    const otherHostRepo = new TaskIndexRepo();
    await seedTaskIndex(repo, { meta: task });
    await otherHostRepo.ensureReady();
    const writeLock = await holdSqliteWriteLock(getTasksIndexDatabasePath());
    try {
      await expect(
        otherHostRepo.updateTaskState({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          patch: { unreadAt: 100 },
        }),
      ).resolves.toEqual(expect.objectContaining({ unreadAt: 101 }));
    } finally {
      await writeLock.terminate();
      otherHostRepo.close();
    }
  });
});
