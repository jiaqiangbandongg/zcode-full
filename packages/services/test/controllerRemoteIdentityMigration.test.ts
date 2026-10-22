import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateControllerRemoteWorkspaceIdentity } from "../src/session/controllerRemoteIdentityMigration.js";
import { TASK_GROUP_ADMISSIONS_SQL } from "#src/task-groups/migration-v6.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

describe("controller remote identity migration inventory", () => {
  it("returns the original failure even when the failed audit cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-controller-audit-failure-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      await runTasksDatabaseMigrations(db, "controller-remote");
      db.exec(`
        CREATE TABLE tasks (workspace_key TEXT, workspace_identity TEXT, workspace_path TEXT, task_id TEXT,
          title TEXT, created_at INTEGER, updated_at INTEGER, meta_json TEXT DEFAULT '{}',
          PRIMARY KEY (workspace_key, task_id));
        INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at)
        VALUES ('old', '/repo', 'task-1', 'Task', 1, 1);
        CREATE TRIGGER fail_migration BEFORE UPDATE ON tasks
        BEGIN SELECT RAISE(ABORT, 'original migration failure'); END;
        CREATE TRIGGER fail_audit BEFORE INSERT ON controller_remote_identity_migrations
        WHEN NEW.status = 'failed'
        BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
      `);
      await expect(
        migrateControllerRemoteWorkspaceIdentity({
          dbPath,
          oldWorkspaceKey: "old",
          newWorkspaceKey: "new",
          migrationId: "failed-audit",
        }),
      ).resolves.toMatchObject({
        migrationId: "failed-audit",
        status: "failed",
        error: "original migration failure",
        before: { tasks: 1 },
        after: { tasks: 0 },
      });
      expect(db.prepare("SELECT workspace_key FROM tasks").all()).toEqual([
        { workspace_key: "old" },
      ]);
      expect(db.prepare("SELECT * FROM controller_remote_identity_migrations").all()).toEqual([]);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rekeys every inventoried workspace table in one transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-controller-identity-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const oldKey = "remote:ssh:old.example:22:alice:/srv/project";
    const newKey = "remote:server:3cd4f9da-cd79-426c-9d70-75f36e9f6a87:/srv/project";
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tasks (workspace_key TEXT, workspace_identity TEXT, workspace_path TEXT, task_id TEXT, updated_at INTEGER, meta_json TEXT, PRIMARY KEY(workspace_key, task_id));
      CREATE TABLE task_group_members (workspace_key TEXT, workspace_identity TEXT, task_id TEXT, PRIMARY KEY(workspace_key, task_id));
      CREATE TABLE task_group_workspace_bootstraps (workspace_key TEXT PRIMARY KEY, group_id TEXT);
      CREATE TABLE task_group_view_node_orders (node_type TEXT, node_key TEXT, sort_order INTEGER, PRIMARY KEY(node_type, node_key));
      CREATE TABLE automations (automation_id TEXT PRIMARY KEY, workspace_key TEXT, workspace_identity TEXT);
      CREATE TABLE automation_runs (run_id TEXT PRIMARY KEY, workspace_key TEXT);
      CREATE TABLE off_peak_tasks (off_peak_task_id TEXT PRIMARY KEY, workspace_key TEXT, workspace_identity TEXT);
    `);
    db.prepare("INSERT INTO tasks VALUES (?, ?, '/srv/project', 'task-1', 10, ?)").run(
      oldKey,
      oldKey,
      JSON.stringify({ taskId: "task-1", workspaceIdentity: oldKey }),
    );
    db.exec(TASK_GROUP_ADMISSIONS_SQL);
    db.prepare(
      "INSERT INTO task_group_admissions(workspace_key,task_id,user_organized,creation_id) VALUES (?, 'task-1', 1, 'created')",
    ).run(oldKey);
    db.prepare("INSERT INTO task_group_members VALUES (?, ?, 'task-1')").run(oldKey, oldKey);
    db.prepare("INSERT INTO task_group_workspace_bootstraps VALUES (?, 'group-1')").run(oldKey);
    db.prepare("INSERT INTO task_group_view_node_orders VALUES ('task', ?, 1)").run(
      JSON.stringify([oldKey, "task-1"]),
    );
    db.prepare("INSERT INTO automations VALUES ('automation-1', ?, ?)").run(oldKey, oldKey);
    db.prepare("INSERT INTO automation_runs VALUES ('run-1', ?)").run(oldKey);
    db.prepare("INSERT INTO off_peak_tasks VALUES ('off-peak-1', ?, ?)").run(oldKey, oldKey);
    db.close();

    const report = await migrateControllerRemoteWorkspaceIdentity({
      dbPath,
      oldWorkspaceKey: oldKey,
      newWorkspaceKey: newKey,
      migrationId: "migration-1",
      now: () => 100,
    });

    expect(report.status).toBe("completed");
    expect(Object.values(report.before)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    const verify = new DatabaseSync(dbPath);
    for (const table of [
      "tasks",
      "task_group_members",
      "task_group_admissions",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ]) {
      expect(
        verify
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_key = ?`)
          .get(oldKey),
      ).toEqual({ count: 0 });
      expect(
        verify
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_key = ?`)
          .get(newKey),
      ).toEqual({ count: 1 });
    }
    expect(
      verify
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .get(),
    ).toEqual({ node_key: JSON.stringify([newKey, "task-1"]) });
    const task = verify.prepare("SELECT workspace_identity, meta_json FROM tasks").get() as {
      workspace_identity: string;
      meta_json: string;
    };
    expect(task.workspace_identity).toBe(newKey);
    expect(JSON.parse(task.meta_json)).toMatchObject({ workspaceIdentity: newKey });
    expect(
      verify.prepare("SELECT status FROM controller_remote_identity_migrations").get(),
    ).toEqual({ status: "completed" });
    verify.close();

    const repeated = await migrateControllerRemoteWorkspaceIdentity({
      dbPath,
      oldWorkspaceKey: oldKey,
      newWorkspaceKey: newKey,
      migrationId: "migration-2",
      now: () => 200,
    });
    expect(Object.values(repeated.before)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Object.values(repeated.after)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    const repeatedVerify = new DatabaseSync(dbPath);
    expect(
      repeatedVerify
        .prepare("SELECT COUNT(*) AS count FROM controller_remote_identity_migrations")
        .get(),
    ).toEqual({ count: 1 });
    repeatedVerify.close();
  });
});
