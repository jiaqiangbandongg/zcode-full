import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { cancelConflictingOffPeakBindings } from "#src/session/offPeakWorkspaceIdentityMigration.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const INVENTORIED_TABLES = [
  "tasks",
  "task_group_members",
  "task_group_admissions",
  "task_group_workspace_bootstraps",
  "task_group_view_node_orders",
  "automations",
  "automation_runs",
  "off_peak_tasks",
] as const;

type InventoriedTable = (typeof INVENTORIED_TABLES)[number];
type MigrationCounts = Record<InventoriedTable, number>;

export interface ControllerRemoteIdentityMigrationOptions {
  dbPath: string;
  oldWorkspaceKey: string;
  newWorkspaceKey: string;
  migrationId?: string;
  now?: () => number;
}

export interface ControllerRemoteIdentityMigrationReport {
  migrationId: string;
  status: "completed" | "failed";
  before: MigrationCounts;
  after: MigrationCounts;
  error?: string;
}

type Database = InstanceType<typeof DatabaseSync>;

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  ).some((row) => row.name === column);
}

function emptyCounts(): MigrationCounts {
  return {
    tasks: 0,
    task_group_members: 0,
    task_group_admissions: 0,
    task_group_workspace_bootstraps: 0,
    task_group_view_node_orders: 0,
    automations: 0,
    automation_runs: 0,
    off_peak_tasks: 0,
  };
}

