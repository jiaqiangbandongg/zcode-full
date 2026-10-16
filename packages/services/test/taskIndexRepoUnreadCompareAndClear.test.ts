import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getTasksIndexDatabasePath, setDataBaseDir } from "#src/paths.js";
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
  it("保留用户点击后新产生的未读", async () => {
    const initialUnreadAt = 100;
    const terminalUnreadAt = 200;
    const task = createTask(initialUnreadAt);
    await repo.syncTaskMeta({ meta: task });
    await repo.updateTaskState({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      patch: { status: "completed", unreadAt: terminalUnreadAt },
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
    const firstWorkspaceIdentity = "ssh://host-a/workspace/project";
    const secondWorkspaceIdentity = "ssh://host-b/workspace/project";
    const firstTask = {
      ...createTask(100),
      workspaceIdentity: firstWorkspaceIdentity,
    };
    const secondTask = {
      ...createTask(100),
      workspaceIdentity: secondWorkspaceIdentity,
    };
    await repo.syncTaskMeta({ meta: firstTask });
    await repo.syncTaskMeta({ meta: secondTask });
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
      await repo.syncTaskMeta({ meta: task });
      const newerUnread = await otherHostRepo.updateTaskState({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        patch: { unreadAt: 100 },
      });
      expect(newerUnread.unreadAt).toBe(101);

      const persistedSnapshot = await repo.syncTaskMeta({
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
    await repo.syncTaskMeta({ meta: task });
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
