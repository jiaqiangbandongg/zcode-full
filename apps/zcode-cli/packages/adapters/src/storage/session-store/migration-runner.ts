import { dirname, join, basename } from "node:path";
import { sqliteMigrations, MigrationChecksumError } from "@zcode/shared/sqlite-migrations";
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";
import {
  classifyDatabaseStartupError,
  databaseMigrationIdSchema,
  databaseStartupErrorDetails,
  type DatabaseMigrationFacts,
} from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureSqliteSchemaMigrationTable,
  SqliteSchemaMigrationChecksumError,
} from "@zcode/shared/sqlite-migrations";
import { SqliteSessionMigrationError } from "./errors.js";
import { SQLITE_MIGRATIONS } from "./migrations.js";
type SchemaMigrationRow = { id: string; checksum: string };

export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;

const SQLITE_BUSY = 5;
const WAL_RETRY_INITIAL_DELAY_MS = 10;
const WAL_RETRY_MAX_DELAY_MS = 200;

export type SqliteMigrationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing"
  | "ready"
  | "failed";

export interface SqliteMigrationProgress {
  phase: SqliteMigrationPhase;
  migration?: DatabaseMigrationFacts;
  elapsedMs: number;
  migrationId?: string;
  completed?: number;
  total?: number;
  errorCode?: string;
  sqliteCode?: number;
  systemCode?: string;
}

export interface AsyncSqliteMigrationOptions {
  lockWaitTimeoutMs?: number;
  onProgress?: (progress: SqliteMigrationProgress) => Promise<void>;
}

export const DEFAULT_SQLITE_MIGRATION_WAIT_MS = 60 * 60_000;
const ASYNC_NATIVE_BUSY_TIMEOUT_MS = 25;

export async function runSqliteSessionMigrations(
  db: DatabaseSync, dbPath: string, lockTimeoutMs = DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
): Promise<MigrationResult> {
  return runSqliteSessionMigrationsAsync(db, dbPath, { lockWaitTimeoutMs: lockTimeoutMs });
}

export async function runSqliteSessionMigrationsAsync(
  db: DatabaseSync, dbPath: string, options: AsyncSqliteMigrationOptions = {},
): Promise<MigrationResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.lockWaitTimeoutMs ?? DEFAULT_SQLITE_MIGRATION_WAIT_MS);
  let migration: DatabaseMigrationFacts | undefined;
  let migrationId: string | undefined;
  let progressError: unknown;
  const progress = async (phase: SqliteMigrationPhase, extra: Partial<SqliteMigrationProgress> = {}) => {
    try { await options.onProgress?.({ phase, elapsedMs: Date.now() - startedAt, ...(migration ? { migration: { ...migration } } : {}), ...extra }); }
    catch (error) { progressError = error; throw error; }
  };
  const acquire = async (operation: () => void) => {
    let waiting = false;
    let delay = WAL_RETRY_INITIAL_DELAY_MS;
    for (;;) {
      try { operation(); return; } catch (error) {
        if (!isSqliteBusyError(error)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw lockTimeoutError(error, dbPath);
        if (!waiting) { waiting = true; await progress("waiting_for_lock"); }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
        delay = Math.min(WAL_RETRY_MAX_DELAY_MS, delay * 2);
      }
    }
  };
  db.exec(`pragma busy_timeout = ${ASYNC_NATIVE_BUSY_TIMEOUT_MS}`);
  try {
    await progress("checking");
    db.exec("pragma foreign_keys = on");
    await acquire(() => {
      const current = readJournalMode(db);
      if (current === "wal" || isMemoryJournalMode(dbPath, current)) return;
      const mode = readJournalMode(db, true);
      if (mode !== "wal" && !isMemoryJournalMode(dbPath, mode))
        throw new SqliteSessionMigrationError(`SQLite refused WAL journal mode for ${dbPath}; received ${mode}`, { dbPath, kind: "sql_failed" });
    });
    await acquire(() => { migration = { kind: inspectMigrationKind(db, dbPath), executedCount: 0, committedCount: 0 }; });
    await progress("checking");
    await acquire(() => db.exec("begin immediate"));
    ensureSqliteSchemaMigrationTable(db);
    const baseline = db.prepare("SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1").get();
    migration!.lastAppliedMigrationId = baseline ? databaseMigrationIdSchema.safeParse(baseline.id).data : null;
    const directory = dirname(dbPath);
    const dataRoot = basename(directory) === "db" && basename(dirname(directory)) === "cli" ? dirname(dirname(directory)) : directory;
    const result = await sqliteMigrations.migrate(db, SQLITE_MIGRATIONS, {
      database: "cli", transactionOpen: true, appliedAtColumn: "time_applied", backupDirectories: [join(dataRoot, "backup")],
      onBeforeApply: async (id) => { migrationId = id; if (migration!.kind === "none") migration!.kind = "upgrade"; await progress("migrating", { migrationId: id, completed: migration!.executedCount, total: SQLITE_MIGRATIONS.length }); },
      onApplied: () => { migration!.executedCount++; },
      onCommitting: () => progress("committing"),
      onBackupSkipped: () => process.emitWarning(`SQLite migration backup skipped: ${dbPath}`, { code: "ZCODE_MIGRATION_BACKUP_SKIPPED" }),
    });
    migration!.committedCount = migration!.executedCount;
    await progress("ready");
    return result;
  } catch (error) {
    if (db.isTransaction) { try { db.exec("rollback"); } catch { /* 保留首个错误。 */ } }
    const normalized = error instanceof MigrationChecksumError
      ? new SqliteSessionMigrationError(error.message, { cause: error, dbPath, kind: "checksum_mismatch", migrationId: error.migrationId })
      : normalizeMigrationError(error, dbPath, migrationId);
    try { await progress("failed", { errorCode: normalized.kind, ...databaseStartupErrorDetails(normalized), migrationId: normalized.migrationId }); } catch { /* 通知失败不覆盖数据库错误。 */ }
    // 通知端口的异常保留原始对象，不能被数据库错误包装或 close 掩盖。
    throw error === progressError ? error : normalized;
  } finally { if (db.isOpen) db.exec(`pragma busy_timeout = ${DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS}`); }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === SQLITE_BUSY
  );
}