function countRows(db: Database, workspaceKey: string): MigrationCounts {
  const counts = emptyCounts();
  for (const table of INVENTORIED_TABLES) {
    if (table === "task_group_view_node_orders") {
      if (!hasTable(db, table)) continue;
      const rows = db
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all() as unknown as Array<{ node_key: string }>;
      counts[table] = rows.filter((row) => {
        try {
          const parsed = JSON.parse(row.node_key) as unknown;
          return Array.isArray(parsed) && parsed[0] === workspaceKey;
        } catch {
          return false;
        }
      }).length;
      continue;
    }
    if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) continue;
    counts[table] = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_key = ?`)
        .get(workspaceKey) as { count: number }
    ).count;
  }
  return counts;
}

function updateIdentityColumn(
  db: Database,
  table: Exclude<InventoriedTable, "task_group_view_node_orders">,
  oldWorkspaceKey: string,
  newWorkspaceKey: string,
): void {
  if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) return;
  if (hasColumn(db, table, "workspace_identity")) {
    db.prepare(
      `UPDATE ${table} SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?`,
    ).run(newWorkspaceKey, newWorkspaceKey, oldWorkspaceKey);
  } else {
    db.prepare(`UPDATE ${table} SET workspace_key = ? WHERE workspace_key = ?`).run(
      newWorkspaceKey,
      oldWorkspaceKey,
    );
  }
}

function migrateTaskRows(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "tasks")) return;
  const rows = db
    .prepare("SELECT task_id, updated_at FROM tasks WHERE workspace_key = ?")
    .all(oldKey) as unknown as Array<{ task_id: string; updated_at: number }>;
  for (const row of rows) {
    const target = db
      .prepare("SELECT updated_at FROM tasks WHERE workspace_key = ? AND task_id = ?")
      .get(newKey, row.task_id) as { updated_at: number } | undefined;
    if (target) {
      if (row.updated_at > target.updated_at) {
        db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?").run(
          newKey,
          row.task_id,
        );
      } else {
        db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?").run(
          oldKey,
          row.task_id,
        );
        continue;
      }
    }
    db.prepare(
      "UPDATE tasks SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ? AND task_id = ?",
    ).run(newKey, newKey, oldKey, row.task_id);
  }
  if (hasColumn(db, "tasks", "meta_json")) {
    const migrated = db
      .prepare("SELECT task_id, meta_json FROM tasks WHERE workspace_key = ?")
      .all(newKey) as unknown as Array<{ task_id: string; meta_json: string }>;
    const update = db.prepare(
      "UPDATE tasks SET meta_json = ? WHERE workspace_key = ? AND task_id = ?",
    );
    for (const row of migrated) {
      try {
        const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
        update.run(JSON.stringify({ ...meta, workspaceIdentity: newKey }), newKey, row.task_id);
      } catch {
        // 非法 meta_json 由 TaskIndexRepo 既有读取降级处理；身份列与主键仍已完成迁移。
      }
    }
  }
}

function migrateGroupMembers(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_members")) return;
  db.prepare(`DELETE FROM task_group_members
    WHERE workspace_key = ? AND EXISTS (
      SELECT 1 FROM task_group_members target
      WHERE target.workspace_key = ? AND target.task_id = task_group_members.task_id
    )`).run(oldKey, newKey);
  updateIdentityColumn(db, "task_group_members", oldKey, newKey);
}

function migrateGroupAdmissions(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_admissions")) return;
  // 身份合并不能遗失“已手动整理”或创建 receipt，否则重连后系统登记会覆盖用户操作。
  db.prepare(`INSERT INTO task_group_admissions(workspace_key,task_id,system_kind,user_organized,creation_id)
    SELECT ?,task_id,system_kind,user_organized,creation_id FROM task_group_admissions WHERE workspace_key=?
    ON CONFLICT(workspace_key,task_id) DO UPDATE SET
      system_kind=coalesce(task_group_admissions.system_kind,excluded.system_kind),
      user_organized=max(task_group_admissions.user_organized,excluded.user_organized),
      creation_id=coalesce(task_group_admissions.creation_id,excluded.creation_id)`).run(
    newKey,
    oldKey,
  );
  db.prepare("DELETE FROM task_group_admissions WHERE workspace_key=?").run(oldKey);
}

function migrateBootstrap(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_workspace_bootstraps")) return;
  if (
    db.prepare("SELECT 1 FROM task_group_workspace_bootstraps WHERE workspace_key = ?").get(newKey)
  ) {
    db.prepare("DELETE FROM task_group_workspace_bootstraps WHERE workspace_key = ?").run(oldKey);
  } else {
    updateIdentityColumn(db, "task_group_workspace_bootstraps", oldKey, newKey);
  }
}

function migrateTaskNodeOrders(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_view_node_orders")) return;
  const rows = db
    .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
    .all() as unknown as Array<{ node_key: string }>;
  const deleteRow = db.prepare(
    "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
  );
  const updateRow = db.prepare(
    "UPDATE task_group_view_node_orders SET node_key = ? WHERE node_type = 'task' AND node_key = ?",
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.node_key);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== oldKey) continue;
    const nextKey = JSON.stringify([newKey, parsed[1]]);
    if (
      db
        .prepare(
          "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
        )
        .get(nextKey)
    ) {
      deleteRow.run(row.node_key);
    } else {
      updateRow.run(nextKey, row.node_key);
    }
  }
}

export async function migrateControllerRemoteWorkspaceIdentity(
  options: ControllerRemoteIdentityMigrationOptions,
): Promise<ControllerRemoteIdentityMigrationReport> {
  if (options.oldWorkspaceKey === options.newWorkspaceKey) {
    throw new Error("Controller remote identity migration requires different keys");
  }
  await mkdir(dirname(options.dbPath), { recursive: true });
  const now = options.now ?? Date.now;
  const migrationId = options.migrationId ?? randomUUID();
  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  try {
    await runTasksDatabaseMigrations(db, "controller-remote");
  } catch (error) {
    db.close();
    throw error;
  }
  const before = countRows(db, options.oldWorkspaceKey);
  const emptyAfter = emptyCounts();
  if (Object.values(before).every((count) => count === 0)) {
    // Bug 原因：Source 每次稳定重连都会再次请求 legacy→stable identity 迁移。旧实现即使
    // legacy 已清空，仍执行 BEGIN IMMEDIATE 并新增 ledger；冷启动时它会与 Task Index 写入
    // 争抢同一个 SQLite 锁，真实 pending interaction Source 因而超过 10 秒连接预算。
    // 已无源行时只读目标计数并直接完成，保留首次迁移 ledger 作为唯一审计轨迹。
    try {
      const after = countRows(db, options.newWorkspaceKey);
      return { migrationId, status: "completed", before, after };
    } finally {
      db.close();
    }
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO controller_remote_identity_migrations (
      migration_id, old_workspace_key, new_workspace_key, status,
      before_json, after_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(
      migrationId,
      options.oldWorkspaceKey,
      options.newWorkspaceKey,
      JSON.stringify(before),
      JSON.stringify(emptyAfter),
      now(),
      now(),
    );
    migrateTaskRows(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateGroupMembers(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateGroupAdmissions(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateBootstrap(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateTaskNodeOrders(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    updateIdentityColumn(db, "automations", options.oldWorkspaceKey, options.newWorkspaceKey);
    updateIdentityColumn(db, "automation_runs", options.oldWorkspaceKey, options.newWorkspaceKey);
    cancelConflictingOffPeakBindings(db, options.oldWorkspaceKey, options.newWorkspaceKey, now());
    updateIdentityColumn(db, "off_peak_tasks", options.oldWorkspaceKey, options.newWorkspaceKey);
    const after = countRows(db, options.newWorkspaceKey);
    db.prepare(`UPDATE controller_remote_identity_migrations
      SET status = 'completed', after_json = ?, updated_at = ?
      WHERE migration_id = ?`).run(JSON.stringify(after), now(), migrationId);
    db.exec("COMMIT");
    return { migrationId, status: "completed", before, after };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 无活动事务时无需二次处理。
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.prepare(`INSERT OR REPLACE INTO controller_remote_identity_migrations (
        migration_id, old_workspace_key, new_workspace_key, status,
        before_json, after_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?)`).run(
        migrationId,
        options.oldWorkspaceKey,
        options.newWorkspaceKey,
        JSON.stringify(before),
        JSON.stringify(emptyAfter),
        message.slice(0, 1_000),
        now(),
        now(),
      );
    } catch {
      // 迁移与审计可能因同一磁盘/锁故障失败；二次写入不能覆盖原始错误或阻断握手。
    }
    return { migrationId, status: "failed", before, after: emptyAfter, error: message };
  } finally {
    db.close();
  }
}
