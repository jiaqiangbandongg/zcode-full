import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";
import { migrateProjects } from "#src/project-storage/migrate-projects.js";

describe("project-storage migration order", () => {
  const mixedSettings = {
    recentProjects: [],
    lastWorkspaceSession: [
      { kind: "local" as const, workspacePath: "/a" },
      {
        kind: "remote" as const,
        workspacePath: "/a",
        target: { kind: "ssh" as const, host: "example.test", username: "dev", port: 22 },
        lastOpenedAt: 1,
        lastConnectionStatus: "failed" as const,
      },
      { kind: "local" as const, workspacePath: "/b" },
    ],
  };
  it("首次升级保留本地/remote 混排位置，重启不覆盖已调整的顺序", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, { ...context, settings: mixedSettings });
    expect(
      port
        .repository(db)
        .readTree()
        .projects.map((p) => [p.name, p.position]),
    ).toEqual([
      ["a", 0],
      ["b", 2],
    ]);
    expect(db.prepare("SELECT initial_position FROM remote_project_entries").get()).toMatchObject({
      initial_position: 1,
    });
    db.exec("UPDATE projects SET position=10-position");
    const before = db.prepare("SELECT * FROM projects ORDER BY project_id").all();
    await port.migrate(db, {
      ...context,
      settings: {
        ...mixedSettings,
        lastWorkspaceSession: [...mixedSettings.lastWorkspaceSession].reverse(),
      },
    });
    expect(db.prepare("SELECT * FROM projects ORDER BY project_id").all()).toEqual(before);
    expect(db.prepare("SELECT initial_position FROM remote_project_entries").get()).toMatchObject({
      initial_position: 1,
    });
  });
  it.each(["0005_projects", "0001_projects"])(
    "已升级 ledger %s 不补混排位置或覆盖项目",
    async (id) => {
      const { db, context } = await fixture();
      migrateProjects(db, { ...context, settings: mixedSettings });
      db.exec(
        "CREATE TABLE schema_migration(id TEXT PRIMARY KEY,checksum TEXT,app_version TEXT,applied_at INTEGER)",
      );
      db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
        id,
        "ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da",
        "3.16.1",
        10,
      );
      db.exec("UPDATE projects SET position=10-position,name='edited-'||name");
      const before = db.prepare("SELECT * FROM projects ORDER BY project_id").all();
      await port.migrate(db, { ...context, settings: mixedSettings });
      expect(db.prepare("SELECT * FROM projects ORDER BY project_id").all()).toEqual(before);
      expect(db.prepare("SELECT initial_position FROM remote_project_entries").get()).toEqual({
        initial_position: null,
      });
    },
  );
  it.each([undefined, "remote:server:owner"])(
    "creates saved projects in order (remote owner also infers history roots) for owner %s",
    async (hostId) => {
      const { db, add, context } = await fixture();
      for (const path of ["/a-history", "/b-saved", "/z-saved", "/conversation"]) add(path, path);
      add("archived", "/archived-only");
      add("deleted", "/deleted-only");
      db.exec(
        "UPDATE tasks SET archived=1,pinned=1,unread_at=7 WHERE task_id='archived'; UPDATE tasks SET deleted=1 WHERE task_id='deleted'",
      );
      const historicalFacts = () =>
        db
          .prepare(
            "SELECT workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at,archived,deleted,pinned,unread_at FROM tasks ORDER BY task_id",
          )
          .all();
      const beforeFacts = historicalFacts();
      db.exec(`INSERT INTO task_groups VALUES ('manual','Manual',NULL,1,1);
        INSERT INTO task_group_members VALUES ('manual','/a-history','/a-history',NULL,'/a-history',0);`);
      const settings = {
        recentProjects: ["/recent-only", "/a-history", "/b-saved"],
        lastWorkspaceSession: [
          {
            kind: "local" as const,
            workspacePath: "/z-saved",
            workspacePurpose: "project" as const,
          },
          {
            kind: "local" as const,
            workspacePath: "/conversation",
            workspacePurpose: "conversation" as const,
          },
          {
            kind: "local" as const,
            workspacePath: "/empty-saved",
            workspacePurpose: "project" as const,
          },
          { kind: "local" as const, workspacePath: "/b-saved" },
          {
            kind: "local" as const,
            workspacePath: "/z-saved",
            workspacePurpose: "project" as const,
          },
          {
            kind: "remote" as const,
            workspacePath: "/foreign",
            workspacePurpose: "project" as const,
            target: { kind: "ssh" as const, host: "example.test", username: "user", port: 22 },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected" as const,
          },
        ],
      };
      const owner = { ...context, hostId, settings };
      await port.migrate(db, owner);
      const repo = port.repository(db, hostId);
      const projects = repo.readTree().projects;
      const inferred = (root: string) =>
        hostId ? projects.find((project) => project.roots[0]?.rootPath === root)!.id : null;
      expect(
        projects.map(({ name, position, hostId: actualHost }) => [name, position, actualHost]),
      ).toEqual(
        [
          "z-saved",
          "empty-saved",
          "b-saved",
          // 远端自身没有旧 workspace 清单，按历史任务目录补建；conversation 与仅已删除目录除外。
          ...(hostId ? ["a-history", "archived-only"] : []),
        ].map((name, position) => [name, position, hostId ?? "local"]),
      );
      expect(db.prepare("SELECT count(*) AS n FROM remote_project_entries").get()?.n).toBe(
        hostId ? 0 : 1,
      );
      expect(historicalFacts()).toEqual(beforeFacts);
      expect(
        db
          .prepare(
            "SELECT task_id,project_id,handoff_pending FROM tasks WHERE workspace_path IN ('/a-history','/conversation','/archived-only','/deleted-only') ORDER BY task_id",
          )
          .all(),
      ).toEqual([
        { task_id: "/a-history", project_id: inferred("/a-history"), handoff_pending: 8 },
        { task_id: "/conversation", project_id: null, handoff_pending: 8 },
        { task_id: "archived", project_id: inferred("/archived-only"), handoff_pending: 8 },
        { task_id: "deleted", project_id: null, handoff_pending: 9 },
      ]);
      for (const path of ["/z-saved", "/b-saved"]) {
        expect(
          db.prepare("SELECT project_id FROM tasks WHERE workspace_path=?").get(path)?.project_id,
        ).toBe(projects.find((project) => project.roots[0]?.rootPath === path)?.id);
      }
      expect(repo.readTree().tasks.map((task) => task.taskId)).toContain("/a-history");
      expect(repo.readTree().tasks.map((task) => task.taskId)).not.toContain("deleted");
      // 已升级的项目不能按旧 settings 清理；同目录新建项目也不能重新归入已处理的历史任务。
      const existing = repo.saveProject({ roots: ["/a-history"], name: "User project" });
      const reordered = [existing.id, ...projects.map((project) => project.id).reverse()];
      repo.reorderProjects(reordered);
      // 核对持久行；旧 fixture 未保存 traceId，readTree 会生成临时 traceId，不能当作迁移写入。
      const persisted = () =>
        ["projects", "project_roots", "tasks"].map((table) =>
          db.prepare(`SELECT * FROM ${table}`).all(),
        );
      const before = persisted();
      expect((await port.migrate(db, owner)).applied).toEqual([]);
      expect(repo.readTree().projects.map((project) => project.id)).toEqual(reordered);
      expect(persisted()).toEqual(before);
    },
  );

  it.each([undefined, { lastWorkspaceSession: [], recentProjects: ["/a"] }])(
    "does not infer projects from history when settings are %j",
    async (settings) => {
      const { db, add, context } = await fixture();
      for (const path of ["/z", "/a", "/m"]) add(path, path);
      await port.migrate(db, { ...context, settings });
      const tree = port.repository(db).readTree();
      expect(tree.projects).toEqual([]);
      expect(tree.tasks).toHaveLength(3);
      expect(tree.tasks.every((task) => task.projectId === null)).toBe(true);
    },
  );
});
