import type { DatabaseSync } from "node:sqlite";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";

export const INITIAL_WORKSPACE_ORDER_SQL =
  "ALTER TABLE remote_project_entries ADD COLUMN initial_position INTEGER";

/** 只在同一事务首次建立项目时调用；已经升级的用户不能再从旧 settings 猜顺序。 */
export function migrateInitialWorkspaceOrder(
  db: DatabaseSync,
  context: ProjectMigrationContext,
): void {
  if ((context.hostId ?? "local") !== "local") return;
  let position = 0;
  const assigned = new Set<string>();
  for (const workspace of context.settings?.lastWorkspaceSession ?? []) {
    if (workspace.kind === "remote") {
      // 原迁移分开写本地项目和远端入口，丢失了混排位置；按同事务复制的完整入口匹配，避免同路径串 Host。
      const legacy = JSON.stringify(workspace);
      if (assigned.has(legacy)) continue;
      assigned.add(legacy);
      const result = db
        .prepare(
          "UPDATE remote_project_entries SET initial_position=? WHERE legacy_workspace_json=?",
        )
        .run(position, legacy);
      if (result.changes) position++;
    } else {
      const project = db
        .prepare(`SELECT p.project_id FROM projects p
        JOIN project_roots r ON r.project_id=p.project_id
        WHERE p.host_id='local' AND p.deleted=0 AND r.root_path=?`)
        .get(workspace.workspacePath);
      if (!project || assigned.has(String(project.project_id))) continue;
      assigned.add(String(project.project_id));
      db.prepare("UPDATE projects SET position=? WHERE project_id=?").run(
        position++,
        project.project_id!,
      );
    }
  }
}
