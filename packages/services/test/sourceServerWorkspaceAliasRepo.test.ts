import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getWorkspaceHash } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { SourceServerWorkspaceAliasRepo } from "#src/session/sourceServerWorkspaceAliasRepo.js";

async function createTaskDb(path: string): Promise<DatabaseSync> {
  // 使用正式索引 schema，避免精简夹具漏掉搜索、未读与模型等持久化投影列。
  const index = new TaskIndexRepo(undefined, undefined, path);
  try {
    await index.ensureReady();
  } finally {
    index.close();
  }
  return new DatabaseSync(path);
}

function createSessionDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      directory TEXT NOT NULL,
      path TEXT,
      time_updated INTEGER NOT NULL
    );
  `);
  return db;
}

describe("Source Server workspace canonical alias", () => {
  it.each([
    ["task-merge", "full"],
    ["session-merge", "full"],
    ["task-merge", "rollback"],
    ["session-merge", "rollback"],
    ["task-conflict", "rollback"],
    ["config-conflict", "rollback"],
    ["abandon", "rollback"],
  ] as const)("%s preserves the original SQLite error after %s", async (stage, failure) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-alias-full-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    (await createTaskDb(taskDbPath)).close();
    createSessionDb(sessionDbPath).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: () => "full-migration",
    });
    await repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey });
    const taskDb = new DatabaseSync(taskDbPath);
    const sessionDb = new DatabaseSync(sessionDbPath);
    const insert = taskDb.prepare(`INSERT INTO tasks
        (workspace_key, workspace_path, task_id, title, created_at, updated_at, meta_json)
        VALUES (?, '/repo', ?, 'Task', 1, ?, ?)`);
    insert.run(canonicalKey, "task-c", 20, JSON.stringify({ cronAutomationId: "cron-c" }));
    insert.run(
      sourceKey,
      stage === "task-conflict" ? "task-c" : "task-s",
      10,
      JSON.stringify({ cronAutomationId: "cron-s" }),
    );
    sessionDb
      .prepare("INSERT INTO session VALUES ('session-s', ?, '/repo', '/repo', 10)")
      .run(sourceKey);
    if (stage === "config-conflict") {
      for (const key of [canonicalKey, sourceKey]) {
        const dir = join(root, "sessions", getWorkspaceHash(workspacePath, key));
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "state.json"), key);
      }
    }
    if (stage === "abandon") {
      taskDb
        .prepare(`INSERT INTO workspace_migration_ledger
          (migration_id, path, canonical_key, variant_keys_json, status, phase,
           task_backup_path, created_at, updated_at)
          VALUES ('full-migration', '/repo', ?, ?, 'failed', NULL, '', 1, 1)`)
        .run(canonicalKey, JSON.stringify([canonicalKey, sourceKey]));
    }
    const failingDb = stage === "session-merge" ? sessionDb : taskDb;
    const trigger =
      stage === "task-merge"
        ? "UPDATE OF workspace_key ON tasks"
        : stage === "session-merge"
          ? "UPDATE OF workspace_id ON session"
          : stage === "abandon"
            ? "UPDATE OF status ON workspace_migration_ledger WHEN NEW.status = 'abandoned'"
            : "INSERT ON workspace_migration_conflicts";
    failingDb.exec(`CREATE TABLE test_full_payload (payload BLOB);
        CREATE TRIGGER exhaust_pages BEFORE ${trigger}
        BEGIN
          SELECT mark_full_attempt();
          ${
            failure === "full"
              ? "INSERT INTO test_full_payload VALUES (zeroblob(1048576));"
              : "SELECT RAISE(ROLLBACK, 'original transaction failure');"
          }
        END;`);
    taskDb.close();
    sessionDb.close();

    let attempts = 0;
    const exec = DatabaseSync.prototype.exec;
    // 在真实 SQLite 边界制造 FULL 或自动回滚；FULL 是否回滚取决于 SQLite 的失败位置。
    const fault = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (
        sql === "BEGIN IMMEDIATE" &&
        this.prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_full_payload'").get()
      ) {
        this.function("mark_full_attempt", () => {
          attempts += 1;
          return 1;
        });
        const pages = this.prepare("PRAGMA page_count").get()!.page_count;
        exec.call(this, `PRAGMA max_page_count = ${pages}`);
      }
      return exec.call(this, sql);
    });
    try {
      await expect(
        stage === "abandon"
          ? repo.abandonFailedWorkspace(workspacePath)
          : repo.resolveCanonicalWorkspaceKey({ workspacePath }),
      ).rejects.toMatchObject(
        failure === "full"
          ? { errcode: 13, message: "database or disk is full" }
          : { errcode: 1811, message: "original transaction failure" },
      );
      expect(attempts).toBe(1);
    } finally {
      fault.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["completed", "running", "phase", "canonical", "variants", "deleted"] as const)(
    "rejects abandon when %s changes before the write transaction without overwriting the winner",
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-abandon-race-"));
      const taskDbPath = join(root, "tasks-index.sqlite");
      const canonicalKey = "remote:ssh:canonical:22:user:/repo";
      const sourceKey = "remote:ssh:source:22:user:/repo";
      (await createTaskDb(taskDbPath)).close();
      let concurrentWrite: (() => void) | undefined;
      const repo = new SourceServerWorkspaceAliasRepo({
        taskDbPath,
        sessionDbPath: join(root, "missing.sqlite"),
        now: () => {
          const write = concurrentWrite;
          concurrentWrite = undefined;
          write?.();
          return 10;
        },
      });
      await repo.listMigrationReports();
      const db = new DatabaseSync(taskDbPath);
      try {
        db.prepare(`INSERT INTO workspace_migration_ledger
          (migration_id, path, canonical_key, variant_keys_json, status, phase,
           task_backup_path, created_at, updated_at)
          VALUES ('abandon-race', '/repo', ?, ?, 'failed', NULL, '', 10, 10)`).run(
          canonicalKey,
          JSON.stringify([canonicalKey, sourceKey]),
        );
        db.prepare("INSERT INTO workspace_alias VALUES ('/repo', ?, 10, 10)").run(canonicalKey);
        let winner;
        // now 在配置 IO 完成后、写事务前读取；由另一数据库连接提交并发写，时间戳保持相同。
        concurrentWrite = () => {
          if (change === "deleted") db.exec("DELETE FROM workspace_migration_ledger");
          else if (change === "completed" || change === "running")
            db.prepare("UPDATE workspace_migration_ledger SET status = ?").run(change);
          else if (change === "phase")
            db.exec("UPDATE workspace_migration_ledger SET phase = 'backups-created'");
          else if (change === "canonical")
            db.prepare("UPDATE workspace_migration_ledger SET canonical_key = ?").run(sourceKey);
          else
            db.prepare("UPDATE workspace_migration_ledger SET variant_keys_json = ?").run(
              JSON.stringify([canonicalKey, sourceKey, "remote:docker:third:/repo"]),
            );
          db.prepare("UPDATE workspace_alias SET canonical_key = ?").run(sourceKey);
          winner = db.prepare("SELECT * FROM workspace_migration_ledger").all();
        };
        await expect(repo.abandonFailedWorkspace("/repo", "abandon-race")).rejects.toMatchObject({
          retryable: true,
        });
        expect(concurrentWrite).toBeUndefined();
        expect(db.prepare("SELECT * FROM workspace_migration_ledger").all()).toEqual(winner);
        expect(db.prepare("SELECT canonical_key FROM workspace_alias").get()).toEqual({
          canonical_key: sourceKey,
        });
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("uses the legacy digest algorithm for unversioned abandoned baselines", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-abandoned-digest-v1-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    (await createTaskDb(taskDbPath)).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
    });
    await repo.listMigrationReports();

    const legacyDigest = createHash("sha256");
    for (const table of [
      "tasks",
      "task_group_members",
      "task_group_view_node_orders",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ]) {
      legacyDigest.update(table);
      legacyDigest.update("[]");
    }
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const db = new DatabaseSync(taskDbPath);
    db.prepare(`INSERT INTO workspace_migration_ledger (
      migration_id, path, canonical_key, variant_keys_json, status, phase,
      task_backup_path, session_backup_path, error, created_at, updated_at,
      abandoned_at, abandoned_trigger, abandoned_activity_json
    ) VALUES ('legacy-abandoned', '/repo', ?, ?, 'abandoned', NULL,
      '', NULL, NULL, 1, 1, 1, 'user', ?)`).run(
      canonicalKey,
      JSON.stringify([canonicalKey, sourceKey]),
      JSON.stringify({ [sourceKey]: legacyDigest.digest("hex") }),
    );
    db.close();

    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ migrationId: "legacy-abandoned", status: "abandoned" })],
    });
  });

  it("captures task writes committed by the abandon transaction in its digest baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-abandon-digest-transaction-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    (await createTaskDb(taskDbPath)).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      now: () => 10,
    });
    await repo.listMigrationReports();
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const db = new DatabaseSync(taskDbPath);
    db.prepare(`INSERT INTO workspace_migration_ledger (
      migration_id, path, canonical_key, variant_keys_json, status, phase,
      task_backup_path, session_backup_path, error, created_at, updated_at
    ) VALUES ('abandon-trigger', '/repo', ?, ?, 'failed', NULL,
      '', NULL, 'workspace-task-identity-conflict', 1, 1)`).run(
      canonicalKey,
      JSON.stringify([canonicalKey, sourceKey]),
    );
    db.exec(`
      CREATE TRIGGER add_task_during_abandon
      BEFORE UPDATE OF status ON workspace_migration_ledger
      WHEN NEW.status = 'abandoned'
      BEGIN
        INSERT INTO tasks (
          workspace_key, workspace_path, workspace_identity, task_id, title,
          created_at, updated_at
        ) VALUES (
          '${sourceKey}', '/repo', '${sourceKey}', 'trigger-task', 'trigger', 1, 2
        );
      END;
    `);
    db.close();

    await repo.abandonFailedWorkspace("/repo", "abandon-trigger");
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ migrationId: "abandon-trigger", status: "abandoned" })],
    });
  });

  it("counts only the latest path state and exposes migration recovery metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-migration-report-metadata-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    (await createTaskDb(taskDbPath)).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
    });
    await repo.listMigrationReports();
    const db = new DatabaseSync(taskDbPath);
    const insert = db.prepare(`INSERT INTO workspace_migration_ledger (
      migration_id, path, canonical_key, variant_keys_json, status, phase,
      task_backup_path, session_backup_path, error, created_at, updated_at,
      abandoned_at, abandoned_trigger, abandoned_activity_json
    ) VALUES (?, '/repo', 'remote:ssh:host:22:user:/repo', '[]', ?, NULL,
      '/backup/tasks.sqlite', '/backup/session.sqlite', NULL, ?, ?, ?, ?, ?)`);
    insert.run("z-failed-old", "failed", 1, 1, null, null, null);
    insert.run(
      "a-abandoned-new",
      "abandoned",
      1,
      1,
      1,
      "user",
      JSON.stringify({ schemaVersion: 2, digests: {} }),
    );
    db.close();

    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    await expect(repo.getAbandonedPathCount()).resolves.toBe(1);
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          migrationId: "a-abandoned-new",
          abandonedTrigger: "user",
          taskBackupPath: "/backup/tasks.sqlite",
          sessionBackupPath: "/backup/session.sqlite",
        }),
        expect.objectContaining({ migrationId: "z-failed-old" }),
      ],
    });
  });

  it("refuses to abandon a failed ledger that still owns a resumable phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-abandon-resume-owner-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    (await createTaskDb(taskDbPath)).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing"),
    });
    await repo.listMigrationReports();
    const db = new DatabaseSync(taskDbPath);
    db.prepare(`INSERT INTO workspace_migration_ledger (
      migration_id, path, canonical_key, variant_keys_json, status, phase,
      task_backup_path, session_backup_path, error, created_at, updated_at
    ) VALUES ('resume-owner', '/repo', 'remote:ssh:host:22:user:/repo', '[]',
      'failed', 'backups-created', '/backup', NULL, 'crash', 1, 1)`).run();
    db.close();

    await expect(repo.abandonFailedWorkspace("/repo")).rejects.toThrow(
      "resumable migration cannot be abandoned",
    );
  });

  it("fails closed on a newer migration schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-newer-schema-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const db = await createTaskDb(taskDbPath);
    db.exec(`CREATE TABLE workspace_migration_schema_version (
      schema_name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); INSERT INTO workspace_migration_schema_version VALUES ('workspace-migration', 4, 1);`);
    db.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing"),
    });

    await expect(repo.listMigrationReports()).rejects.toThrow(
      "Unsupported newer Source Server migration schema version: 4",
    );
  });
  it("chooses the most recently active legacy key, backs up and merges both databases", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const backupRoot = join(root, "backups");
    const workspacePath = "/srv/project";
    const keyA = "remote:ssh:old.example:22:alice:/srv/project";
    const keyB = "remote:ssh:new.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    taskDb
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(keyA, workspacePath, keyA, "task-a", "A", 1, 10);
    taskDb
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(keyB, workspacePath, keyB, "task-b", "B", 2, 20);
    taskDb.close();
    const sessionDb = createSessionDb(sessionDbPath);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
      )
      .run("task-a", keyA, workspacePath, workspacePath, 10);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
      )
      .run("task-b", keyB, workspacePath, workspacePath, 20);
    sessionDb.close();

    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
      now: () => 123,
      migrationId: () => "migration-1",
    });
    const result = await repo.resolveCanonicalWorkspaceKey({
      workspacePath,
      legacyRouteHint: keyA,
    });

    expect(result).toMatchObject({
      canonicalKey: keyB,
      mergedKeys: [keyA],
      migrationId: "migration-1",
    });
    const verifyTasks = new DatabaseSync(taskDbPath);
    expect(
      verifyTasks
        .prepare("SELECT workspace_key, workspace_identity, task_id FROM tasks ORDER BY task_id")
        .all(),
    ).toEqual([
      { workspace_key: keyB, workspace_identity: keyB, task_id: "task-a" },
      { workspace_key: keyB, workspace_identity: keyB, task_id: "task-b" },
    ]);
    expect(verifyTasks.prepare("SELECT path, canonical_key FROM workspace_alias").get()).toEqual({
      path: workspacePath,
      canonical_key: keyB,
    });
    expect(verifyTasks.prepare("SELECT status FROM workspace_migration_ledger").get()).toEqual({
      status: "completed",
    });
    verifyTasks.close();
    const verifySessions = new DatabaseSync(sessionDbPath);
    expect(verifySessions.prepare("SELECT DISTINCT workspace_id FROM session").all()).toEqual([
      { workspace_id: keyB },
    ]);
    verifySessions.close();
    await expect(
      access(join(backupRoot, "migration-1", "tasks-index.sqlite")),
    ).resolves.toBeUndefined();
    await expect(access(join(backupRoot, "migration-1", "db.sqlite"))).resolves.toBeUndefined();

    await expect(
      repo.resolveCanonicalWorkspaceKey({
        workspacePath,
        legacyRouteHint: keyA,
      }),
    ).resolves.toMatchObject({ canonicalKey: keyB, mergedKeys: [] });
  });

  it.each(["remote:docker:dev:/workspace", "remote:server:owner:/workspace"])(
    "uses route hint %s without rewriting data when the workspace has no history",
    async (hint) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-empty-"));
      const taskDbPath = join(root, "tasks-index.sqlite");
      (await createTaskDb(taskDbPath)).close();
      const repo = new SourceServerWorkspaceAliasRepo({
        taskDbPath,
        sessionDbPath: join(root, "missing.sqlite"),
        backupRoot: join(root, "backups"),
      });

      await expect(
        repo.resolveCanonicalWorkspaceKey({
          workspacePath: "/workspace",
          legacyRouteHint: hint,
        }),
      ).resolves.toMatchObject({ canonicalKey: hint, mergedKeys: [] });
    },
  );

  it("resumes the same migration plan after task DB commit without re-electing canonical", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-resume-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/srv/project";
    const keyA = "remote:ssh:a.example:22:alice:/srv/project";
    const keyB = "remote:ssh:b.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(keyA, workspacePath, keyA, "task-a", "A", 1, 10);
    insertTask.run(keyB, workspacePath, keyB, "task-b", "B", 1, 20);
    taskDb.close();
    const sessionDb = createSessionDb(sessionDbPath);
    const insertSession = sessionDb.prepare(
      "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
    );
    insertSession.run("task-a", keyA, workspacePath, workspacePath, 10);
    insertSession.run("task-b", keyB, workspacePath, workspacePath, 20);
    sessionDb.close();

    const crashingRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: () => "migration-frozen",
      afterPhaseCommitted: (phase: string) => {
        if (phase === "task-db-merged") throw new Error("simulated crash");
      },
    });
    await expect(
      crashingRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: keyA }),
    ).rejects.toThrow("simulated crash");

    const changedActivity = new DatabaseSync(sessionDbPath);
    changedActivity
      .prepare("UPDATE session SET time_updated = 200 WHERE workspace_id = ?")
      .run(keyA);
    changedActivity.close();
    const resumedRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: () => "migration-unexpected",
    });

    await expect(
      resumedRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: keyA }),
    ).resolves.toEqual({
      canonicalKey: keyB,
      mergedKeys: [keyA],
      migrationId: "migration-frozen",
    });
    const verifyTasks = new DatabaseSync(taskDbPath);
    expect(
      verifyTasks
        .prepare(
          "SELECT migration_id, canonical_key, status, phase FROM workspace_migration_ledger",
        )
        .all(),
    ).toEqual([
      {
        migration_id: "migration-frozen",
        canonical_key: keyB,
        status: "completed",
        phase: "completed",
      },
    ]);
    expect(verifyTasks.prepare("SELECT DISTINCT workspace_key FROM tasks").all()).toEqual([
      { workspace_key: keyB },
    ]);
    verifyTasks.close();
    const verifySessions = new DatabaseSync(sessionDbPath);
    expect(verifySessions.prepare("SELECT DISTINCT workspace_id FROM session").all()).toEqual([
      { workspace_id: keyB },
    ]);
    verifySessions.close();
  });

  it("persists the frozen plan before creating backups", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-preflight-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "task-source", "source", 1, 10);
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "task-canonical", "canonical", 1, 20);
    taskDb.close();
    const backupRoot = join(root, "backups");
    const crashingRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "preflight-migration",
      afterPhaseCommitted: (phase: string) => {
        if (phase === "preflight") throw new Error("preflight crash");
      },
    });

    await expect(
      crashingRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("preflight crash");
    await expect(access(backupRoot)).rejects.toThrow();
    const failed = new DatabaseSync(taskDbPath);
    expect(failed.prepare("SELECT status, phase FROM workspace_migration_ledger").get()).toEqual({
      status: "failed",
      phase: "preflight",
    });
    failed.close();

    const resumedRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "unexpected-migration",
    });
    await expect(
      resumedRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toMatchObject({
      canonicalKey,
      migrationId: "preflight-migration",
    });
  });

  it("fails the frozen resume plan before moving data when a new identity conflict appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-resume-conflict-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "source-only", "source", 1, 10, "{}");
    insertTask.run(
      canonicalKey,
      workspacePath,
      canonicalKey,
      "canonical-only",
      "canonical",
      1,
      20,
      "{}",
    );
    taskDb.close();
    const crashingRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => "resume-conflict-migration",
      afterPhaseCommitted: (phase) => {
        if (phase === "backups-created") throw new Error("crash after backup");
      },
    });
    await expect(
      crashingRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after backup");

    const changed = new DatabaseSync(taskDbPath);
    const insertConflict = changed.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, 'new-conflict', 'conflict', 2, ?, ?)",
    );
    insertConflict.run(
      canonicalKey,
      workspacePath,
      canonicalKey,
      30,
      JSON.stringify({ taskId: "new-conflict", cronAutomationId: "canonical-cron" }),
    );
    insertConflict.run(
      sourceKey,
      workspacePath,
      sourceKey,
      25,
      JSON.stringify({ taskId: "new-conflict", cronAutomationId: "source-cron" }),
    );
    changed.close();

    const resumedRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => "unexpected-second-migration",
    });
    await expect(
      resumedRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-task-identity-conflict" });

    const verify = new DatabaseSync(taskDbPath);
    expect(
      verify
        .prepare(
          "SELECT migration_id, status, phase, error FROM workspace_migration_ledger WHERE path = ?",
        )
        .all(workspacePath),
    ).toEqual([
      {
        migration_id: "resume-conflict-migration",
        status: "failed",
        phase: null,
        error: "workspace-task-identity-conflict",
      },
    ]);
    expect(
      verify.prepare("SELECT DISTINCT workspace_key FROM tasks ORDER BY workspace_key").all(),
    ).toEqual([{ workspace_key: canonicalKey }, { workspace_key: sourceKey }]);
    verify.close();
    await expect(resumedRepo.abandonFailedWorkspace(workspacePath)).resolves.toBeUndefined();
  });

  it("rechecks config conflicts before resuming a frozen pre-merge plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-resume-config-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    taskDb.close();
    const backupRoot = join(root, "backups");
    const crashingRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "resume-config-migration",
      afterPhaseCommitted: (phase) => {
        if (phase === "backups-created") throw new Error("crash after backup");
      },
    });
    await expect(
      crashingRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after backup");

    const canonicalDir = join(root, "sessions", getWorkspaceHash(workspacePath, canonicalKey));
    const sourceDir = join(root, "sessions", getWorkspaceHash(workspacePath, sourceKey));
    await Promise.all([
      mkdir(canonicalDir, { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(canonicalDir, "settings.json"), "canonical", "utf8"),
      writeFile(join(sourceDir, "settings.json"), "source", "utf8"),
    ]);
    const resumedRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
    });

    await expect(
      resumedRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-config-file-conflict" });
    await expect(resumedRepo.listMigrationReports()).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          migrationId: "resume-config-migration",
          status: "failed",
          errorCode: "workspace-config-file-conflict",
          conflicts: [expect.objectContaining({ relativePath: "settings.json" })],
        }),
      ],
    });
    const failed = new DatabaseSync(taskDbPath);
    expect(failed.prepare("SELECT phase FROM workspace_migration_ledger").get()).toEqual({
      phase: null,
    });
    failed.close();
    await expect(resumedRepo.abandonFailedWorkspace(workspacePath)).resolves.toBeUndefined();
  });

  it("checks task identity conflicts inside the task merge transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-transaction-conflict-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "source", "source", 10, "{}");
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20, "{}");
    taskDb.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => "transaction-conflict-migration",
      afterPhaseCommitted: (phase) => {
        if (phase !== "backups-created") return;
        const changed = new DatabaseSync(taskDbPath);
        const add = changed.prepare(
          "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, 'late-conflict', 'late', 2, 30, ?)",
        );
        add.run(
          canonicalKey,
          workspacePath,
          canonicalKey,
          JSON.stringify({ cronAutomationId: "canonical-cron" }),
        );
        add.run(
          sourceKey,
          workspacePath,
          sourceKey,
          JSON.stringify({ cronAutomationId: "source-cron" }),
        );
        changed.close();
      },
    });

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-task-identity-conflict" });
    const verify = new DatabaseSync(taskDbPath);
    expect(
      verify.prepare("SELECT DISTINCT workspace_key FROM tasks ORDER BY workspace_key").all(),
    ).toEqual([{ workspace_key: canonicalKey }, { workspace_key: sourceKey }]);
    verify.close();
  });

  it("records a structured config conflict that appears after resume preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-late-config-conflict-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    taskDb.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => "late-config-conflict",
      afterPhaseCommitted: async (phase) => {
        if (phase !== "session-db-merged") return;
        const canonicalDir = join(root, "sessions", getWorkspaceHash(workspacePath, canonicalKey));
        const sourceDir = join(root, "sessions", getWorkspaceHash(workspacePath, sourceKey));
        await Promise.all([
          mkdir(canonicalDir, { recursive: true }),
          mkdir(sourceDir, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(join(canonicalDir, "settings.json"), "canonical", "utf8"),
          writeFile(join(sourceDir, "settings.json"), "source", "utf8"),
        ]);
      },
    });

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-config-file-conflict" });
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          migrationId: "late-config-conflict",
          phase: "session-db-merged",
          errorCode: "workspace-config-file-conflict",
          conflicts: [expect.objectContaining({ relativePath: "settings.json" })],
        }),
      ],
    });
  });

  it("fails closed when a frozen session backup generation disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-missing-frozen-session-db-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    (await createTaskDb(taskDbPath)).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
    });
    await repo.listMigrationReports();
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const db = new DatabaseSync(taskDbPath);
    db.prepare(`INSERT INTO workspace_migration_ledger (
      migration_id, path, canonical_key, variant_keys_json, status, phase,
      task_backup_path, session_backup_path, error, created_at, updated_at
    ) VALUES ('missing-session', '/repo', ?, ?, 'failed', 'task-db-merged',
      '/backup/tasks.sqlite', '/backup/session.sqlite', 'crash', 1, 1)`).run(
      canonicalKey,
      JSON.stringify([canonicalKey, sourceKey]),
    );
    db.close();

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath: "/repo", legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-session-generation-changed" });
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ errorCode: "workspace-session-generation-changed" })],
    });
  });

  it("fails closed when the session database is recreated at the same path after session merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-recreated-session-db-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const taskDb = await createTaskDb(taskDbPath);
    const addTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    addTask.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    addTask.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    taskDb.close();
    const sessionDb = createSessionDb(sessionDbPath);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES ('source', ?, ?, ?, 10)",
      )
      .run(sourceKey, workspacePath, workspacePath);
    sessionDb.close();
    const backupRoot = join(root, "backups");
    const crashing = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
      migrationId: () => "recreated-session-migration",
      afterPhaseCommitted: (phase) => {
        if (phase === "session-db-merged") throw new Error("crash after session merge");
      },
    });
    await expect(
      crashing.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after session merge");
    await rm(sessionDbPath, { force: true });
    createSessionDb(sessionDbPath).close();
    const resumed = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
    });

    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-session-generation-changed" });
  });

  it("resumes a legacy v2 post-merge ledger by validating the session backup lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-v2-session-generation-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const backupRoot = join(root, "backups");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const migrationId = "legacy-v2-post-merge";
    const taskDb = await createTaskDb(taskDbPath);
    const addTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    addTask.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    addTask.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    taskDb.close();
    const sessionDb = createSessionDb(sessionDbPath);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES ('source', ?, ?, ?, 10)",
      )
      .run(sourceKey, workspacePath, workspacePath);
    sessionDb.close();
    const crashing = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
      migrationId: () => migrationId,
      afterPhaseCommitted: (phase) => {
        if (phase === "session-db-merged") throw new Error("legacy crash");
      },
    });
    await expect(
      crashing.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("legacy crash");

    for (const path of [sessionDbPath, join(backupRoot, migrationId, "db.sqlite")]) {
      const db = new DatabaseSync(path);
      db.exec("DROP TABLE zcode_database_identity");
      // 旧 v2 制品尚无正式 identity migration，fixture 同时还原结构与账本。
      db.exec("DELETE FROM schema_migration WHERE id = '0024_session_database_identity'");
      db.close();
    }
    const legacyTaskDb = new DatabaseSync(taskDbPath);
    legacyTaskDb.exec("ALTER TABLE workspace_migration_ledger DROP COLUMN session_db_generation");
    legacyTaskDb.exec(
      "DELETE FROM tasks_schema_migration WHERE id = '0005_source_server_workspace_schema'",
    );
    legacyTaskDb
      .prepare(
        "UPDATE workspace_migration_schema_version SET version = 2 WHERE schema_name = 'workspace-migration'",
      )
      .run();
    legacyTaskDb.close();
    const resumed = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
    });

    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toMatchObject({ canonicalKey, migrationId });
  });

  it("allows abandoning a pre-merge plan when a populated session database appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-empty-late-session-db-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const db = await createTaskDb(taskDbPath);
    const add = db.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    add.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    add.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    db.close();
    const crashing = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: () => "late-empty-session",
      afterPhaseCommitted: (phase) => {
        if (phase === "backups-created") throw new Error("crash after backup");
      },
    });
    await expect(
      crashing.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after backup");
    const lateSessionDb = createSessionDb(sessionDbPath);
    lateSessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES ('late', ?, ?, ?, 30)",
      )
      .run(sourceKey, workspacePath, workspacePath);
    lateSessionDb.close();

    const resumed = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
    });
    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-session-generation-changed" });
    await expect(resumed.abandonFailedWorkspace(workspacePath)).resolves.toBeUndefined();
    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toEqual({ canonicalKey, mergedKeys: [] });
  });

  it("ignores an empty session database created after a session-less plan was frozen", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-empty-late-session-db-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const db = await createTaskDb(taskDbPath);
    const add = db.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    add.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    add.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    db.close();
    const backupRoot = join(root, "backups");
    const crashing = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
      migrationId: () => "late-empty-session",
      afterPhaseCommitted: (phase) => {
        if (phase === "backups-created") throw new Error("crash after backup");
      },
    });
    await expect(
      crashing.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after backup");
    createSessionDb(sessionDbPath).close();
    const resumed = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot,
    });

    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toMatchObject({ migrationId: "late-empty-session", canonicalKey });
    const untouched = new DatabaseSync(sessionDbPath);
    expect(untouched.prepare("SELECT COUNT(*) AS count FROM session").get()).toEqual({ count: 0 });
    expect(
      untouched
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zcode_database_identity'",
        )
        .get(),
    ).toBeUndefined();
    untouched.close();
  });

  it("fails a frozen resume when a new workspace variant appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-new-frozen-variant-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const newKey = "remote:ssh:new:22:user:/repo";
    const db = await createTaskDb(taskDbPath);
    const add = db.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    add.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    add.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    db.close();
    const backupRoot = join(root, "backups");
    const crashing = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "new-variant-migration",
      afterPhaseCommitted: (phase) => {
        if (phase === "backups-created") throw new Error("crash after backup");
      },
    });
    await expect(
      crashing.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after backup");
    const changed = new DatabaseSync(taskDbPath);
    changed
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, 'new-task', 'new', 2, 30)",
      )
      .run(newKey, workspacePath, newKey);
    changed.close();
    const resumed = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
    });

    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-migration-plan-diverged" });
    await expect(resumed.listMigrationReports()).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          migrationId: "new-variant-migration",
          status: "failed",
          errorCode: "workspace-migration-plan-diverged",
        }),
      ],
    });
    const failed = new DatabaseSync(taskDbPath);
    expect(failed.prepare("SELECT phase FROM workspace_migration_ledger").get()).toEqual({
      phase: null,
    });
    failed.close();
    await expect(resumed.abandonFailedWorkspace(workspacePath)).resolves.toBeUndefined();
  });

  it("finishes a post-merge frozen plan before migrating a newly appeared variant", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-post-merge-follow-up-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const newKey = "remote:ssh:new:22:user:/repo";
    const db = await createTaskDb(taskDbPath);
    const add = db.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    add.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    add.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    db.close();
    const backupRoot = join(root, "backups");
    const crashing = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "frozen-migration",
      afterPhaseCommitted: (phase) => {
        if (phase === "task-db-merged") throw new Error("crash after task merge");
      },
    });
    await expect(
      crashing.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("crash after task merge");
    const changed = new DatabaseSync(taskDbPath);
    changed
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, 'new-task', 'new', 2, 30)",
      )
      .run(newKey, workspacePath, newKey);
    changed.close();
    const resumed = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "follow-up-migration",
    });

    await expect(
      resumed.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toMatchObject({
      canonicalKey,
      mergedKeys: [sourceKey, newKey],
      migrationId: "follow-up-migration",
    });
    const verify = new DatabaseSync(taskDbPath);
    expect(verify.prepare("SELECT DISTINCT workspace_key FROM tasks").all()).toEqual([
      { workspace_key: canonicalKey },
    ]);
    expect(
      verify
        .prepare(
          "SELECT migration_id, status, phase FROM workspace_migration_ledger ORDER BY created_at, migration_id",
        )
        .all(),
    ).toEqual([
      { migration_id: "frozen-migration", status: "completed", phase: "completed" },
      { migration_id: "follow-up-migration", status: "completed", phase: "completed" },
    ]);
    verify.close();
  });

  it("bounds follow-up migrations when new variants keep appearing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-follow-up-budget-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/repo";
    const canonicalKey = "remote:ssh:canonical:22:user:/repo";
    const sourceKey = "remote:ssh:source:22:user:/repo";
    const db = await createTaskDb(taskDbPath);
    const add = db.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    );
    add.run(canonicalKey, workspacePath, canonicalKey, "canonical", "canonical", 20);
    add.run(sourceKey, workspacePath, sourceKey, "source", "source", 10);
    db.close();
    let completedCount = 0;
    let migrationCount = 0;
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => `migration-${++migrationCount}`,
      afterPhaseCommitted: (phase) => {
        if (phase !== "completed") return;
        completedCount += 1;
        if (completedCount > 4) throw new Error("unbounded follow-up");
        const key = `remote:ssh:churn-${completedCount}:22:user:/repo`;
        const changed = new DatabaseSync(taskDbPath);
        changed
          .prepare(
            "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, 'churn', 2, ?)",
          )
          .run(key, workspacePath, key, `churn-${completedCount}`, 20 + completedCount);
        changed.close();
      },
    });

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({ code: "workspace-migration-plan-diverged" });
    expect(completedCount).toBeLessThanOrEqual(4);
  });

  it.each([
    "backups-created",
    "session-db-merged",
    "config-dirs-merged",
    "alias-published",
    "completed",
  ])("resumes idempotently after %s", async (crashPhase) => {
    const root = await mkdtemp(join(tmpdir(), `zcode-r3-workspace-alias-${crashPhase}-`));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "task-source", "source", 1, 10);
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "task-canonical", "canonical", 1, 20);
    taskDb.close();
    const migrationId = `migration-${crashPhase}`;
    const crashingRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => migrationId,
      afterPhaseCommitted: (phase: string) => {
        if (phase === crashPhase) throw new Error(`crash after ${phase}`);
      },
    });
    await expect(
      crashingRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow(`crash after ${crashPhase}`);

    const resumedRepo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => "unexpected-migration",
    });
    await expect(
      resumedRepo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toMatchObject({ canonicalKey, migrationId });
    const verify = new DatabaseSync(taskDbPath);
    expect(
      verify.prepare("SELECT migration_id, status, phase FROM workspace_migration_ledger").all(),
    ).toEqual([{ migration_id: migrationId, status: "completed", phase: "completed" }]);
    verify.close();
  });

  it("incrementally merges a new legacy route variant after the alias already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-incremental-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const lateKey = "remote:ssh:late.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    taskDb
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(canonicalKey, workspacePath, canonicalKey, "task-a", "A", 1, 10);
    taskDb.close();
    const sessionDb = createSessionDb(sessionDbPath);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
      )
      .run("task-a", canonicalKey, workspacePath, workspacePath, 10);
    sessionDb.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: () => "incremental-migration",
    });
    await repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey });

    const lateTaskDb = new DatabaseSync(taskDbPath);
    lateTaskDb
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(lateKey, workspacePath, lateKey, "task-b", "B", 2, 20);
    lateTaskDb.close();
    const lateSessionDb = new DatabaseSync(sessionDbPath);
    lateSessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
      )
      .run("task-b", lateKey, workspacePath, workspacePath, 20);
    lateSessionDb.close();

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: lateKey }),
    ).resolves.toMatchObject({
      canonicalKey,
      mergedKeys: [lateKey],
      migrationId: "incremental-migration",
    });
    const verifyTasks = new DatabaseSync(taskDbPath);
    expect(
      verifyTasks.prepare("SELECT workspace_key, task_id FROM tasks ORDER BY task_id").all(),
    ).toEqual([
      { workspace_key: canonicalKey, task_id: "task-a" },
      { workspace_key: canonicalKey, task_id: "task-b" },
    ]);
    verifyTasks.close();
  });

  it("merges a hinted late variant that only owns a run and session config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-hinted-late-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const lateKey = "remote:ssh:late.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    taskDb
      .prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, 'task-canonical', 'canonical', 1, 20)",
      )
      .run(canonicalKey, workspacePath, canonicalKey);
    taskDb.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: (() => {
        let id = 0;
        return () => `hinted-migration-${++id}`;
      })(),
    });
    await repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey });
    const lateDb = new DatabaseSync(taskDbPath);
    lateDb
      .prepare(
        "INSERT INTO automation_runs (run_id, automation_id, workspace_key, session_id, created_at, updated_at) VALUES ('run-late', 'automation-missing', ?, NULL, 1, 1)",
      )
      .run(lateKey);
    lateDb.close();
    const lateConfigDir = join(root, "sessions", getWorkspaceHash(workspacePath, lateKey));
    await mkdir(lateConfigDir, { recursive: true });
    await writeFile(join(lateConfigDir, "late.json"), "late", "utf8");

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: lateKey }),
    ).resolves.toEqual({
      canonicalKey,
      mergedKeys: [lateKey],
      migrationId: "hinted-migration-1",
    });
    const verify = new DatabaseSync(taskDbPath);
    expect(verify.prepare("SELECT workspace_key FROM automation_runs").get()).toEqual({
      workspace_key: canonicalKey,
    });
    verify.close();
    const canonicalConfigDir = join(
      root,
      "sessions",
      getWorkspaceHash(workspacePath, canonicalKey),
    );
    await expect(readFile(join(canonicalConfigDir, "late.json"), "utf8")).resolves.toBe("late");
  });

  it("merges every workspace-owned row and session config file into canonical", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-inventory-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "task-source", "source", 1, 10);
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "task-canonical", "canonical", 1, 20);
    taskDb
      .prepare("UPDATE tasks SET meta_json = ? WHERE workspace_key = ? AND task_id = 'task-source'")
      .run(JSON.stringify({ taskId: "task-source", workspaceIdentity: sourceKey }), sourceKey);
    taskDb.exec(
      "INSERT INTO task_groups (group_id, title, created_at, updated_at) VALUES ('group-1', 'Test', 1, 1)",
    );
    taskDb
      .prepare(
        "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, workspace_identity, task_id, added_at, created_at, updated_at) VALUES ('group-1', ?, ?, ?, 'task-source', 1, 1, 1)",
      )
      .run(sourceKey, workspacePath, sourceKey);
    taskDb
      .prepare("INSERT INTO task_group_workspace_bootstraps VALUES (?, 'group-1', 1, 1)")
      .run(sourceKey);
    taskDb
      .prepare("INSERT INTO task_group_view_node_orders VALUES ('task', ?, 1, 1, 1)")
      .run(JSON.stringify([sourceKey, "task-source"]));
    taskDb
      .prepare(
        "INSERT INTO automations (automation_id, workspace_key, workspace_path, workspace_identity, target_task_id, updated_at, created_at, cron_expr, prompt) VALUES ('automation-1', ?, ?, ?, 'task-source', 10, 1, '* * * * *', 'test')",
      )
      .run(sourceKey, workspacePath, sourceKey);
    taskDb
      .prepare(
        "INSERT INTO automation_runs (run_id, automation_id, workspace_key, session_id, created_at, updated_at) VALUES ('run-1', 'automation-1', ?, 'task-source', 1, 1)",
      )
      .run(sourceKey);
    taskDb
      .prepare(
        "INSERT INTO off_peak_tasks (off_peak_task_id, workspace_key, workspace_path, workspace_identity, session_id, updated_at, created_at, queued_at, prompt, permission_mode, status) VALUES ('off-peak-1', ?, ?, ?, 'task-source', 10, 1, 1, 'test', 'default', 'queued')",
      )
      .run(sourceKey, workspacePath, sourceKey);
    taskDb.close();
    const sessionDb = createSessionDb(sessionDbPath);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES ('task-source', ?, ?, ?, 10)",
      )
      .run(sourceKey, workspacePath, workspacePath);
    sessionDb.close();
    const sessionsRoot = join(root, "sessions");
    const sourceConfigDir = join(sessionsRoot, getWorkspaceHash(workspacePath, sourceKey));
    const canonicalConfigDir = join(sessionsRoot, getWorkspaceHash(workspacePath, canonicalKey));
    await mkdir(join(sourceConfigDir, "nested"), { recursive: true });
    await mkdir(canonicalConfigDir, { recursive: true });
    await writeFile(join(sourceConfigDir, "source.json"), "source", "utf8");
    await writeFile(join(sourceConfigDir, "nested", "shared.json"), "same", "utf8");
    await mkdir(join(canonicalConfigDir, "nested"), { recursive: true });
    await writeFile(join(canonicalConfigDir, "canonical.json"), "canonical", "utf8");
    await writeFile(join(canonicalConfigDir, "nested", "shared.json"), "same", "utf8");

    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: () => "inventory-migration",
    });
    await repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey });

    const verify = new DatabaseSync(taskDbPath);
    for (const table of [
      "tasks",
      "task_group_members",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ]) {
      expect(
        verify
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_key = ?`)
          .get(sourceKey),
      ).toEqual({ count: 0 });
    }
    expect(
      verify
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .get(),
    ).toEqual({ node_key: JSON.stringify([canonicalKey, "task-source"]) });
    expect(
      verify
        .prepare(
          "SELECT workspace_key, workspace_identity, target_task_id FROM automations WHERE automation_id = 'automation-1'",
        )
        .get(),
    ).toEqual({
      workspace_key: canonicalKey,
      workspace_identity: canonicalKey,
      target_task_id: "task-source",
    });
    const movedTask = verify
      .prepare("SELECT workspace_identity, meta_json FROM tasks WHERE task_id = 'task-source'")
      .get() as { workspace_identity: string; meta_json: string };
    expect(movedTask.workspace_identity).toBe(canonicalKey);
    expect(JSON.parse(movedTask.meta_json)).toMatchObject({ workspaceIdentity: canonicalKey });
    verify.close();
    await expect(readFile(join(canonicalConfigDir, "source.json"), "utf8")).resolves.toBe("source");
    await expect(readFile(join(canonicalConfigDir, "canonical.json"), "utf8")).resolves.toBe(
      "canonical",
    );
    await expect(readFile(join(canonicalConfigDir, "nested", "shared.json"), "utf8")).resolves.toBe(
      "same",
    );
    await expect(access(sourceConfigDir)).rejects.toThrow();
  });

  it("fails config collisions before backup or row movement and records one report", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-config-conflict-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insertTask = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(sourceKey, workspacePath, sourceKey, "task-source", "source", 1, 10);
    insertTask.run(canonicalKey, workspacePath, canonicalKey, "task-canonical", "canonical", 1, 20);
    taskDb.close();
    const sourceConfigDir = join(root, "sessions", getWorkspaceHash(workspacePath, sourceKey));
    const canonicalConfigDir = join(
      root,
      "sessions",
      getWorkspaceHash(workspacePath, canonicalKey),
    );
    await mkdir(sourceConfigDir, { recursive: true });
    await mkdir(canonicalConfigDir, { recursive: true });
    await writeFile(join(sourceConfigDir, "state.json"), "source", "utf8");
    await writeFile(join(canonicalConfigDir, "state.json"), "canonical", "utf8");
    const backupRoot = join(root, "backups");
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot,
      migrationId: () => "config-conflict",
      now: () => 123,
    });

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({
      code: "workspace-config-file-conflict",
      retryable: false,
      relativePath: "state.json",
    });
    await expect(access(backupRoot)).rejects.toThrow();
    await expect(repo.getFailedPathCount()).resolves.toBe(1);
    const verify = new DatabaseSync(taskDbPath);
    expect(
      verify.prepare("SELECT DISTINCT workspace_key FROM tasks ORDER BY workspace_key").all(),
    ).toEqual([{ workspace_key: canonicalKey }, { workspace_key: sourceKey }]);
    expect(
      verify
        .prepare(
          "SELECT migration_id, status, phase, task_backup_path, error FROM workspace_migration_ledger",
        )
        .get(),
    ).toEqual({
      migration_id: "config-conflict",
      status: "failed",
      phase: null,
      task_backup_path: "",
      error: "workspace-config-file-conflict",
    });
    expect(
      verify
        .prepare(
          "SELECT conflict_kind, conflict_key, task_id, relative_path, source_key FROM workspace_migration_conflicts",
        )
        .get(),
    ).toEqual({
      conflict_kind: "config-file",
      conflict_key: "state.json",
      task_id: null,
      relative_path: "state.json",
      source_key: sourceKey,
    });
    verify.close();
  });

  it("discovers and merges variants that exist only in automation-owned tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-automation-only-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    taskDb
      .prepare(
        "INSERT INTO automations (automation_id, workspace_key, workspace_path, workspace_identity, target_task_id, updated_at, created_at, cron_expr, prompt) VALUES ('automation-1', ?, ?, ?, NULL, 10, 1, '* * * * *', 'test')",
      )
      .run(sourceKey, workspacePath, sourceKey);
    taskDb
      .prepare(
        "INSERT INTO automation_runs (run_id, automation_id, workspace_key, session_id, created_at, updated_at) VALUES ('run-1', 'automation-1', ?, NULL, 1, 1)",
      )
      .run(sourceKey);
    taskDb
      .prepare(
        "INSERT INTO off_peak_tasks (off_peak_task_id, workspace_key, workspace_path, workspace_identity, session_id, updated_at, created_at, queued_at, prompt, permission_mode, status) VALUES ('off-peak-1', ?, ?, ?, NULL, 20, 1, 1, 'test', 'default', 'queued')",
      )
      .run(canonicalKey, workspacePath, canonicalKey);
    taskDb.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
      backupRoot: join(root, "backups"),
      migrationId: () => "automation-only-migration",
    });

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toEqual({
      canonicalKey,
      mergedKeys: [sourceKey],
      migrationId: "automation-only-migration",
    });
    const verify = new DatabaseSync(taskDbPath);
    expect(
      verify.prepare("SELECT workspace_key, workspace_identity FROM automations").get(),
    ).toEqual({ workspace_key: canonicalKey, workspace_identity: canonicalKey });
    expect(verify.prepare("SELECT workspace_key FROM automation_runs").get()).toEqual({
      workspace_key: canonicalKey,
    });
    verify.close();
  });

  it("fails the whole workspace idempotently before moving data when task identity conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-conflict-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const canonicalKey = "remote:ssh:canonical.example:22:alice:/srv/project";
    const sourceKey = "remote:ssh:source.example:22:alice:/srv/project";
    const taskDb = await createTaskDb(taskDbPath);
    const insert = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      canonicalKey,
      workspacePath,
      canonicalKey,
      "shared-task",
      "Same title",
      1,
      20,
      JSON.stringify({ taskId: "shared-task", cronAutomationId: "cron-a" }),
    );
    insert.run(
      sourceKey,
      workspacePath,
      sourceKey,
      "shared-task",
      "Same title",
      1,
      10,
      JSON.stringify({ taskId: "shared-task", cronAutomationId: "cron-b" }),
    );
    taskDb.exec(
      "INSERT INTO task_groups (group_id, title, created_at, updated_at) VALUES ('source-group', 'Source', 1, 1)",
    );
    taskDb
      .prepare(
        "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, workspace_identity, task_id, added_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, 1)",
      )
      .run("source-group", sourceKey, workspacePath, sourceKey, "shared-task");
    taskDb.close();
    const sessionDbPath = join(root, "db.sqlite");
    const sessionDb = createSessionDb(sessionDbPath);
    sessionDb
      .prepare(
        "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
      )
      .run("source-session", sourceKey, workspacePath, workspacePath, 10);
    sessionDb.close();
    let migrationSequence = 0;
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath,
      backupRoot: join(root, "backups"),
      migrationId: vi.fn(() =>
        migrationSequence++ === 0 ? "conflict-migration" : "retry-conflict-migration",
      ),
      now: () => 123,
    });

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toMatchObject({
      code: "workspace-task-identity-conflict",
      retryable: false,
    });
    const evolved = new DatabaseSync(taskDbPath);
    const insertEvolved = evolved.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertEvolved.run(
      canonicalKey,
      workspacePath,
      canonicalKey,
      "second-conflict",
      "Second",
      2,
      30,
      JSON.stringify({ taskId: "second-conflict", offPeakTaskId: "off-peak-a" }),
    );
    insertEvolved.run(
      sourceKey,
      workspacePath,
      sourceKey,
      "second-conflict",
      "Second",
      2,
      25,
      JSON.stringify({ taskId: "second-conflict", offPeakTaskId: "off-peak-b" }),
    );
    evolved.close();
    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).rejects.toThrow("workspace task identity conflict");

    const verify = new DatabaseSync(taskDbPath);
    expect(
      verify
        .prepare(
          "SELECT workspace_key, meta_json FROM tasks WHERE task_id = ? ORDER BY workspace_key",
        )
        .all("shared-task"),
    ).toEqual([
      {
        workspace_key: canonicalKey,
        meta_json: JSON.stringify({ taskId: "shared-task", cronAutomationId: "cron-a" }),
      },
      {
        workspace_key: sourceKey,
        meta_json: JSON.stringify({ taskId: "shared-task", cronAutomationId: "cron-b" }),
      },
    ]);
    expect(
      verify
        .prepare(
          "SELECT task_id, source_key, canonical_key, reason FROM workspace_migration_conflicts ORDER BY task_id",
        )
        .all(),
    ).toEqual([
      {
        task_id: "second-conflict",
        source_key: sourceKey,
        canonical_key: canonicalKey,
        reason: "task-identity-metadata-conflict",
      },
      {
        task_id: "shared-task",
        source_key: sourceKey,
        canonical_key: canonicalKey,
        reason: "task-identity-metadata-conflict",
      },
    ]);
    expect(verify.prepare("SELECT workspace_key, task_id FROM task_group_members").all()).toEqual([
      { workspace_key: sourceKey, task_id: "shared-task" },
    ]);
    expect(
      verify
        .prepare("SELECT status, error FROM workspace_migration_ledger ORDER BY created_at")
        .all(),
    ).toEqual([
      {
        status: "failed",
        error: "workspace-task-identity-conflict",
      },
    ]);
    verify.close();
    const verifySessions = new DatabaseSync(sessionDbPath);
    expect(verifySessions.prepare("SELECT workspace_id FROM session").all()).toEqual([
      { workspace_id: sourceKey },
    ]);
    verifySessions.close();

    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          migrationId: "conflict-migration",
          workspacePath,
          status: "failed",
          conflicts: [
            expect.objectContaining({ kind: "task-identity", taskId: "second-conflict" }),
            expect.objectContaining({ kind: "task-identity", taskId: "shared-task" }),
          ],
        }),
      ],
    });
    await repo.abandonFailedWorkspace(workspacePath);
    await expect(repo.getAbandonedPathCount()).resolves.toBe(1);
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ status: "abandoned" })],
    });
    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: sourceKey }),
    ).resolves.toEqual({ canonicalKey, mergedKeys: [] });
    const afterAbandonedReopen = new DatabaseSync(taskDbPath);
    expect(
      afterAbandonedReopen
        .prepare("SELECT migration_id, status FROM workspace_migration_ledger WHERE path = ?")
        .all(workspacePath),
    ).toEqual([{ migration_id: "conflict-migration", status: "abandoned" }]);
    const abandonedActivity = afterAbandonedReopen
      .prepare("SELECT abandoned_activity_json FROM workspace_migration_ledger WHERE path = ?")
      .get(workspacePath) as { abandoned_activity_json: string };
    expect(JSON.parse(abandonedActivity.abandoned_activity_json)).toMatchObject({
      schemaVersion: 2,
      digests: expect.any(Object),
    });
    afterAbandonedReopen
      .prepare("INSERT INTO task_group_view_node_orders VALUES ('task', ?, 1, 1, 1)")
      .run(JSON.stringify(["remote:ssh:unrelated:/other", "unrelated-task"]));
    afterAbandonedReopen.close();
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ status: "abandoned" })],
    });
    const bootstrapChange = new DatabaseSync(taskDbPath);
    bootstrapChange
      .prepare("INSERT INTO task_group_workspace_bootstraps VALUES (?, 'source-group', 1, 1)")
      .run(sourceKey);
    bootstrapChange.close();
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ status: "abandoned-diverged" })],
    });
    const abandonedConfigDir = join(root, "sessions", getWorkspaceHash(workspacePath, sourceKey));
    await mkdir(abandonedConfigDir, { recursive: true });
    await writeFile(join(abandonedConfigDir, "changed-after-abandon.json"), "{}", "utf8");
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: [expect.objectContaining({ status: "abandoned-diverged" })],
    });
    await expect(repo.retryFailedWorkspace(workspacePath)).rejects.toThrow(
      "workspace task identity conflict",
    );
    await expect(repo.listMigrationReports()).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ migrationId: "retry-conflict-migration", status: "failed" }),
        expect.objectContaining({
          migrationId: "conflict-migration",
          status: "abandoned-diverged",
          abandonedAt: 123,
        }),
      ]),
    });

    const flippedTasks = new DatabaseSync(taskDbPath);
    flippedTasks
      .prepare("UPDATE tasks SET updated_at = 200 WHERE workspace_key = ?")
      .run(sourceKey);
    flippedTasks.close();
    const flippedSessions = new DatabaseSync(sessionDbPath);
    flippedSessions
      .prepare("UPDATE session SET time_updated = 200 WHERE workspace_id = ?")
      .run(sourceKey);
    flippedSessions.close();

    await expect(
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey }),
    ).rejects.toThrow("workspace task identity conflict");
    const verifyFlipped = new DatabaseSync(taskDbPath);
    expect(
      verifyFlipped
        .prepare(
          "SELECT COUNT(*) AS count, MAX(canonical_key) AS canonical_key FROM workspace_migration_ledger WHERE path = ? AND status = 'failed'",
        )
        .get(workspacePath),
    ).toEqual({ count: 1, canonical_key: canonicalKey });
    verifyFlipped.close();
  });

  // 写事务逐个并入 source，预检必须比较累积结果；否则 source 之间的冲突要到备份后才暴露，
  // 且每次打开都会重新建账、备份两库。
  it.each([
    ["cronAutomationId", "canonical-missing-task"],
    ["offPeakTaskId", "canonical-missing-task"],
    ["forkedFromTaskId", "canonical-missing-task"],
    ["cronAutomationId", "canonical-task-without-identity"],
  ] as const)(
    "detects %s conflicts between sources before backups when %s",
    async (field, canonicalShape) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-source-conflict-"));
      const taskDbPath = join(root, "tasks-index.sqlite");
      const sessionDbPath = join(root, "db.sqlite");
      const backupRoot = join(root, "backups");
      const workspacePath = "/srv/project";
      const canonicalKey = "remote:ssh:a.example:22:alice:/srv/project";
      const firstSourceKey = "remote:ssh:b.example:22:alice:/srv/project";
      const secondSourceKey = "remote:ssh:c.example:22:alice:/srv/project";
      (await createTaskDb(taskDbPath)).close();
      createSessionDb(sessionDbPath).close();
      let migrationSequence = 0;
      const repo = new SourceServerWorkspaceAliasRepo({
        taskDbPath,
        sessionDbPath,
        backupRoot,
        migrationId: () => `migration-${++migrationSequence}`,
        now: () => 123,
      });
      // 先发布 canonical，再写入 source 数据，避免 source session 参与首次选举。
      await repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey });
      const sessionDb = new DatabaseSync(sessionDbPath);
      sessionDb
        .prepare(
          "INSERT INTO session (id, workspace_id, directory, path, time_updated) VALUES (?, ?, ?, ?, ?)",
        )
        .run("source-session", firstSourceKey, workspacePath, workspacePath, 10);
      sessionDb.close();
      const taskDb = new DatabaseSync(taskDbPath);
      const insert = taskDb.prepare(
        "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, 'Shared', 1, ?, ?)",
      );
      if (canonicalShape === "canonical-task-without-identity") {
        insert.run(canonicalKey, workspacePath, canonicalKey, "shared-task", 30, "{}");
      }
      insert.run(
        firstSourceKey,
        workspacePath,
        firstSourceKey,
        "shared-task",
        10,
        JSON.stringify({ [field]: "identity-b" }),
      );
      insert.run(
        secondSourceKey,
        workspacePath,
        secondSourceKey,
        "shared-task",
        20,
        JSON.stringify({ [field]: "identity-c" }),
      );
      const tasksBefore = taskDb
        .prepare("SELECT workspace_key, meta_json FROM tasks ORDER BY workspace_key")
        .all();
      taskDb.close();

      for (const attempt of [
        () => repo.resolveCanonicalWorkspaceKey({ workspacePath }),
        () => repo.resolveCanonicalWorkspaceKey({ workspacePath }),
        () => repo.retryFailedWorkspace(workspacePath),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          code: "workspace-task-identity-conflict",
          retryable: false,
        });
      }

      const verify = new DatabaseSync(taskDbPath);
      expect(
        verify.prepare("SELECT workspace_key, meta_json FROM tasks ORDER BY workspace_key").all(),
      ).toEqual(tasksBefore);
      expect(
        verify
          .prepare(
            "SELECT migration_id, canonical_key, status, phase, task_backup_path, error FROM workspace_migration_ledger WHERE path = ?",
          )
          .all(workspacePath),
      ).toEqual([
        {
          migration_id: "migration-1",
          canonical_key: canonicalKey,
          status: "failed",
          phase: null,
          task_backup_path: "",
          error: "workspace-task-identity-conflict",
        },
      ]);
      expect(
        verify.prepare("SELECT task_id, source_key FROM workspace_migration_conflicts").all(),
      ).toEqual([{ task_id: "shared-task", source_key: secondSourceKey }]);
      verify.close();
      const verifySessions = new DatabaseSync(sessionDbPath);
      expect(verifySessions.prepare("SELECT workspace_id FROM session").all()).toEqual([
        { workspace_id: firstSourceKey },
      ]);
      verifySessions.close();
      await expect(access(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(root, { recursive: true, force: true });
    },
  );

  it("merges a task shared by sources when their identities are compatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-source-merge-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const workspacePath = "/srv/project";
    const canonicalKey = "remote:ssh:a.example:22:alice:/srv/project";
    const firstSourceKey = "remote:ssh:b.example:22:alice:/srv/project";
    const secondSourceKey = "remote:ssh:c.example:22:alice:/srv/project";
    (await createTaskDb(taskDbPath)).close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "absent-session.sqlite"),
      backupRoot: join(root, "backups"),
    });
    await repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey });
    const taskDb = new DatabaseSync(taskDbPath);
    const insert = taskDb.prepare(
      "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json) VALUES (?, ?, ?, 'shared-task', 'Shared', 1, ?, ?)",
    );
    insert.run(firstSourceKey, workspacePath, firstSourceKey, 10, '{"cronAutomationId":"cron-x"}');
    insert.run(
      secondSourceKey,
      workspacePath,
      secondSourceKey,
      20,
      '{"offPeakTaskId":"off-peak-x"}',
    );
    taskDb.close();

    await expect(repo.resolveCanonicalWorkspaceKey({ workspacePath })).resolves.toMatchObject({
      canonicalKey,
      mergedKeys: [firstSourceKey, secondSourceKey],
    });

    const verify = new DatabaseSync(taskDbPath);
    const rows = verify
      .prepare("SELECT workspace_key, cron_automation_id, off_peak_task_id, meta_json FROM tasks")
      .all();
    expect(rows).toEqual([
      {
        workspace_key: canonicalKey,
        cron_automation_id: "cron-x",
        off_peak_task_id: "off-peak-x",
        meta_json: expect.any(String),
      },
    ]);
    expect(JSON.parse(String(rows[0]!.meta_json))).toMatchObject({
      cronAutomationId: "cron-x",
      offPeakTaskId: "off-peak-x",
    });
    expect(verify.prepare("SELECT status FROM workspace_migration_ledger").all()).toEqual([
      { status: "completed" },
    ]);
    verify.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rebuilds the legacy ledger schema for phases and abandoned audit without losing rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-workspace-alias-schema-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const legacy = await createTaskDb(taskDbPath);
    legacy.exec(`
      CREATE TABLE workspace_migration_ledger (
        migration_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        variant_keys_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        task_backup_path TEXT NOT NULL,
        session_backup_path TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_migration_conflicts (
        migration_id TEXT NOT NULL,
        path TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (migration_id, task_id, source_key)
      );
    `);
    const insertLedger = legacy.prepare(`
      INSERT INTO workspace_migration_ledger VALUES (?, ?, ?, ?, ?, '', NULL, ?, 1, 1)
    `);
    insertLedger.run(
      "completed-old",
      "/completed",
      "remote:ssh:canonical:/completed",
      JSON.stringify(["remote:ssh:canonical:/completed"]),
      "completed",
      null,
    );
    insertLedger.run(
      "failed-old",
      "/failed",
      "remote:ssh:canonical:/failed",
      JSON.stringify(["remote:ssh:canonical:/failed", "remote:ssh:source:/failed"]),
      "failed",
      "workspace-task-identity-conflict",
    );
    insertLedger.run(
      "running-old",
      "/running",
      "remote:ssh:canonical:/running",
      JSON.stringify(["remote:ssh:canonical:/running", "remote:ssh:source:/running"]),
      "running",
      null,
    );
    legacy
      .prepare(
        "INSERT INTO workspace_migration_conflicts VALUES ('failed-old', '/failed', 'task-1', 'remote:ssh:source:/failed', 'remote:ssh:canonical:/failed', 'task-identity-metadata-conflict', 1)",
      )
      .run();
    legacy.close();
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath,
      sessionDbPath: join(root, "missing.sqlite"),
    });

    await expect(repo.getFailedPathCount()).resolves.toBe(1);
    const upgraded = new DatabaseSync(taskDbPath);
    upgraded
      .prepare(`
        INSERT INTO workspace_migration_ledger (
          migration_id, path, canonical_key, variant_keys_json, status, phase,
          task_backup_path, session_backup_path, error, created_at, updated_at,
          abandoned_at, abandoned_trigger, abandoned_activity_json
        ) VALUES ('abandoned-new', '/abandoned', 'remote:ssh:canonical:/abandoned', '[]',
          'abandoned', NULL, '', NULL, NULL, 2, 2, 2, 'user', '{}')
      `)
      .run();
    expect(
      upgraded
        .prepare(
          "SELECT migration_id, status, phase FROM workspace_migration_ledger ORDER BY migration_id",
        )
        .all(),
    ).toEqual([
      { migration_id: "abandoned-new", status: "abandoned", phase: null },
      { migration_id: "completed-old", status: "completed", phase: "completed" },
      { migration_id: "failed-old", status: "failed", phase: null },
      { migration_id: "running-old", status: "running", phase: "preflight" },
    ]);
    expect(
      upgraded
        .prepare("SELECT conflict_kind, conflict_key, task_id FROM workspace_migration_conflicts")
        .get(),
    ).toEqual({
      conflict_kind: "task-identity",
      conflict_key: "task-1",
      task_id: "task-1",
    });
    upgraded.close();
    await expect(repo.getFailedPathCount()).resolves.toBe(1);
    await expect(repo.getAbandonedPathCount()).resolves.toBe(1);
  });
});
