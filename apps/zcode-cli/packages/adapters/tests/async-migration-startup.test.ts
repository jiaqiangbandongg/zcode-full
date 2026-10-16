import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import {
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
} from "../src/storage/session-store/migration-runner.js";
import type { SqliteMigrationProgress } from "../src/storage/session-store/migration-runner.js";

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
const open = (path = ":memory:") => {
  const db = new DatabaseSync(path);
  dbs.push(db);
  return db;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Todo144：迁移启动状态与真实 SQLite 锁", () => {
  it("阶段通知 flush 后才执行 SQL；ready 仅在 commit 之后", async () => {
    const db = open();
    const exec = vi.spyOn(db, "exec");
    const states: SqliteMigrationProgress[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const migrating = runSqliteSessionMigrationsAsync(db, ":memory:", {
      onProgress: async (state) => {
        states.push(state);
        if (state.phase === "migrating" && state.migrationId === "0001_base_session_store") {
          observed();
          await barrier;
        }
        if (state.phase === "committing") expect(db.isTransaction).toBe(true);
        if (state.phase === "ready") expect(db.isTransaction).toBe(false);
      },
    });
    await started;
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='session'").get()).toBeUndefined();
    release();
    await migrating;
    expect(states[0]?.phase).toBe("checking");
    expect(states.at(-1)?.phase).toBe("ready");
    expect(states.at(-1)?.migration?.lastAppliedMigrationId).toBeNull();
    // 本 hotfix 不改迁移算法；状态通知不能让执行路径偏离账本对应的冻结原 SQL。
    const frozenSql = SQLITE_MIGRATIONS.map((migration) => migration.sql);
    expect(exec.mock.calls.map(([sql]) => sql).filter((sql) => frozenSql.includes(sql))).toEqual(
      frozenSql,
    );
    for (const state of states) {
      expect(state).not.toHaveProperty("executionRevision");
      expect(state).not.toHaveProperty("implementationHash");
    }
    const replay: SqliteMigrationProgress[] = [];
    await runSqliteSessionMigrationsAsync(db, ":memory:", {
      onProgress: async (s) => {
        replay.push(s);
      },
    });
    expect(replay.some((s) => s.phase === "migrating")).toBe(false);
    expect(replay.at(-1)?.migration?.lastAppliedMigrationId).toBe(SQLITE_MIGRATIONS.at(-1)?.id);
  });

  it("同库持锁超过旧 5 秒，异步等待不阻塞持有者提交；异库独立就绪", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-startup-lock-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const holder = open(path);
    runSqliteSessionMigrations(holder, path);
    holder.exec("BEGIN IMMEDIATE");
    const waiter = open(path);
    const phases: string[] = [];
    let releaseHolder: ReturnType<typeof setTimeout> | undefined;
    try {
      await runSqliteSessionMigrationsAsync(waiter, path, {
        lockWaitTimeoutMs: 10_000,
        onProgress: async (s) => {
          phases.push(s.phase);
          if (s.phase === "waiting_for_lock" && !releaseHolder) {
            await runSqliteSessionMigrationsAsync(open(), ":memory:");
            releaseHolder = setTimeout(() => holder.exec("COMMIT"), 5_100);
          }
        },
      });
      expect(phases.filter((p) => p === "waiting_for_lock")).toHaveLength(1);
      expect(phases.at(-1)).toBe("ready");
      expect(waiter.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
    } finally {
      if (releaseHolder) clearTimeout(releaseHolder);
    }
  }, 15_000);

  it("失败发 failed，回滚全部未提交项；不伪造 ready", async () => {
    const db = open();
    const states: SqliteMigrationProgress[] = [];
    await expect(
      runSqliteSessionMigrationsAsync(db, ":memory:", {
        onProgress: async (s) => {
          states.push(s);
          if (s.phase === "migrating" && s.migrationId === "0020_provider_model_selection")
            db.exec("DROP TABLE message");
        },
      }),
    ).rejects.toMatchObject({ kind: "sql_failed", migrationId: "0020_provider_model_selection" });
    expect(states.at(-1)?.phase).toBe("failed");
    expect(states.some((s) => s.phase === "ready")).toBe(false);
    expect(db.isTransaction).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
    ).toBeUndefined();
  });

  it("等待预算用尽只失败等待者，保留持有者事务", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-startup-deadline-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const holder = open(path);
    runSqliteSessionMigrations(holder, path);
    holder.exec("BEGIN IMMEDIATE");
    const waiter = open(path);
    const phases: string[] = [];
    await expect(
      runSqliteSessionMigrationsAsync(waiter, path, {
        lockWaitTimeoutMs: 30,
        onProgress: async (s) => {
          phases.push(s.phase);
        },
      }),
    ).rejects.toMatchObject({ kind: "lock_timeout" });
    expect(phases.at(-1)).toBe("failed");
    expect(holder.isTransaction).toBe(true);
  });
});

it("openStartup 保留迁移原始错误，即使 close 也失败", async () => {
  const { SqliteSessionStore } =
    await import("../src/storage/session-store/sqlite-session-store.js");
  const originalClose = SqliteSessionStore.prototype.close;
  vi.spyOn(SqliteSessionStore.prototype, "close").mockImplementation(
    function (this: InstanceType<typeof SqliteSessionStore>) {
      originalClose.call(this);
      throw new Error("secondary close failure");
    },
  );
  const original = Object.assign(new Error("primary storage failure"), { errcode: 13 });
  await expect(
    SqliteSessionStore.openStartup(
      { dbPath: ":memory:" },
      {
        onProgress: async () => {
          throw original;
        },
      },
    ),
  ).rejects.toBe(original);
});

