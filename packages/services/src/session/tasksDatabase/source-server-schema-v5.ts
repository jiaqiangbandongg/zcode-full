import type { DatabaseSync } from "node:sqlite";

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (
    hasTable(db, table) &&
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column)
  );
}

// 冻结旧 v1/v2/v3 接管规则；新变更必须追加 migration，不修改这里的 SQL 或转换语义版本。
const ADD_SESSION_GENERATION_COLUMN =
  "ALTER TABLE workspace_migration_ledger ADD COLUMN session_db_generation TEXT";
const ALIAS_AND_LEGACY_VERSION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS workspace_alias (
        path TEXT PRIMARY KEY,
        canonical_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_migration_schema_version (
        schema_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `;

const LEDGER_STATUS_INDEX = `
        CREATE INDEX IF NOT EXISTS idx_workspace_migration_ledger_status_path
        ON workspace_migration_ledger(status, path);
      `;

const STAGED_LEDGER_AND_CONFLICT_SCHEMA = `
      CREATE TABLE workspace_migration_ledger_v2 (
        migration_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        variant_keys_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'abandoned')),
        phase TEXT CHECK(phase IN ('preflight', 'backups-created', 'task-db-merged', 'session-db-merged', 'config-dirs-merged', 'alias-published', 'completed')),
        task_backup_path TEXT NOT NULL,
        session_backup_path TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        abandoned_at INTEGER,
        abandoned_trigger TEXT,
        abandoned_activity_json TEXT,
        session_db_generation TEXT
      );
      CREATE TABLE workspace_migration_conflicts_v2 (
        migration_id TEXT NOT NULL,
        path TEXT NOT NULL,
        conflict_kind TEXT NOT NULL CHECK(conflict_kind IN ('task-identity', 'config-file')),
        conflict_key TEXT NOT NULL,
        task_id TEXT,
        relative_path TEXT,
        source_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (migration_id, conflict_kind, conflict_key, source_key)
      );
    `;

const PUBLISH_LEDGER_AND_CONFLICT_SCHEMA = `
      ALTER TABLE workspace_migration_ledger_v2 RENAME TO workspace_migration_ledger;
      ALTER TABLE workspace_migration_conflicts_v2 RENAME TO workspace_migration_conflicts;
      CREATE INDEX idx_workspace_migration_ledger_status_path
      ON workspace_migration_ledger(status, path);
    `;

const VERIFY_CURRENT_SCHEMA = `
  SELECT path, canonical_key, created_at, updated_at FROM workspace_alias WHERE 0;
  SELECT migration_id, path, canonical_key, variant_keys_json, status, phase,
    task_backup_path, session_backup_path, error, created_at, updated_at,
    abandoned_at, abandoned_trigger, abandoned_activity_json, session_db_generation
    FROM workspace_migration_ledger WHERE 0;
  SELECT migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
    source_key, canonical_key, reason, created_at FROM workspace_migration_conflicts WHERE 0;
