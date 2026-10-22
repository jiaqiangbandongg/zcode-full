import { DatabaseSync } from "node:sqlite";
import type { DatabaseMigrationFacts } from "@zcode/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { migrateControllerRemoteWorkspaceIdentity } from "#src/session/controllerRemoteIdentityMigration.js";
import { SourceServerWorkspaceAliasRepo } from "#src/session/sourceServerWorkspaceAliasRepo.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-remote-schema-"));
  roots.push(root);
  const taskDbPath = join(root, "tasks.sqlite");
  const sessionDbPath = join(root, "session.sqlite");
  return { taskDbPath, sessionDbPath, backupRoot: join(root, "backups") };
}

it("已迁移 Controller 无源行重连在其他连接持写锁时只读返回，checksum 仍校验", async () => {
  const options = await fixture();
  const writer = new DatabaseSync(options.taskDbPath);
  const input = {
    dbPath: options.taskDbPath,
    oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
    newWorkspaceKey: "remote:server:source:/repo",
  };
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    await runTasksDatabaseMigrations(writer);
    writer
      .prepare(`INSERT INTO tasks
      (workspace_key, workspace_path, workspace_identity, task_id, created_at, updated_at)
      VALUES (?, '/repo', ?, 'task-1', 1, 1)`)
      .run(input.oldWorkspaceKey, input.oldWorkspaceKey);
    await migrateControllerRemoteWorkspaceIdentity(input);
    const ledger = writer.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    const audit = writer.prepare("SELECT * FROM controller_remote_identity_migrations").all();
    writer.exec("BEGIN IMMEDIATE; UPDATE tasks SET updated_at = 2");
    // 保持真实写锁直到断言结束；错误实现无法靠等待 writer 释放而偶然通过。
    await expect(migrateControllerRemoteWorkspaceIdentity(input)).resolves.toMatchObject({
      status: "completed",
      before: { tasks: 0 },
      after: { tasks: 1 },
    });
    writer.exec("ROLLBACK");
    expect(writer.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(
      ledger,
    );
    expect(writer.prepare("SELECT * FROM controller_remote_identity_migrations").all()).toEqual(
      audit,
    );
    writer.exec(`UPDATE tasks_schema_migration SET checksum = 'broken'
      WHERE id = '0004_controller_remote_identity'; BEGIN IMMEDIATE`);
    await expect(migrateControllerRemoteWorkspaceIdentity(input)).rejects.toThrow(/checksum/);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

it("Source 管理查询在已迁移 task 库持写锁时只读返回", async () => {
  const options = await fixture();
  const writer = new DatabaseSync(options.taskDbPath);
  const repo = new SourceServerWorkspaceAliasRepo(options);
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    await repo.getFailedPathCount();
    const ledger = writer.prepare("SELECT * FROM tasks_schema_migration").all();
    writer.exec("BEGIN IMMEDIATE");
    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    await expect(repo.getAbandonedPathCount()).resolves.toBe(0);
    writer.exec("ROLLBACK");
    expect(writer.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual(ledger);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

it("Source 已有 alias 在 session 库持写锁时可解析，identity 账本不变且 checksum 仍校验", async () => {
  const options = await fixture();
  const writer = new DatabaseSync(options.sessionDbPath);
  const canonicalKey = "remote:ssh:one:22:u:/repo";
  const input = { workspacePath: "/repo", legacyRouteHint: canonicalKey };
  const repo = new SourceServerWorkspaceAliasRepo(options);
  try {
    writer.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, workspace_id TEXT, directory TEXT, path TEXT, time_updated INTEGER)`);
    writer
      .prepare("INSERT INTO session VALUES ('session-1', ?, '/repo', '/repo', 1)")
      .run(canonicalKey);
    await repo.resolveCanonicalWorkspaceKey(input);
    const ledger = writer.prepare("SELECT * FROM schema_migration").all();
    writer.exec("BEGIN IMMEDIATE; UPDATE session SET time_updated = 2");
    await expect(repo.resolveCanonicalWorkspaceKey(input)).resolves.toEqual({
      canonicalKey,
      mergedKeys: [],
    });
    writer.exec("ROLLBACK");
    expect(writer.prepare("SELECT * FROM schema_migration").all()).toEqual(ledger);
    writer.exec(`UPDATE schema_migration SET checksum = 'broken'
      WHERE id = '0024_session_database_identity'; BEGIN IMMEDIATE`);
    await expect(repo.resolveCanonicalWorkspaceKey(input)).rejects.toThrow(/checksum/);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

it("并发 Source/Core 初始化只记账一次，默认业务表与远端扩展可以交错接管", async () => {
  const options = await fixture();
  const compiled = await build({
    entryPoints: [resolve("packages/services/src/session/tasksDatabase/migrations.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    // #src 属于各自 package；全局 alias 会把 shared 的入口错误重定向到 services。
  });
  const gate = new SharedArrayBuffer(4);
  const workers = ["source-server", "base", "source-server"].map(
    (scope) =>
      new Worker(
        `${compiled.outputFiles[0]!.text}
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new (require('node:sqlite').DatabaseSync)(workerData.path);
    db.exec('PRAGMA busy_timeout = 5000');
    parentPort.postMessage('ready');
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    module.exports.runTasksDatabaseMigrations(db, workerData.scope).then(() => db.close());`,
        { eval: true, workerData: { path: options.taskDbPath, scope, gate } },
      ),
  );
  try {
    const exits = workers.map((worker) => once(worker, "exit"));
    await Promise.all(workers.map((worker) => once(worker, "message")));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    expect(await Promise.all(exits)).toEqual([[0], [0], [0]]);
    const db = new DatabaseSync(options.taskDbPath);
    try {
      expect(db.prepare("SELECT id FROM tasks_schema_migration ORDER BY id").all()).toEqual([
        { id: "0001_adopt_task_schema" },
        { id: "0002_provider_selection" },
        { id: "0003_official_glm_selection" },
        { id: "0004_project_execution_scopes" },
        { id: "0005_source_server_workspace_schema" },
        { id: "0006_task_group_admissions" },
      ]);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      db.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it("Controller 与 Source 的附加表登记到同库账本，保留旧记录且不混用专属表", async () => {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    await runTasksDatabaseMigrations(db);
    const oldLedger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    await migrateControllerRemoteWorkspaceIdentity({
      dbPath: options.taskDbPath,
      oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
      newWorkspaceKey: "remote:server:source:/repo",
    });
    expect(db.prepare("SELECT id FROM tasks_schema_migration WHERE id LIKE '0004%'").get()).toEqual(
      {
        id: "0004_controller_remote_identity",
      },
    );
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_alias'").get(),
    ).toBeUndefined();
    const beforeReopen = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    await migrateControllerRemoteWorkspaceIdentity({
      dbPath: options.taskDbPath,
      oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
      newWorkspaceKey: "remote:server:source:/repo",
    });
    expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(
      beforeReopen,
    );
    expect(
      db
        .prepare(
          "SELECT * FROM tasks_schema_migration WHERE id != '0004_controller_remote_identity' AND id != '0005_source_server_workspace_schema' ORDER BY id",
        )
        .all(),
    ).toEqual(oldLedger);
  } finally {
    db.close();
  }
  const sourceOptions = await fixture();
  const sourceDb = new DatabaseSync(sourceOptions.taskDbPath);
  try {
    const repo = new SourceServerWorkspaceAliasRepo(sourceOptions);
    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    expect(sourceDb.prepare("SELECT id FROM tasks_schema_migration").all()).toEqual([
      { id: "0005_source_server_workspace_schema" },
    ]);
    expect(
      sourceDb
        .prepare("SELECT 1 FROM sqlite_master WHERE name='controller_remote_identity_migrations'")
        .get(),
    ).toBeUndefined();
    const sourceLedger = sourceDb.prepare("SELECT * FROM tasks_schema_migration").all();
    await repo.getFailedPathCount();
    await runTasksDatabaseMigrations(sourceDb);
    expect(
      sourceDb.prepare("SELECT * FROM tasks_schema_migration WHERE id LIKE '0005%'").all(),
    ).toEqual(sourceLedger);
  } finally {
    sourceDb.close();
  }
});

it("Source schema 和正式账本原子提交，记账失败回滚，checksum 损坏明确拒绝", async () => {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    await runTasksDatabaseMigrations(db);
    db.exec(`CREATE TRIGGER reject_remote_migration BEFORE INSERT ON tasks_schema_migration
      WHEN NEW.id = '0005_source_server_workspace_schema'
      BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END;`);
    const repo = new SourceServerWorkspaceAliasRepo(options);
    await expect(repo.getFailedPathCount()).rejects.toThrow("injected ledger failure");
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_alias'").get(),
    ).toBeUndefined();
    db.exec("DROP TRIGGER reject_remote_migration");
    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    db.exec(
      "UPDATE tasks_schema_migration SET checksum='broken' WHERE id='0005_source_server_workspace_schema'",
    );
    await expect(repo.getFailedPathCount()).rejects.toThrow(/checksum/);
  } finally {
    db.close();
  }
});

it("接管无旧版本标记的完整表时，保留活动计划的 phase 和 session generation", async () => {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    const repo = new SourceServerWorkspaceAliasRepo(options);
    await repo.getFailedPathCount();
    db.exec(`INSERT INTO workspace_migration_ledger
      (migration_id, path, canonical_key, variant_keys_json, status, phase, task_backup_path,
       created_at, updated_at, session_db_generation)
      VALUES ('active-plan', '/repo', 'canonical', '[]', 'running', 'task-db-merged', '/backup', 1, 2, 'frozen-generation');
      DELETE FROM workspace_migration_schema_version;
      DELETE FROM tasks_schema_migration WHERE id='0005_source_server_workspace_schema';`);
    const before = db.prepare("SELECT * FROM workspace_migration_ledger").all();
    await repo.getFailedPathCount();
    expect(db.prepare("SELECT * FROM workspace_migration_ledger").all()).toEqual(before);
  } finally {
    db.close();
  }
});

it("Source 首次创建 session identity 表时登记 schema_migration，已有 identity 保持不变", async () => {
  const options = await fixture();
  const taskDb = new DatabaseSync(options.taskDbPath);
  const sessionDb = new DatabaseSync(options.sessionDbPath);
  const canonical = "remote:ssh:one:22:u:/repo";
  const variant = "remote:ssh:two:22:u:/repo";
  try {
    await runTasksDatabaseMigrations(taskDb);
    const insert = taskDb.prepare(`INSERT INTO tasks
      (workspace_key, workspace_path, workspace_identity, task_id, created_at, updated_at)
      VALUES (?, '/repo', ?, ?, 1, ?)`);
    insert.run(canonical, canonical, "task-1", 20);
    insert.run(variant, variant, "task-2", 10);
    sessionDb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, workspace_id TEXT, directory TEXT, path TEXT, time_updated INTEGER);
      CREATE TABLE zcode_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL);
      INSERT INTO zcode_database_identity VALUES ('session', 'legacy-generation');`);
    const repo = new SourceServerWorkspaceAliasRepo(options);
    await repo.resolveCanonicalWorkspaceKey({ workspacePath: "/repo", legacyRouteHint: canonical });
    expect(sessionDb.prepare("SELECT id FROM schema_migration").all()).toEqual([
      { id: "0024_session_database_identity" },
    ]);
    expect(sessionDb.prepare("SELECT identity FROM zcode_database_identity").get()).toEqual({
      identity: "legacy-generation",
    });
  } finally {
    sessionDb.close();
    taskDb.close();
  }
});

it.each(["base", "controller-remote", "source-server"] as const)(
  "启动门禁与 %s scope 共用事务，已迁移时也完成交接提交",
  async (scope) => {
    const db = new DatabaseSync(":memory:");
    try {
      const migration: DatabaseMigrationFacts = {
        kind: "initialize",
        executedCount: 0,
        committedCount: 0,
      };
      const phases: string[] = [];
      db.exec("BEGIN IMMEDIATE");
      await runTasksDatabaseMigrations(db, {
        scope,
        transactionOpen: true,
        migration,
        onProgress: (phase) => phases.push(phase),
      });
      const expectedCount = scope === "base" ? 5 : 1;
      expect(db.isTransaction).toBe(false);
      expect(migration).toEqual({
        kind: "initialize",
        executedCount: expectedCount,
        committedCount: expectedCount,
        lastAppliedMigrationId: null,
      });
      expect(phases.filter((phase) => phase === "migrating")).toHaveLength(expectedCount);
      expect(phases.at(-1)).toBe("committing");
      const ledger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
      const repeated: DatabaseMigrationFacts = {
        kind: "none",
        executedCount: 0,
        committedCount: 0,
      };
      db.exec("BEGIN IMMEDIATE");
      await runTasksDatabaseMigrations(db, { scope, transactionOpen: true, migration: repeated });
      expect(db.isTransaction).toBe(false);
      expect(repeated).toEqual({
        kind: "none",
        executedCount: 0,
        committedCount: 0,
        lastAppliedMigrationId: ledger.at(-1)?.id,
      });
      expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(ledger);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  },
);
