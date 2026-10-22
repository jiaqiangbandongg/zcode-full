// 冻结 0006 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行 Repo 修改 checksum。
export const TASK_GROUP_ADMISSIONS_SQL = `
CREATE TABLE IF NOT EXISTS task_group_admissions (
  workspace_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  system_kind TEXT,
  user_organized INTEGER NOT NULL DEFAULT 0,
  creation_id TEXT,
  PRIMARY KEY (workspace_key, task_id)
);`;