function isMemoryJournalMode(dbPath: string, journalMode: string): boolean {
  return dbPath === ":memory:" && journalMode === "memory";
}

function readJournalMode(db: DatabaseSync, enableWal = false): string {
  const row = db.prepare(enableWal ? "pragma journal_mode = wal" : "pragma journal_mode").get() as
    | Record<string, unknown>
    | undefined;
  const mode = row?.journal_mode;
  return typeof mode === "string" ? mode.toLowerCase() : "unknown";
}


function normalizeMigrationError(
  error: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  if (error instanceof SqliteSessionMigrationError) return error;
  if (error instanceof SqliteSchemaMigrationChecksumError) {
    return new SqliteSessionMigrationError(error.message, {
      dbPath,
      kind: "checksum_mismatch",
      migrationId: error.migrationId,
    });
  }
  if (isSqliteBusyError(error)) return lockTimeoutError(error, dbPath, migrationId);
  return new SqliteSessionMigrationError(
    migrationId
      ? `SQLite migration ${migrationId} failed for ${dbPath}`
      : `SQLite migration initialization failed for ${dbPath}`,
    {
      cause: error,
      dbPath,
      kind: classifyDatabaseStartupError(error),
      migrationId,
    },
  );
}

function lockTimeoutError(
  cause: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  return new SqliteSessionMigrationError(
    `Timed out waiting for SQLite migration lock at ${dbPath}`,
    { cause, dbPath, kind: "lock_timeout", migrationId },
  );
}

function readAppliedMigration(db: DatabaseSync, id: string): SchemaMigrationRow | undefined {
  return db.prepare("select id, checksum from schema_migration where id = ?").get(id) as
    | SchemaMigrationRow
    | undefined;
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}

function ensureMigrationChecksum(
  id: string,
  applied: string,
  current: string,
  dbPath: string,
): void {
  if (applied === current) return;
  throw new SqliteSessionMigrationError(
    `SQLite migration checksum mismatch for ${id}. Historical migrations are immutable; add a new migration instead.`,
    {
      dbPath,
      kind: "checksum_mismatch",
      migrationId: id,
    },
  );
}

/** 只读小型迁移账本，不扫描消息表；存在表但无账本的历史库属于升级。 */
function inspectMigrationKind(db: DatabaseSync, dbPath: string): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'")
    .get();
  let pending = false;
  for (const migration of SQLITE_MIGRATIONS) {
    const row = hasLedger ? readAppliedMigration(db, migration.id) : undefined;
    if (row)
      ensureMigrationChecksum(migration.id, row.checksum, migrationChecksum(migration.sql), dbPath);
    else pending = true;
  }
  if (!pending) return "none";
  const hasDataTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get();
  return hasDataTables ? "upgrade" : "initialize";
}
