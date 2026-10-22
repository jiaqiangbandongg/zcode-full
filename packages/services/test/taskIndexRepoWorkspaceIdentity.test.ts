import { seedTaskIndex } from "./helpers/taskIndexFixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-workspace-identity-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function task(params: {
  taskId: string;
  workspaceIdentity: string;
  title?: string;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.title ?? params.taskId,
    workspacePath: "/workspace/project",
    workspaceIdentity: params.workspaceIdentity,
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    provider: "glm",
    status: "running",
  };
}

function getRepoDatabase(target: TaskIndexRepo): {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
} {
  return (
    target as unknown as {
      getDatabase(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
        };
      };
    }
  ).getDatabase();
}

function metaJsonWithoutWorkspaceIdentity(meta: ZCodeTaskMeta): string {
  const legacyMeta: Partial<ZCodeTaskMeta> = { ...meta };
  delete legacyMeta.workspaceIdentity;
  return JSON.stringify(legacyMeta);
}

describe("TaskIndexRepo workspace identity normalization", () => {
  it("归档条件删除只影响相同路径下指定 identity，冷启动仍保留 tombstone", async () => {
    const first = task({
      taskId: "same-id",
      workspaceIdentity: "remote:ssh:first:22:coder:/workspace/project",
    });
    const second = task({
      taskId: "same-id",
      workspaceIdentity: "remote:ssh:second:22:coder:/workspace/project",
    });
    for (const meta of [first, second]) {
      await seedTaskIndex(repo, { meta });
      await repo.updateTaskState({ ...meta, patch: { archived: true } });
    }
    expect(await repo.deleteArchivedTask(first)).toEqual(
      expect.objectContaining({ taskId: first.taskId }),
    );
    repo.close();
    repo = new TaskIndexRepo();
    expect(await repo.getTaskMeta(first)).toBeNull();
    expect(await repo.getTaskMeta(second)).toEqual(
      expect.objectContaining({ workspaceIdentity: second.workspaceIdentity }),
    );
    expect(await repo.deleteArchivedTask(first)).toBeNull();
  });

  it("以 SQLite remote workspace_key 覆盖 SSH 旧列和 meta_json 中过期的 identity", async () => {
    const workspaceIdentity = "remote:ssh:dev.example.test:22:coder:/workspace/project";
    const staleWorkspaceIdentity = "remote:ssh:stale.example.test:22:coder:/workspace/project";
    const meta = task({ taskId: "ssh-running", workspaceIdentity });
    await seedTaskIndex(repo, { meta });

    getRepoDatabase(repo)
      .prepare(
        `UPDATE tasks
        SET workspace_identity = ?, meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(
        staleWorkspaceIdentity,
        JSON.stringify({
          ...meta,
          workspaceIdentity: staleWorkspaceIdentity,
        }),
        workspaceIdentity,
        meta.taskId,
      );

    await expect(
      repo.listTaskMetas({
        workspacePath: meta.workspacePath,
        workspaceIdentity,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity,
      }),
    ]);
  });

  it("WSL 旧行 identity 列为空时从合法 remote workspace_key 恢复", async () => {
    const workspaceIdentity = "remote:wsl:ubuntu:/workspace/project";
    const meta = task({ taskId: "wsl-running", workspaceIdentity });
    await seedTaskIndex(repo, { meta });

    getRepoDatabase(repo)
      .prepare(
        `UPDATE tasks
        SET workspace_identity = NULL, meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(metaJsonWithoutWorkspaceIdentity(meta), workspaceIdentity, meta.taskId);

    await expect(
      repo.listTaskMetas({
        workspacePath: meta.workspacePath,
        workspaceIdentity,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: meta.taskId,
        workspaceIdentity,
      }),
    ]);
  });

  it("相同 path 和 taskId 的不同 SSH identity 仍保持隔离", async () => {
    const identityA = "remote:ssh:a.example.test:22:coder:/workspace/project";
    const identityB = "remote:ssh:b.example.test:22:coder:/workspace/project";
    const taskA = task({
      taskId: "shared-task",
      workspaceIdentity: identityA,
      title: "host-a",
    });
    const taskB = task({
      taskId: "shared-task",
      workspaceIdentity: identityB,
      title: "host-b",
    });
    await seedTaskIndex(repo, { meta: taskA });
    await seedTaskIndex(repo, { meta: taskB });

    const database = getRepoDatabase(repo);
    database
      .prepare(
        `UPDATE tasks
        SET meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(metaJsonWithoutWorkspaceIdentity(taskA), identityA, taskA.taskId);
    database
      .prepare(
        `UPDATE tasks
        SET meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(metaJsonWithoutWorkspaceIdentity(taskB), identityB, taskB.taskId);

    const [listedA, listedB] = await Promise.all([
      repo.listTaskMetas({
        workspacePath: taskA.workspacePath,
        workspaceIdentity: identityA,
      }),
      repo.listTaskMetas({
        workspacePath: taskB.workspacePath,
        workspaceIdentity: identityB,
      }),
    ]);

    expect(listedA).toEqual([
      expect.objectContaining({
        title: "host-a",
        workspaceIdentity: identityA,
      }),
    ]);
    expect(listedB).toEqual([
      expect.objectContaining({
        title: "host-b",
        workspaceIdentity: identityB,
      }),
    ]);
  });
});

describe("TaskIndexRepo migration startup barrier", () => {
  it("records project migrations before serving queries and does not import settings again on reopen", async () => {
    repo.close();
    repo = new TaskIndexRepo({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/repo/upgrade", workspacePurpose: "project" },
      ],
    });
    await repo.ensureReady();
    const db = getRepoDatabase(repo) as unknown as { prepare(sql: string): { all(): unknown[] } };
    // 修复原因：新增 0006 后旧断言仍只允许 0005，导致正确完成迁移也阻塞 pre-push。
    // 明确验证当前两项迁移及重开幂等性，不依赖 SQLite 的隐式返回顺序。
    const expectedMigrations = [
      { id: "0005_projects" },
      { id: "0006_default_workspace_tasks" },
      { id: "0007_initial_workspace_order" },
    ];
    expect(db.prepare("select id from schema_migration order by id").all()).toEqual(
      expectedMigrations,
    );
    expect(db.prepare("select root_path from project_roots").all()).toContainEqual({
      root_path: "/repo/upgrade",
    });
    repo.close();
    repo = new TaskIndexRepo({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/repo/should-not-reappear", workspacePurpose: "project" },
      ],
    });
    await repo.ensureReady();
    const reopened = getRepoDatabase(repo) as unknown as {
      prepare(sql: string): { all(): unknown[] };
    };
    expect(reopened.prepare("select id from schema_migration order by id").all()).toEqual(
      expectedMigrations,
    );
    expect(reopened.prepare("select root_path from project_roots").all()).not.toContainEqual({
      root_path: "/repo/should-not-reappear",
    });
  });
});

describe("CLI facts mirror", () => {
  it("keeps CLI activity times through title, pin and archive mutations and assigns new tasks once", async () => {
    const meta = {
      ...task({ taskId: "facts", workspaceIdentity: "" }),
      workspacePath: "/outside/default",
      updatedAt: 20,
    };
    await repo.applyCliFacts({ meta, titleSource: "custom", lastOutcome: "error" });
    await repo.updateTaskState({ ...meta, patch: { pinned: true, archived: true } });
    const projects = await repo.getProjectRepository();
    const first = projects.readTree().tasks.find((entry) => entry.taskId === "facts");
    expect(first).toMatchObject({
      projectId: null,
      title: "facts",
      updatedAt: 20,
      status: "error",
      pinned: true,
      archived: true,
    });
    projects.saveProject({ roots: [meta.workspacePath] });
    await repo.applyCliFacts({
      meta: { ...meta, title: "CLI renamed" },
      titleSource: "custom",
      lastOutcome: "error",
    });
    expect(projects.readTree().tasks.find((entry) => entry.taskId === "facts")).toMatchObject({
      projectId: null,
      title: "CLI renamed",
      updatedAt: 20,
    });
  });
});
