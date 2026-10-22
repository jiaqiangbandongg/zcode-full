import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SqliteSchemaMigration {
  id: string;
  sql: string;
  appVersion: string;
}

export class SqliteSchemaMigrationChecksumError extends Error {
  public constructor(public readonly migrationId: string) {
    super(
      `SQLite migration checksum mismatch for ${migrationId}. Historical migrations are immutable; add a new migration instead.`,
    );
    this.name = "SqliteSchemaMigrationChecksumError";
  }
}

export function ensureSqliteSchemaMigrationTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    app_version TEXT,
    time_applied INTEGER NOT NULL
  )`);
}

/** 调用方持有库级事务；Agent 与 Source 使用同一应用原语，避免相同 ID 的 checksum 漂移。 */
export function applySqliteSchemaMigration(
  db: DatabaseSync,
  migration: SqliteSchemaMigration,
  onExecuted?: () => void,
): void {
  if (!db.isTransaction) throw new Error("SQLite schema migration requires an active transaction");
  if (isMigrationApplied(db, migration)) return;
  db.exec(migration.sql);
  // SQL 执行与账本提交是两件事实；记账失败时启动端仍需报告已执行数量。
  onExecuted?.();
  db.prepare(
    "INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)",
  ).run(migration.id, migrationChecksum(migration), migration.appVersion, Date.now());
}

function migrationChecksum(migration: SqliteSchemaMigration): string {
  return createHash("sha256").update(migration.sql.trim()).digest("hex");
}

function isMigrationApplied(db: DatabaseSync, migration: SqliteSchemaMigration): boolean {
  const applied = db
    .prepare("SELECT checksum FROM schema_migration WHERE id = ?")
    .get(migration.id);
  if (!applied) return false;
  if (applied.checksum !== migrationChecksum(migration)) {
    throw new SqliteSchemaMigrationChecksumError(migration.id);
  }
  return true;
}

// 已发布的 SQL 必须冻结；identity 值属于合并计划，schema 迁移只接管结构与账本。
// 分支合并时曾与软删除迁移共用 0023；发布前统一为 0024，保持 SQL/checksum 不变。
export const SESSION_DATABASE_IDENTITY_MIGRATION: SqliteSchemaMigration = {
  id: "0024_session_database_identity",
  appVersion: "0.16.9",
  sql: `
    CREATE TABLE IF NOT EXISTS zcode_database_identity (
      scope TEXT PRIMARY KEY,
      identity TEXT NOT NULL
    );
    SELECT scope, identity FROM zcode_database_identity WHERE 0;
  `,
};

/** Source 可能先于 Agent 启动；只接管独立附加表，不代跑 Agent 的历史业务转换。 */
export function runSessionDatabaseIdentityMigration(db: DatabaseSync): void {
  // 修复原因：已有 alias 的解析也执行此入口，重复抢写锁会被 Agent 写入阻塞。
  // 只读校验已登记项；未登记时由下面事务内的应用原语重新检查并原子记账。
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'")
      .get() &&
    isMigrationApplied(db, SESSION_DATABASE_IDENTITY_MIGRATION)
  ) {
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureSqliteSchemaMigrationTable(db);
    applySqliteSchemaMigration(db, SESSION_DATABASE_IDENTITY_MIGRATION);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