`;

export const SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT = [
  VERIFY_CURRENT_SCHEMA,
  ALIAS_AND_LEGACY_VERSION_SCHEMA,
  LEDGER_STATUS_INDEX,
  STAGED_LEDGER_AND_CONFLICT_SCHEMA,
  PUBLISH_LEDGER_AND_CONFLICT_SCHEMA,
  ADD_SESSION_GENERATION_COLUMN,
  "legacy-ledger-conflicts-copy-and-v3-adoption-v1",
];

export function adoptSourceServerWorkspaceSchema(db: DatabaseSync): void {
  db.exec(ALIAS_AND_LEGACY_VERSION_SCHEMA);
  const versionRow = db
    .prepare(
      "SELECT version FROM workspace_migration_schema_version WHERE schema_name = 'workspace-migration'",
    )
    .get() as { version: number } | undefined;
  if (versionRow && versionRow.version > 3) {
    // 旧二进制不能把未来 schema 静默重建并降回 v2。
    throw new Error(
      `Unsupported newer Source Server migration schema version: ${versionRow.version}`,
    );
  }
  if (versionRow?.version === 3) {
    db.exec(LEDGER_STATUS_INDEX);
    db.exec(VERIFY_CURRENT_SCHEMA);
    return;
  }
  if (versionRow?.version === 2) {
    if (!hasColumn(db, "workspace_migration_ledger", "session_db_generation")) {
      db.exec(ADD_SESSION_GENERATION_COLUMN);
    }
    db.prepare(
      "UPDATE workspace_migration_schema_version SET version = 3, updated_at = ? WHERE schema_name = 'workspace-migration'",
    ).run(Date.now());
    db.exec(LEDGER_STATUS_INDEX);
    db.exec(VERIFY_CURRENT_SCHEMA);
    return;
  }

  const ledgerExists = hasTable(db, "workspace_migration_ledger");
  const conflictsExist = hasTable(db, "workspace_migration_conflicts");
  const legacyHasPhase = hasColumn(db, "workspace_migration_ledger", "phase");
  const legacyHasAbandonedAt = hasColumn(db, "workspace_migration_ledger", "abandoned_at");
  const legacyHasAbandonedTrigger = hasColumn(
    db,
    "workspace_migration_ledger",
    "abandoned_trigger",
  );
  const legacyHasAbandonedActivity = hasColumn(
    db,
    "workspace_migration_ledger",
    "abandoned_activity_json",
  );
  // 旧版本标记缺失不等于代际缺失；重建时必须保留活动计划已冻结的 generation。
  const legacyHasSessionGeneration = hasColumn(
    db,
    "workspace_migration_ledger",
    "session_db_generation",
  );
  const conflictsHaveKind = hasColumn(db, "workspace_migration_conflicts", "conflict_kind");
  const conflictsHaveKey = hasColumn(db, "workspace_migration_conflicts", "conflict_key");
  const conflictsHaveRelativePath = hasColumn(db, "workspace_migration_conflicts", "relative_path");

  db.exec(STAGED_LEDGER_AND_CONFLICT_SCHEMA);
  if (ledgerExists) {
    const phaseExpression = legacyHasPhase
      ? `CASE
             WHEN status = 'completed' THEN 'completed'
             WHEN phase IS NOT NULL THEN phase
             WHEN status = 'failed' AND error IN (
               'workspace-task-identity-conflict', 'workspace-config-file-conflict'
             ) THEN NULL
             ELSE 'preflight'
           END`
      : `CASE
             WHEN status = 'completed' THEN 'completed'
             WHEN status = 'failed' AND error IN (
               'workspace-task-identity-conflict', 'workspace-config-file-conflict'
             ) THEN NULL
             ELSE 'preflight'
           END`;
    db.exec(`
        INSERT INTO workspace_migration_ledger_v2 (
          migration_id, path, canonical_key, variant_keys_json, status, phase,
          task_backup_path, session_backup_path, error, created_at, updated_at,
          abandoned_at, abandoned_trigger, abandoned_activity_json,
          session_db_generation
        )
        SELECT migration_id, path, canonical_key, variant_keys_json, status,
          ${phaseExpression}, task_backup_path, session_backup_path, error,
          created_at, updated_at,
          ${legacyHasAbandonedAt ? "abandoned_at" : "NULL"},
          ${legacyHasAbandonedTrigger ? "abandoned_trigger" : "NULL"},
          ${legacyHasAbandonedActivity ? "abandoned_activity_json" : "NULL"},
          ${legacyHasSessionGeneration ? "session_db_generation" : "NULL"}
        FROM workspace_migration_ledger
      `);
  }
  if (conflictsExist) {
    db.exec(`
        INSERT INTO workspace_migration_conflicts_v2 (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        )
        SELECT migration_id, path,
          ${conflictsHaveKind ? "conflict_kind" : "'task-identity'"},
          ${conflictsHaveKey ? "conflict_key" : "task_id"},
          task_id,
          ${conflictsHaveRelativePath ? "relative_path" : "NULL"},
          source_key, canonical_key, reason, created_at
        FROM workspace_migration_conflicts
      `);
  }
  if (conflictsExist) db.exec("DROP TABLE workspace_migration_conflicts");
  if (ledgerExists) db.exec("DROP TABLE workspace_migration_ledger");
  db.exec(PUBLISH_LEDGER_AND_CONFLICT_SCHEMA);
  db.prepare(`
      INSERT INTO workspace_migration_schema_version (schema_name, version, updated_at)
      VALUES ('workspace-migration', 3, ?)
      ON CONFLICT(schema_name) DO UPDATE SET version = 3, updated_at = excluded.updated_at
    `).run(Date.now());
  db.exec(VERIFY_CURRENT_SCHEMA);
}
