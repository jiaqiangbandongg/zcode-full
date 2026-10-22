import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateControllerRemoteWorkspaceIdentity } from "#src/session/controllerRemoteIdentityMigration.js";
import { SourceServerWorkspaceAliasRepo } from "#src/session/sourceServerWorkspaceAliasRepo.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

type MigrationMode = "controller" | "source";
const workspacePath = "/srv/project";
const sourceKey = "remote:ssh:old.example:22:dev:/srv/project";
const canonicalKey = "remote:ssh:canonical.example:22:dev:/srv/project";
const stableKey = "remote:server:3cd4f9da-cd79-426c-9d70-75f36e9f6a87:/srv/project";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function createFixture(mode: MigrationMode) {
  const root = await mkdtemp(join(tmpdir(), "zcode-offpeak-identity-"));
  const dbPath = join(root, "tasks-index.sqlite");
  const db = new DatabaseSync(dbPath);
  cleanup.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await runTasksDatabaseMigrations(db);
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_off_peak_bound_active'").get(),
  ).toBeDefined();
  const targetKey = mode === "controller" ? stableKey : canonicalKey;
  const insertTask = db.prepare(`INSERT INTO tasks (
    workspace_key, workspace_path, workspace_identity, task_id, created_at, updated_at
  ) VALUES (?, ?, ?, 'bound-session', 1, ?)`);
  insertTask.run(sourceKey, workspacePath, sourceKey, 10);
  insertTask.run(targetKey, workspacePath, targetKey, 20);
  const repo = new SourceServerWorkspaceAliasRepo({
    taskDbPath: dbPath,
    sessionDbPath: join(root, "missing.sqlite"),
    backupRoot: join(root, "backups"),
    now: () => 100,
  });
  return {
    db,
    targetKey,
    ledger:
      mode === "controller"
        ? "controller_remote_identity_migrations"
        : "workspace_migration_ledger",
    async migrate() {
      if (mode === "source") {
        const result = await repo.resolveCanonicalWorkspaceKey({
          workspacePath,
          legacyRouteHint: sourceKey,
        });
        expect(result.canonicalKey).toBe(targetKey);
      } else {
        const result = await migrateControllerRemoteWorkspaceIdentity({
          dbPath,
          oldWorkspaceKey: sourceKey,
          newWorkspaceKey: targetKey,
          now: () => 100,
        });
        if (result.status === "failed") throw new Error(result.error);
      }
    },
    insertOffPeak(id: string, key: string, session: string | null, status: string) {
      db.prepare(`INSERT INTO off_peak_tasks (
        off_peak_task_id, server_ticket_id, workspace_key, workspace_path, workspace_identity,
        session_id, conversation_id, prompt, permission_mode, status, queued_at,
        schedulable, queue_position, next_poll_at, claim_running, claimed_at,
        failure_reason, started_at, files_changed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 'default', ?, 1, 1, 2, 30, 1, 10,
        'previous attempt', 5, 3, 1, 10)`).run(
        id,
        `ticket-${id}`,
        key,
        workspacePath,
        key,
        session,
        session,
        status,
      );
    },
  };
}

describe.each<MigrationMode>(["controller", "source"])("%s off-peak identity migration", (mode) => {
  it.each(["queued", "paused", "running"])(
    "preserves the target and cancels only conflicting %s source rows before rekeying",
    async (status) => {
      const { db, targetKey, ledger, insertOffPeak, migrate } = await createFixture(mode);
      insertOffPeak("target-active", targetKey, "bound-session", status);
      insertOffPeak("source-conflict", sourceKey, "bound-session", status);
      for (const terminal of ["completed", "failed", "cancelled"]) {
        insertOffPeak(`source-${terminal}`, sourceKey, "bound-session", terminal);
        insertOffPeak(`target-${terminal}`, targetKey, terminal, terminal);
        insertOffPeak(`source-with-${terminal}-target`, sourceKey, terminal, status);
      }
      insertOffPeak("source-unbound", sourceKey, null, status);
      insertOffPeak("target-unbound", targetKey, null, "queued");
      insertOffPeak("source-other-session", sourceKey, "another-session", status);
      insertOffPeak("other-workspace", "/another-project", "bound-session", "queued");
      const list = db.prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id");
      const before = list.all();

      await migrate();

      const expected = before.map((row) => {
        if (row.workspace_key !== sourceKey) return row;
        const moved = { ...row, workspace_key: targetKey, workspace_identity: targetKey };
        return row.off_peak_task_id === "source-conflict"
          ? {
              ...moved,
              status: "cancelled",
              ended_at: 100,
              updated_at: 100,
              failure_reason: null,
              schedulable: 0,
              claim_running: 0,
              claimed_at: null,
            }
          : moved;
      });
      expect(list.all()).toEqual(expected);
      expect(db.prepare("SELECT workspace_key FROM tasks").all()).toEqual([
        { workspace_key: targetKey },
      ]);
      expect(db.prepare(`SELECT status FROM ${ledger}`).all()).toEqual([{ status: "completed" }]);

      await migrate();
      expect(list.all()).toEqual(expected);
      expect(db.prepare(`SELECT status FROM ${ledger}`).all()).toEqual([{ status: "completed" }]);
    },
  );

  it("rolls cancellation back with the rekey transaction and succeeds on retry", async () => {
    const { db, targetKey, ledger, insertOffPeak, migrate } = await createFixture(mode);
    insertOffPeak("source-conflict", sourceKey, "bound-session", "running");
    insertOffPeak("target-active", targetKey, "bound-session", "queued");
    const beforeOffPeak = db
      .prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id")
      .all();
    const beforeTasks = db.prepare("SELECT * FROM tasks ORDER BY workspace_key").all();
    db.exec(`CREATE TRIGGER fail_off_peak_rekey BEFORE UPDATE OF workspace_key ON off_peak_tasks
      WHEN OLD.off_peak_task_id = 'source-conflict'
      BEGIN SELECT RAISE(ABORT, 'injected rekey failure'); END;`);

    await expect(migrate()).rejects.toThrow("injected rekey failure");
    expect(db.prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id").all()).toEqual(
      beforeOffPeak,
    );
    expect(db.prepare("SELECT * FROM tasks ORDER BY workspace_key").all()).toEqual(beforeTasks);
    expect(db.prepare(`SELECT status FROM ${ledger}`).all()).toEqual([{ status: "failed" }]);

    db.exec("DROP TRIGGER fail_off_peak_rekey");
    await migrate();
    expect(
      db
        .prepare("SELECT status, workspace_key FROM off_peak_tasks WHERE off_peak_task_id = ?")
        .get("source-conflict"),
    ).toEqual({ status: "cancelled", workspace_key: targetKey });
    expect(
      db.prepare(`SELECT status FROM ${ledger} WHERE status = 'completed'`).all(),
    ).toHaveLength(1);
  });
});

it("keeps the first merged variant active when canonical has no binding for that session", async () => {
  const { db, targetKey, insertOffPeak, migrate } = await createFixture("source");
  const laterKey = "remote:ssh:z-later.example:22:dev:/srv/project";
  insertOffPeak("first-variant", sourceKey, "bound-session", "queued");
  insertOffPeak("later-variant", laterKey, "bound-session", "running");

  await migrate();

  expect(
    db
      .prepare(
        "SELECT off_peak_task_id, workspace_key, status FROM off_peak_tasks ORDER BY off_peak_task_id",
      )
      .all(),
  ).toEqual([
    { off_peak_task_id: "first-variant", workspace_key: targetKey, status: "queued" },
    { off_peak_task_id: "later-variant", workspace_key: targetKey, status: "cancelled" },
  ]);
});
