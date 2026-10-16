import {
  classifyDatabaseStartupError,
  databaseMigrationIdSchema,
  databaseStartupErrorDetails,
  type DatabaseMigrationFacts,
} from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SqliteSessionMigrationError } from "./errors.js";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import type { SchemaMigrationRow } from "./rows.js";

export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;

const SQLITE_BUSY = 5;
const WAL_RETRY_INITIAL_DELAY_MS = 10;
const WAL_RETRY_MAX_DELAY_MS = 200;
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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
type MigrationStep = SqliteMigrationProgress | { delayMs: number };

export function runSqliteSessionMigrations(
  db: DatabaseSync,
  dbPath: string,
  lockTimeoutMs = DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
): void {
  for (const step of migrationSteps(db, dbPath, lockTimeoutMs)) {
    if ("delayMs" in step) waitSync(step.delayMs);
  }
}

export async function runSqliteSessionMigrationsAsync(
  db: DatabaseSync,
  dbPath: string,
  options: AsyncSqliteMigrationOptions = {},
): Promise<void> {
  // 同步 SQLite 仅短暂等待一次；真正的启动等待让出事件循环，通知可以先 flush。
  // 业务连接不能继承升级的一小时等待预算。迁移结束（含失败）恢复原有 5 秒策略。
  db.exec(`pragma busy_timeout = ${ASYNC_NATIVE_BUSY_TIMEOUT_MS}`);
  const steps = migrationSteps(
    db,
    dbPath,
    options.lockWaitTimeoutMs ?? DEFAULT_SQLITE_MIGRATION_WAIT_MS,
  );
  let failed = false;
  try {
    for (const step of steps) {
      if ("delayMs" in step)
        await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs));
      else if (step.phase === "failed") {
        try {
          await options.onProgress?.(step);
        } catch {
          /* 错误通知失败不能覆盖原数据库异常。 */
        }
      } else await options.onProgress?.(step);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // 通知传输失败也会关闭 generator 的事务，不能将半迁移连接交给业务。
    try {
      steps.return();
      db.exec(`pragma busy_timeout = ${DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS}`);
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

function* migrationSteps(
  db: DatabaseSync,
  dbPath: string,
  lockTimeoutMs: number,
): Generator<MigrationStep, void> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, lockTimeoutMs);
  let migrationFacts: DatabaseMigrationFacts | undefined;
  const progress = (phase: SqliteMigrationPhase): SqliteMigrationProgress => ({
    phase,
    elapsedMs: Date.now() - startedAt,
    ...(migrationFacts ? { migration: { ...migrationFacts } } : {}),
  });
  let transactionStarted = false;
  function* acquire(operation: () => void): Generator<MigrationStep, void> {
    // 每个拿锁阶段独立报告：预检前的未知等待不能吞掉确认迁移后的等待。
    let waitingReported = false;
    let retryDelayMs = WAL_RETRY_INITIAL_DELAY_MS;
    while (true) {
      try {
        operation();
        return;
      } catch (error) {
        // SQLITE_LOCKED 常指同连接/共享缓存冲突；只重试外部写者竞争的 SQLITE_BUSY。
        if (!isSqliteBusyError(error)) throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw lockTimeoutError(error, dbPath);
        if (!waitingReported) {
          waitingReported = true;
          yield progress("waiting_for_lock");
        }
        yield { delayMs: Math.min(remainingMs, retryDelayMs) };
        retryDelayMs = Math.min(WAL_RETRY_MAX_DELAY_MS, retryDelayMs * 2);
      }
    }
  }
  try {
    yield progress("checking");
    db.exec("pragma foreign_keys = on");
    yield* acquire(() => {
      const current = readJournalMode(db);
      if (current === "wal" || isMemoryJournalMode(dbPath, current)) return;
      const mode = readJournalMode(db, true);
      if (mode !== "wal" && !isMemoryJournalMode(dbPath, mode)) {
        throw new SqliteSessionMigrationError(
          `SQLite refused WAL journal mode for ${dbPath}; received ${mode}`,
          { dbPath, kind: "sql_failed" },
        );
      }
    });
    // 预检只决定展示；真正执行仍在拿锁后逐项核对，其他窗口完成后不会重复迁移。
    yield* acquire(() => {
      migrationFacts = {
        kind: inspectMigrationKind(db, dbPath),
        executedCount: 0,
        committedCount: 0,
      };
    });
    yield progress("checking");
    // SQLite 是唯一协调者；拿锁后读取真实账本，等待者不会重复迁移已提交项。
    yield* acquire(() => db.exec("begin immediate"));
    transactionStarted = true;
    db.exec(`create table if not exists schema_migration (
      id text primary key, checksum text not null, app_version text, time_applied integer not null
    )`);
    // 拿锁后记录起点，避免预检时其他写者尚未提交；后续迁移不得覆盖它。
    const baseline = db.prepare("SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1").get();
    if (migrationFacts)
      migrationFacts.lastAppliedMigrationId = baseline
        ? databaseMigrationIdSchema.safeParse(baseline.id).data
        : null;
    let completed = 0;
    for (const migration of SQLITE_MIGRATIONS) {
      try {
        const checksum = migrationChecksum(migration.sql);
        const applied = readAppliedMigration(db, migration.id);
        if (applied) {
          ensureMigrationChecksum(migration.id, applied.checksum, checksum, dbPath);
          completed++;
          continue;
        }
        // 预检后出现新待执行项时，以锁内账本为准提升种类，不能带 none 执行 SQL。
        if (migrationFacts?.kind === "none") migrationFacts.kind = "upgrade";
        yield {
          ...progress("migrating"),
          migrationId: migration.id,
          completed,
          total: SQLITE_MIGRATIONS.length,
        };
        // 本 hotfix 只调整启动等待；执行与账本校验共用冻结原 SQL，避免维护两套转换语义。
        db.exec(migration.sql);
        if (migrationFacts) migrationFacts.executedCount++;
        db.prepare(
          "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)",
        ).run(migration.id, checksum, migration.appVersion, Date.now());
        completed++;
      } catch (error) {
        throw normalizeMigrationError(error, dbPath, migration.id);
      }
    }
    yield progress("committing");
    db.exec("commit");
    transactionStarted = false;
    if (migrationFacts) migrationFacts.committedCount = migrationFacts.executedCount;
    yield progress("ready");
  } catch (error) {
    // 先回滚，再通知失败；通知不能让业务看到仍在事务内的 failed。
    if (transactionStarted && db.isTransaction) {
      try {
        db.exec("rollback");
      } catch {
        /* 关闭连接时恢复，保留原始异常。 */
      }
    }
    transactionStarted = false;
    const normalized = normalizeMigrationError(error, dbPath);
    yield {
      ...progress("failed"),
      errorCode: normalized.kind,
      ...databaseStartupErrorDetails(normalized),
      migrationId: normalized.migrationId,
    };
    throw normalized;
  } finally {
    if (transactionStarted && db.isTransaction) {
      try {
        db.exec("rollback");
      } catch {
        /* 调用方关闭连接，保留原始异常。 */
      }
    }
  }
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

function waitSync(delayMs: number): void {
  Atomics.wait(waitBuffer, 0, 0, Math.max(1, Math.ceil(delayMs)));
}

function normalizeMigrationError(
  error: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  if (error instanceof SqliteSessionMigrationError) return error;
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
