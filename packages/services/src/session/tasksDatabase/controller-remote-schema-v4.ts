// 冻结 Controller 审计表结构；workspace 数据迁移仍由业务事务单独记账。
export const CONTROLLER_REMOTE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS controller_remote_identity_migrations (
      migration_id TEXT PRIMARY KEY,
      old_workspace_key TEXT NOT NULL,
      new_workspace_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    SELECT migration_id, old_workspace_key, new_workspace_key, status,
      before_json, after_json, error, created_at, updated_at
      FROM controller_remote_identity_migrations WHERE 0;
  `;
