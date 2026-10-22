import { createHash } from "node:crypto";
import { PROJECT_MIGRATION_TABLES } from "#src/project-storage/schema.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

function tableHashes(db: DatabaseSync) {
  return new Map(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migration'",
      )
      .all()
      .map(({ name }) => {
        const rows = db
          .prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return [String(name), createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
      }),
  );
}

describe("project-storage migration contract", () => {
  it("preserves every legacy group without converting archived members into projects", async () => {
    const { db, add, context } = await fixture();
    add("deleted", "/gone");
    add("archived", "/kept");
    db.exec(`UPDATE tasks SET deleted=1 WHERE task_id='deleted';
      UPDATE tasks SET archived=1 WHERE task_id='archived';
      INSERT INTO task_groups VALUES ('empty','Empty',NULL,1,1),
        ('dangling','Dangling',NULL,1,1),('deleted','Deleted',NULL,1,1),
        ('archived','Archived',NULL,1,1);
      INSERT INTO task_group_members VALUES ('dangling','/missing','/missing',NULL,'missing',0),
        ('deleted','/gone','/gone',NULL,'deleted',0),
        ('archived','/kept','/kept',NULL,'archived',0);`);
    await port.migrate(db, context);
    expect(db.prepare("SELECT name FROM projects WHERE name_overridden=1").all()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM task_groups").get()?.n).toBe(4);
    expect(db.prepare("SELECT count(*) AS n FROM task_group_members").get()?.n).toBe(3);
    expect(await port.migrate(db, context)).toMatchObject({ applied: [] });
  });
  it("imports retained connection profiles once and binds legacy entries to a known Source", async () => {
    const { db, context } = await fixture();
    const target = { kind: "ssh" as const, host: "example.test", username: "user", port: 22 };
    const settings = {
      recentProjects: [],
      sourceServers: [
        {
          sourceServerId: "known",
          displayName: "Known",
          preferredProfileId: "profile",
          installState: "installed" as const,
          declaredWorkspaces: [],
        },
      ],
      connectionProfiles: [
        {
          profileId: "profile",
          lifecycleState: "active" as const,
          transport: "ssh" as const,
          sourceServerId: "known",
          target,
          createdAt: 1,
        },
      ],
      lastWorkspaceSession: [
        {
          kind: "remote" as const,
          workspacePurpose: "project" as const,
          workspacePath: "/repo",
          target,
          lastOpenedAt: 1,
          lastConnectionStatus: "connected" as const,
        },
      ],
    };
    await port.migrate(db, { ...context, settings });
    const host = db
      .prepare("SELECT host_id,membership_id FROM hosts WHERE target_json IS NOT NULL")
      .all();
    expect(host).toEqual([{ host_id: "remote:server:known", membership_id: expect.any(String) }]);
    expect(
      db.prepare("SELECT host_id,remote_project_id FROM remote_project_entries").get(),
    ).toEqual({ host_id: "remote:server:known", remote_project_id: null });
    db.exec("DELETE FROM remote_project_entries; DELETE FROM hosts WHERE host_id<>'local'");
    await port.migrate(db, { ...context, settings });
    expect(db.prepare("SELECT * FROM remote_project_entries").all()).toEqual([]);
    expect(db.prepare("SELECT host_id FROM hosts WHERE target_json IS NOT NULL").all()).toEqual([]);
  });
  it("adopts the old project migration id without recreating user-edited project ownership", async () => {
    const { db, add, context } = await fixture(["/work/a"]);
    add("s", "/work/a");
    await port.migrate(db, context);
    db.exec(
      "UPDATE schema_migration SET id='0001_projects' WHERE id='0005_projects'; UPDATE projects SET name='Edited'; UPDATE tasks SET project_id=NULL",
    );
    const before = tableHashes(db);
    expect((await port.migrate(db, context)).applied).toEqual([]);
    expect(tableHashes(db)).toEqual(before);
    expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "Edited" }]);
    expect(db.prepare("SELECT project_id FROM tasks").get()?.project_id).toBeNull();
    expect(db.prepare("SELECT id FROM schema_migration ORDER BY id").all()).toEqual([
      { id: "0001_projects" },
      { id: "0005_projects" },
      { id: "0006_default_workspace_tasks" },
      { id: "0007_initial_workspace_order" },
    ]);
  });

  it("runs after upstream task migrations and preserves old columns and unrelated data", async () => {
    const { db, add, context } = await fixture(["/work/a"]);
    add("s", "/work/a");
    db.exec(
      "UPDATE tasks SET deleted=1,title_overridden=1; INSERT INTO automations VALUES ('a','/work/a','/work/a')",
    );
    const before = tableHashes(db);
    const result = await port.migrate(db, context);
    const after = tableHashes(db);
    const changes = [...new Set([...before.keys(), ...after.keys()])].filter(
      (table) => before.get(table) !== after.get(table),
    );
    expect(
      changes.filter((table) => !(PROJECT_MIGRATION_TABLES as readonly string[]).includes(table)),
    ).toEqual([]);
    expect(result.applied).toEqual([
      "0005_projects",
      "0006_default_workspace_tasks",
      "0007_initial_workspace_order",
    ]);
    expect(
      db.prepare("SELECT id,checksum FROM schema_migration WHERE id='0005_projects'").all(),
    ).toEqual([
      {
        id: "0005_projects",
        // 只改 ID；历史 SQL（含注释）仍是原 checksum 输入，不能跟随名称一起改。
        checksum: "ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da",
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT host_id,root_path,cli_title,cli_updated_at,cli_deleted,handoff_pending FROM tasks",
        )
        .get(),
    ).toMatchObject({
      host_id: "local",
      root_path: "/work/a",
      cli_title: "title s",
      cli_updated_at: 2,
      cli_deleted: 0,
      handoff_pending: 11,
    });
    const project = db.prepare("SELECT project_id,name FROM projects").get();
    expect(project?.name).toBe("a");
    expect(
      db.prepare("SELECT additional_directories FROM automations").get()?.additional_directories,
    ).toBe("[]");
    expect(db.prepare("SELECT project_id FROM automations").get()?.project_id).toBe(
      project?.project_id,
    );
    expect(db.prepare("SELECT title,updated_at,deleted FROM tasks").get()).toEqual({
      title: "title s",
      updated_at: 2,
      deleted: 1,
    });
    expect(db.prepare("SELECT * FROM untouched").all()).toEqual([
      { id: "keep", value: "unchanged" },
    ]);
    expect((await port.migrate(db, context)).applied).toEqual([]);
  });

  it("preserves mixed host membership and assigns projects only from workspaces", async () => {
    const { db, add, context } = await fixture(["/one/repo", "/two/repo"]);
    add("a", "/one/repo");
    add("b", "/two/repo");
    const remote = "remote:ssh:example.test:22:user:/three/repo";
    add("c", "/three/repo", remote);
    db.exec(`INSERT INTO task_groups VALUES ('manual','Work','blue',1,2),('bootstrap','Repo','red',1,2);
      INSERT INTO task_group_workspace_bootstraps VALUES('/one/repo','bootstrap');
      INSERT INTO task_group_members VALUES('manual','/two/repo','/two/repo',NULL,'b',0),('manual','${remote}','/three/repo','${remote}','c',1),('bootstrap','/one/repo','/one/repo',NULL,'a',0);`);
    await port.migrate(db, context);
    const tasks = db
      .prepare(
        "SELECT t.task_id,p.name,p.host_id FROM tasks t JOIN projects p USING(project_id) ORDER BY t.task_id",
      )
      .all();
    expect(tasks[0]).toMatchObject({ task_id: "a", name: "repo", host_id: "local" });
    expect(tasks[1]?.name).toBe("repo (2)");
    expect(db.prepare("SELECT count(*) AS n FROM projects WHERE name_overridden=1").get()?.n).toBe(
      0,
    );
    expect(tasks).toHaveLength(2);
    expect(
      db.prepare("SELECT project_id FROM tasks WHERE task_id='c'").get()?.project_id,
    ).toBeNull();
    expect(
      db.prepare("SELECT count(*) AS n FROM task_group_members WHERE task_id='c'").get()?.n,
    ).toBe(1);
    expect(
      port
        .repository(db)
        .readTree()
        .tasks.map((task) => task.taskId),
    ).not.toContain("c");
    expect(db.prepare("SELECT count(*) AS n FROM task_groups").get()?.n).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM projects WHERE name='Repo'").get()?.n).toBe(0);
  });

  it("hands off downgrade edits and assigns old new rows once, never reassigning processed NULL", async () => {
    const { db, add, context } = await fixture(["/work/a"]);
    add("original", "/work/a");
    await port.migrate(db, context);
    db.exec("UPDATE tasks SET deleted=1,title='downgrade title',title_overridden=1");
    add("discovered", "/work/a");
    add("unclassified", "/work/other");
    await port.migrate(db, context);
    expect(
      db.prepare("SELECT handoff_pending FROM tasks WHERE task_id='original'").get()
        ?.handoff_pending,
    ).toBe(11);
    expect(
      db.prepare("SELECT project_id FROM tasks WHERE task_id='discovered'").get()?.project_id,
    ).not.toBeNull();
    db.exec(
      "UPDATE tasks SET project_id=NULL WHERE task_id='discovered'; UPDATE project_roots SET root_path='/work/other'",
    );
    await port.migrate(db, context);
    expect(
      db
        .prepare("SELECT project_id FROM tasks WHERE task_id IN ('discovered','unclassified')")
        .all(),
    ).toEqual([{ project_id: null }, { project_id: null }]);
  });

  it("does not use primary root as a tiebreaker for first discovery", async () => {
    const { db, add, context } = await fixture(["/a", "/b"]);
    add("a", "/a");
    add("b", "/b");
    await port.migrate(db, context);
    db.exec("INSERT INTO project_roots SELECT project_id,'/shared',1,0 FROM projects");
    add("new", "/shared");
    await port.migrate(db, context);
    expect(
      db.prepare("SELECT project_id,handoff_pending FROM tasks WHERE task_id='new'").get(),
    ).toEqual({ project_id: null, handoff_pending: 8 });
  });

  it("imports remote entries only once and never creates remote authoritative projects from settings", async () => {
    const { db, context } = await fixture();
    const settings = {
      recentProjects: [],
      lastWorkspaceSession: [
        {
          kind: "remote" as const,
          workspacePurpose: "project" as const,
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:example.test:22:user:/repo",
          target: { kind: "ssh" as const, host: "example.test", username: "user", port: 22 },
          lastOpenedAt: 1,
          lastConnectionStatus: "failed" as const,
        },
      ],
    };
    await port.migrate(db, { ...context, settings });
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM remote_project_entries").get()?.n).toBe(1);
    db.exec("DELETE FROM remote_project_entries");
    await port.migrate(db, { ...context, settings });
    await port.migrate(db, context);
    expect(db.prepare("SELECT count(*) AS n FROM remote_project_entries").get()?.n).toBe(0);
  });
});

it("returns explicit deleted references separately from the visible rows", async () => {
  const { db, add, context } = await fixture();
  add("deleted", "/gone");
  db.exec("UPDATE tasks SET deleted=1");
  await port.migrate(db, context);
  const repo = port.repository(db);
  expect(repo.readTree().deletedTasks).toBeUndefined();
  expect(
    repo.readTree({ includeDeletedTasks: true }).deletedTasks?.map((row) => row.taskId),
  ).toEqual(["deleted"]);
});