it("SILENTDB-02/04: reports real migration kind and counts only committed SQL as committed", async () => {
  const db = open();
  const states: SqliteMigrationProgress[] = [];
  await runSqliteSessionMigrationsAsync(db, ":memory:", {
    onProgress: async (s) => {
      states.push(s);
    },
  });
  expect(states.at(-1)?.migration).toEqual({
    kind: "initialize",
    executedCount: SQLITE_MIGRATIONS.length,
    committedCount: SQLITE_MIGRATIONS.length,
    lastAppliedMigrationId: null,
  });
  const repeated: SqliteMigrationProgress[] = [];
  await runSqliteSessionMigrationsAsync(db, ":memory:", {
    onProgress: async (s) => {
      repeated.push(s);
    },
  });
  expect(repeated.at(-1)?.migration).toEqual({
    kind: "none",
    executedCount: 0,
    committedCount: 0,
    lastAppliedMigrationId: SQLITE_MIGRATIONS.at(-1)?.id,
  });
  db.exec("DELETE FROM schema_migration WHERE id >= '0020'");
  const failed: SqliteMigrationProgress[] = [];
  await expect(
    runSqliteSessionMigrationsAsync(db, ":memory:", {
      onProgress: async (s) => {
        failed.push(s);
        if (s.phase === "committing") throw new Error("commit barrier failed");
      },
    }),
  ).rejects.toThrow("commit barrier failed");
  expect(failed.find((s) => s.phase === "migrating")?.migration?.kind).toBe("upgrade");
  expect(failed.every((s) => !s.migration?.committedCount)).toBe(true);
  expect(failed.at(-1)?.migration?.lastAppliedMigrationId).toBe(
    SQLITE_MIGRATIONS.find((m) => m.id.startsWith("0019"))?.id,
  );
  expect(db.prepare("SELECT 1 FROM schema_migration WHERE id >= '0020'").get()).toBeUndefined();
});

it("SILENTDB-03: another writer can finish the observed migrations without this waiter executing any", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-other-writer-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const holder = open(path);
  runSqliteSessionMigrations(holder, path);
  holder.exec("DELETE FROM schema_migration WHERE id >= '0020'; BEGIN IMMEDIATE");
  const waiter = open(path);
  const states: SqliteMigrationProgress[] = [];
  const exec = vi.spyOn(waiter, "exec");
  await runSqliteSessionMigrationsAsync(waiter, path, {
    onProgress: async (state) => {
      states.push(state);
      if (state.phase === "waiting_for_lock") {
        expect(state.migration?.kind).toBe("upgrade");
        holder.exec("COMMIT");
        runSqliteSessionMigrations(holder, path);
      }
    },
  });
  expect(states.at(-1)?.migration).toEqual({
    kind: "upgrade",
    executedCount: 0,
    committedCount: 0,
    lastAppliedMigrationId: SQLITE_MIGRATIONS.at(-1)?.id,
  });
  expect(exec.mock.calls.some(([sql]) => SQLITE_MIGRATIONS.some((m) => m.sql === sql))).toBe(false);
  expect(
    states.find((s) => s.phase === "waiting_for_lock")?.migration?.lastAppliedMigrationId,
  ).toBeUndefined();
  expect(states.at(-1)?.migration?.lastAppliedMigrationId).toBe(SQLITE_MIGRATIONS.at(-1)?.id);
});

it("publishes confirmed migration demand when lock contention recurs after precheck", async () => {
  const db = open();
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  let journalBusy = true;
  let transactionBusy = true;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (journalBusy && sql.toLowerCase().includes("pragma journal_mode")) {
      journalBusy = false;
      throw Object.assign(new Error("busy before precheck"), { errcode: 5 });
    }
    return prepare(sql);
  });
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (transactionBusy && sql.toLowerCase() === "begin immediate") {
      transactionBusy = false;
      throw Object.assign(new Error("busy after precheck"), { errcode: 5 });
    }
    exec(sql);
  });
  const waits: SqliteMigrationProgress[] = [];
  await runSqliteSessionMigrationsAsync(db, ":memory:", {
    onProgress: async (state) => {
      if (state.phase === "waiting_for_lock") waits.push(state);
    },
  });
  expect(waits.map((state) => state.migration?.kind)).toEqual([undefined, "initialize"]);
});

it("does not send malformed ledger IDs as telemetry or fail an otherwise prepared database", async () => {
  const db = open();
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare("INSERT INTO schema_migration VALUES (?, 'external', NULL, 0)").run(
    "private / unexpected ID",
  );
  const states: SqliteMigrationProgress[] = [];
  await runSqliteSessionMigrationsAsync(db, ":memory:", {
    onProgress: async (state) => {
      states.push(state);
    },
  });
  expect(states.at(-1)?.phase).toBe("ready");
  expect(states.at(-1)?.migration?.lastAppliedMigrationId).toBeUndefined();
  expect(JSON.stringify(states)).not.toContain("private / unexpected ID");
});
