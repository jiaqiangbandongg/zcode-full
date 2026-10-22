import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";
describe("project repository contract", () => {
  it("rejects a foreign task directory read even when the row and its project agree", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:s','server')");
    const foreign = port.repository(db, "remote:server:s");
    const project = foreign.saveProject({ roots: ["/remote"] });
    const task = {
      taskId: "remote-task",
      workspacePath: "/remote",
      workspaceIdentity: "remote:server:s:/remote",
    };
    foreign.reserveCreatedTask({ task, projectId: project.id });
    expect(() => port.repository(db).resolveSessionDirectories(task)).toThrow(
      "project.host-mismatch",
    );
    expect(foreign.resolveSessionDirectories(task).additionalDirectories).toEqual([]);
  });
  it("reserves frozen scheduled execution after roots change while enforcing host ownership", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/old", "/extra"] });
    repo.saveProject({ id: project.id, roots: ["/new"] });
    repo.deleteProject(project.id);
    const task = { workspacePath: "/old", taskId: "scheduled" };
    expect(
      repo.reserveCreatedTask({ task, projectId: project.id, additionalDirectories: ["/extra"] }),
    ).toEqual({ workspacePath: "/old", projectId: project.id, additionalDirectories: ["/extra"] });
    expect(() =>
      repo.reserveCreatedTask({
        task: { workspacePath: "/old", taskId: "ordinary" },
        projectId: project.id,
      }),
    ).toThrow("project.deleted");
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:other','server')");
    expect(repo.resolveSessionDirectories(task).additionalDirectories).toEqual(["/extra"]);
    // 定义可删除，生成的 session 仍要保留自己的不可变执行配置。
    db.exec("DELETE FROM automations; DELETE FROM off_peak_tasks");
    expect(port.repository(db).resolveSessionDirectories(task).additionalDirectories).toEqual([
      "/extra",
    ]);
    repo.reserveCreatedTask({ task, projectId: null, additionalDirectories: [] });
    expect(repo.resolveSessionDirectories(task).additionalDirectories).toEqual(["/extra"]);
    const foreign = port.repository(db, "remote:server:other").saveProject({ roots: ["/old"] });
    expect(() =>
      repo.reserveCreatedTask({
        task: { ...task, taskId: "cross" },
        projectId: foreign.id,
        additionalDirectories: [],
      }),
    ).toThrow("project.cross-host-move");
  });
  it("does not revive persisted running status or stale JSON identity in a cold project tree", async () => {
    const { db, add, context } = await fixture();
    add("cold", "/repo");
    db.exec(`ALTER TABLE tasks ADD COLUMN meta_json TEXT;
      UPDATE tasks SET task_status='running',meta_json='{"status":"running","workspaceIdentity":"remote:stale"}'`);
    await port.migrate(db, context);
    const row = port.repository(db).readTree().tasks[0]!;
    expect(row.status).toBeUndefined();
    expect(row.workspaceIdentity).toBeUndefined();
  });
  it("uses the owning Source Server identity across historical canonical route aliases", async () => {
    const { db, add, context } = await fixture();
    const hostId = "remote:server:stable-source";
    add("a", "/repo", "remote:ssh:old-address:22:user:/repo");
    add("b", "/other", "remote:ssh:new-address:22:user:/other");
    await port.migrate(db, { ...context, hostId });
    const repo = port.repository(db, hostId);
    expect(repo.readTree().tasks.map((task) => task.hostId)).toEqual([hostId, hostId]);
    const project = repo.saveProject({ roots: ["/repo"] });
    expect(project.hostId).toBe(hostId);
    repo.moveTask({
      task: {
        taskId: "a",
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:old-address:22:user:/repo",
      },
      projectId: project.id,
    });
    expect(
      repo.reserveCreatedTask({
        task: {
          taskId: "new",
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:new-address:22:user:/repo",
        },
        projectId: project.id,
      }).additionalDirectories,
    ).toEqual([]);
  });

  it("pins without overwriting concurrently edited roots or default name ownership", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const created = repo.saveProject({ roots: ["/a"] });
    repo.saveProject({ id: created.id, roots: ["/a", "/b"] });
    const pinned = repo.saveProject({ id: created.id, pinned: true });
    expect(pinned.roots.map((root) => root.rootPath)).toEqual(["/a", "/b"]);
    expect(pinned.nameOverridden).toBe(false);
    expect(pinned.pinned).toBe(true);
  });

  it("archives every inactive task purely by CLI activity time, sparing only pinned and running ones", async () => {
    const { db, add, context } = await fixture();
    for (const id of [
      "stale",
      "pinned",
      "unread",
      "running",
      "recent",
      "failed",
      "unknown",
      "nofacts",
    ])
      add(id, `/outside/${id}`);
    await port.migrate(db, context);
    // 2026-09-15 裁决：未读、error、无结果的旧任务同样归档；只有置顶、运行中、最近活动与无 CLI 事实的行例外。
    db.exec(`UPDATE tasks SET project_id=NULL,cli_updated_at=10,cli_last_outcome='completed';
      UPDATE tasks SET pinned=1 WHERE task_id='pinned';
      UPDATE tasks SET unread_at=20 WHERE task_id='unread';
      UPDATE tasks SET cli_updated_at=200 WHERE task_id='recent';
      UPDATE tasks SET cli_last_outcome='error' WHERE task_id='failed';
      UPDATE tasks SET cli_last_outcome=NULL WHERE task_id='unknown';
      UPDATE tasks SET cli_updated_at=NULL,cli_last_outcome=NULL WHERE task_id='nofacts'`);
    const repo = port.repository(db);
    expect(
      repo
        .archiveInactive({
          cutoff: 100,
          activeTasks: [{ workspacePath: "/outside/running", taskId: "running" }],
        })
        .map((task) => task.taskId)
        .sort(),
    ).toEqual(["failed", "stale", "unknown", "unread"]);
    expect(
      db
        .prepare("SELECT task_id FROM tasks WHERE archived=1 ORDER BY task_id")
        .all()
        .map((row) => row.task_id),
    ).toEqual(["failed", "stale", "unknown", "unread"]);
    expect(db.prepare("SELECT unread_at FROM tasks WHERE task_id='unread'").get()).toEqual({
      unread_at: 20,
    });
    expect(
      db
        .prepare("SELECT project_id,cli_updated_at,updated_at FROM tasks WHERE task_id='stale'")
        .get(),
    ).toEqual({ project_id: null, cli_updated_at: 10, updated_at: 2 });
    expect(
      repo.archiveInactive({
        cutoff: 100,
        activeTasks: [{ workspacePath: "/outside/running", taskId: "running" }],
      }),
    ).toEqual([]);
  });

  it("reserves creation before facts, keeps explicit NULL and never overwrites a later move on retry", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const a = repo.saveProject({ roots: ["/a", "/b"] });
    const b = repo.saveProject({ roots: ["/a", "/c"] });
    const task = { workspacePath: "/a", taskId: "reserved" };
    expect(repo.reserveCreatedTask({ task, projectId: a.id })).toEqual({
      projectId: a.id,
      workspacePath: "/a",
      additionalDirectories: ["/b"],
    });
    expect(repo.readTree().tasks).toEqual([]);
    repo.moveTask({ task, projectId: b.id });
    expect(repo.reserveCreatedTask({ task, projectId: a.id }).additionalDirectories).toEqual([
      "/c",
    ]);
    const global = { workspacePath: "/a", taskId: "global" };
    repo.reserveCreatedTask({ task: global, projectId: null });
    await port.migrate(db, context);
    expect(repo.resolveSessionDirectories(global)).toEqual({
      workspacePath: "/a",
      projectId: null,
      additionalDirectories: [],
    });
    expect(
      db
        .prepare(
          "SELECT cli_created_at,created_at,handoff_pending FROM tasks WHERE task_id='global'",
        )
        .get(),
    ).toEqual({ cli_created_at: null, created_at: 0, handoff_pending: 8 });
    expect(() =>
      repo.reserveCreatedTask({
        task: { workspacePath: "/foreign", taskId: "bad" },
        projectId: a.id,
      }),
    ).toThrow("project.cwd-not-in-roots");
    expect(db.prepare("SELECT 1 FROM tasks WHERE task_id='bad'").get()).toBeUndefined();
  });

  it("initializes an empty project once without replacing roots supplied by another writer", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: [] });
    expect(repo.initializeProjectRoot(project.id, "/generated").roots).toEqual([
      { rootPath: "/generated", position: 0, isPrimary: true },
    ]);
    repo.saveProject({ id: project.id, roots: ["/chosen"] });
    expect(repo.initializeProjectRoot(project.id, "/late").roots).toEqual([
      { rootPath: "/chosen", position: 0, isPrimary: true },
    ]);
    repo.deleteProject(project.id);
    expect(() => repo.initializeProjectRoot(project.id, "/late")).toThrow("project.deleted");
  });

  it("moves only organization, requires a missing-root acknowledgement and rejects cross-host moves", async () => {
    const { db, add, context } = await fixture();
    add("s", "/a");
    await port.migrate(db, context);
    const repo = port.repository(db);
    const target = repo.saveProject({ roots: ["/b"], name: "Target" });
    const task = { workspacePath: "/a", taskId: "s" };
    expect(() => repo.moveTask({ task, projectId: target.id })).toThrow(
      "project.root-confirmation-required",
    );
    repo.moveTask({ task, projectId: target.id, addMissingRoot: true });
    expect(repo.resolveSessionDirectories(task)).toEqual({
      projectId: target.id,
      workspacePath: "/a",
      additionalDirectories: ["/b"],
    });
    expect(db.prepare("SELECT workspace_path,cli_updated_at FROM tasks").get()).toEqual({
      workspace_path: "/a",
      cli_updated_at: 2,
    });
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:ssh:x:22:u','ssh')");
    expect(() => repo.saveProject({ hostId: "remote:ssh:x:22:u", roots: ["/a"] })).toThrow(
      "project.host-immutable",
    );
    const remote = port.repository(db, "remote:ssh:x:22:u").saveProject({ roots: ["/a"] });
    expect(() => repo.moveTask({ task, projectId: remote.id, addMissingRoot: true })).toThrow(
      "project.cross-host-move",
    );
  });
  it("keeps roots and task ownership after delete, and restores only an explicit matching project", async () => {
    const { db, add, context } = await fixture(["/a"]);
    add("s", "/a");
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.readTree().projects[0]!;
    repo.saveProject({ id: project.id, roots: ["/a", "/b"], primaryRoot: "/b" });
    repo.deleteProject(project.id);
    repo.deleteProject(project.id);
    expect(repo.readTree().projects).toEqual([]);
    expect(repo.readTree().tasks[0]?.projectId).toBe(project.id);
    expect(
      repo.resolveSessionDirectories({ workspacePath: "/a", taskId: "s" }).additionalDirectories,
    ).toEqual(["/b"]);
    expect(() => repo.saveProject({ restoreProjectId: project.id, roots: ["/a"] })).toThrow(
      "project.restore-roots-mismatch",
    );
    const restored = repo.saveProject({
      restoreProjectId: project.id,
      roots: ["/b", "/a"],
      name: "Restored",
      primaryRoot: "/a",
    });
    expect(restored).toMatchObject({ id: project.id, name: "Restored", deleted: false });
  });
  it("resolves exact task ownership for overlapping projects, preserves NULL and reports broken references", async () => {
    const { db, add, context } = await fixture(["/a"]);
    add("s", "/a");
    await port.migrate(db, context);
    const repo = port.repository(db);
    const first = repo.readTree().projects[0]!;
    repo.saveProject({ id: first.id, roots: ["/a", "/b"] });
    repo.saveProject({ roots: ["/a", "/c"] });
    expect(
      repo.resolveSessionDirectories({ workspacePath: "/a", taskId: "s" }).additionalDirectories,
    ).toEqual(["/b"]);
    expect(repo.resolveSessionDirectories({ workspacePath: "/a", taskId: "TUI-new" })).toEqual({
      projectId: null,
      workspacePath: "/a",
      additionalDirectories: [],
    });
    db.exec("UPDATE tasks SET project_id=NULL");
    expect(
      repo.resolveSessionDirectories({ workspacePath: "/a", taskId: "s" }).additionalDirectories,
    ).toEqual([]);
    db.exec("UPDATE tasks SET project_id='missing'");
    expect(() => repo.resolveSessionDirectories({ workspacePath: "/a", taskId: "s" })).toThrow(
      "project.not-found",
    );
  });
});
