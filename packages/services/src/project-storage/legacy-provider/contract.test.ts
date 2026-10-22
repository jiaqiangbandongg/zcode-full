import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

describe("legacy provider visibility", () => {
  it.each([
    ["local", false],
    ["local", true],
    ["remote:server:source", false],
    ["remote:server:source", true],
  ] as const)(
    "filters legacy backends on %s with existing ledger=%s without changing rows",
    async (hostId, migrated) => {
      const { db, add, context } = await fixture(["/repo"]);
      const migration = { ...context, hostId };
      if (migrated) await port.migrate(db, migration);
      db.exec(
        "ALTER TABLE tasks ADD COLUMN migration_source TEXT; ALTER TABLE tasks ADD COLUMN meta_json TEXT",
      );
      for (const provider of ["glm", "claude", "gemini", "zcode", null]) {
        for (const state of ["active", "pinned", "archived"]) {
          const id = `${provider}-${state}`;
          add(id, "/repo");
          db.prepare(
            "UPDATE tasks SET provider=?,pinned=?,archived=?,unread_at=7,created_at=10,updated_at=20 WHERE task_id=?",
          ).run(provider, Number(state === "pinned"), Number(state === "archived"), id);
        }
      }
      add("current-import", "/unopened");
      db.exec("UPDATE tasks SET migration_source='claudeCode' WHERE task_id='current-import'");
      if (migrated) {
        db.prepare(`UPDATE tasks SET host_id=?,root_path=workspace_path,
        cli_created_at=created_at,cli_updated_at=updated_at,cli_title=title,cli_deleted=0`).run(
          hostId,
        );
      }
      await port.migrate(db, migration);
      const stored = db.prepare("SELECT * FROM tasks ORDER BY task_id").all();
      const repository = port.repository(db, hostId);
      expect(
        repository
          .readTree()
          .tasks.map((task) => task.taskId)
          .sort(),
      ).toEqual(["current-import", "glm-active", "glm-archived", "glm-pinned"]);
      expect(repository.readTree().tasks.every((task) => task.hostId === hostId)).toBe(true);
      const tree = repository.readTree();
      const importedProjectId = tree.tasks.find(
        (task) => task.taskId === "current-import",
      )?.projectId;
      if (hostId !== "local" && !migrated) {
        // 远端首次迁移按历史目录建项目；已有迁移 ledger 的库不补跑，本地仍按旧清单归属。
        // 依据：docs/superpowers/specs/2026-09-09-virtual-project-design.md
        // 顶部「2026-10-15 裁决补充」及 F8 远端例外；本用例只校验既定归属，不修改迁移。
        const project = tree.projects.find(
          (entry) =>
            entry.hostId === hostId && entry.roots.some((root) => root.rootPath === "/unopened"),
        );
        expect(project).toMatchObject({
          hostId,
          roots: [{ rootPath: "/unopened", isPrimary: true }],
        });
        expect(importedProjectId).toBe(project!.id);
      } else {
        expect(importedProjectId).toBeNull();
      }
      expect((await port.migrate(db, migration)).applied).toEqual([]);
      expect(db.prepare("SELECT * FROM tasks ORDER BY task_id").all()).toEqual(stored);
    },
  );
});
