import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedTaskIndexRowAuthorityFixture } from "./task-list-row-authority-fixture.js";

export function seedDeleteAllArchivedTasksFixture(
  options: Parameters<typeof seedTaskIndexRowAuthorityFixture>[0],
): void {
  seedTaskIndexRowAuthorityFixture(options);
  // Node 的 SQLite 只有同步接口；在隔离 HOME、Host 启动前准备真实列表数据。
  const database = new DatabaseSync(join(options.e2eHomeDir, ".zcode", "v2", "tasks-index.sqlite"));
  try {
    database.exec(`
      UPDATE tasks SET archived = 1;
      INSERT INTO tasks (
        workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
        provider, mode, model, created_at, updated_at, pinned, archived, deleted,
        title_overridden, searchable_text, meta_json
      ) SELECT workspace_key, workspace_path, workspace_identity, 'bulk-delete-active-control',
        'E2E_BULK_DELETE_ACTIVE_CONTROL', 'completed', provider, mode, model,
        created_at, updated_at, 0, 0, 0, 1, 'E2E_BULK_DELETE_ACTIVE_CONTROL',
        json_set(meta_json, '$.taskId', 'bulk-delete-active-control', '$.title', 'E2E_BULK_DELETE_ACTIVE_CONTROL')
        FROM tasks LIMIT 1;
    `);
  } finally {
    database.close();
  }
}
