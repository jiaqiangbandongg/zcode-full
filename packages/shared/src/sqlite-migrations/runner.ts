import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MigrationOptions, MigrationResult, SqliteMigration } from "./contract.js";
import { MigrationChecksumError } from "./contract.js";
import { createMigrationBackup } from "./backup.js";
import { identifier } from "./table-snapshot.js";

const flights = new Map<string, Promise<MigrationResult>>();

export async function migrate(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<MigrationResult> {
  // 合并上游迁移时曾漏填清单，运行成功却没有备份；必须在任何 SQL 写入前拒绝。
  for (const migration of migrations) {
    if (
      !Array.isArray(migration.touchedTables) ||
      !migration.touchedTables.length ||
      migration.touchedTables.some(
        (table) => typeof table !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table),
      )
    )
      throw new Error(`Migration ${migration.id} requires valid touchedTables`);
  }
  if (options.transactionOpen) return migrateExclusive(db, migrations, options);
  const location = db
    .prepare("pragma database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  if (typeof location !== "string" || !location) return migrateExclusive(db, migrations, options);
  // 同进程第二个同步 SQLite 锁等待会阻塞第一个迁移的异步备份；按实际数据库路径串行 admission。
  const previous = flights.get(location);
  const flight = (async () => {
    if (previous) await previous.catch(() => undefined);
    return migrateExclusive(db, migrations, options);
  })();
  flights.set(location, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(location) === flight) flights.delete(location);
  }
}

async function migrateExclusive(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<MigrationResult> {
  if (db.isTransaction !== Boolean(options.transactionOpen)) throw new Error("Migration transaction ownership mismatch");
  if (!options.backupDirectories.length) throw new Error("Migration requires a backup directory");
  if (!options.transactionOpen) db.exec("begin immediate");
  try {
    const taskJournal = options.journalTable === "tasks_schema_migration";
    const journal = identifier(options.journalTable ?? "schema_migration");
    const appliedAt = identifier(
      taskJournal ? "time_applied" : (options.appliedAtColumn ?? "applied_at"),
    );
    const versionDefinition = taskJournal ? "" : "app_version text,";
    const versionColumn = taskJournal ? "" : "app_version,";
    db.exec(
      `create table if not exists ${journal} (id text primary key, checksum text not null, ${versionDefinition} ${appliedAt} integer not null)`,
    );
    const pending: SqliteMigration[] = [];
    for (const migration of migrations) {
      const ids = [migration.id, ...(migration.previousIds ?? [])];
      const appliedIds = ids.filter((id) => {
        const applied = db.prepare(`select checksum from ${journal} where id=?`).get(id);
        if (applied && applied.checksum !== checksum(migration.sql))
          throw new MigrationChecksumError(id);
        return Boolean(applied);
      });
      if (!appliedIds.length) pending.push(migration);
      else if (!appliedIds.includes(migration.id)) {
        // 项目迁移会创建容器并分配归属；改号只能沿用旧结果，不能重新执行 apply。
        db.prepare(`insert into ${journal}(id,checksum,${versionColumn}${appliedAt})
          select ?,checksum,${versionColumn}${appliedAt} from ${journal} where id=?`).run(
          migration.id,
          appliedIds[0]!,
        );
      }
    }
    const backup = pending.length
      ? await createMigrationBackup(db, pending, options)
      : { skipped: false };
    for (const migration of pending) {
      await options.onBeforeApply?.(migration.id);
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql);
      options.onApplied?.(migration.id);
      db.prepare(
        `insert into ${journal} (id,checksum,${versionColumn}${appliedAt}) values (?,?${taskJournal ? "" : ",?"},?)`,
      ).run(
        migration.id,
        checksum(migration.sql),
        ...(taskJournal ? [] : [migration.appVersion]),
        (options.now ?? Date.now)(),
      );
    }
    await options.onCommitting?.();
    db.exec("commit");
    return {
      applied: pending.map((migration) => migration.id),
      ...(backup.path ? { backupPath: backup.path } : {}),
      backupSkipped: backup.skipped,
    };
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}
