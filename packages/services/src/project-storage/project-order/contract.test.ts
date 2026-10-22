import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

describe("new project ordering", () => {
  it.each(["local", "remote:server:source"])(
    "prepends new projects on %s while preserving existing and manually reordered positions",
    async (hostId) => {
      const { db, context } = await fixture();
      await port.migrate(db, { ...context, hostId });
      const repo = port.repository(db, hostId);
      const first = repo.saveProject({
        name: "First",
        roots: hostId === "local" ? [] : ["/first"],
      });
      const second = repo.saveProject({ roots: ["/second"] });
      expect(first.position).toBe(0);
      expect(repo.readTree().projects.map((project) => project.id)).toEqual([second.id, first.id]);
      repo.reorderProjects([first.id, second.id]);
      const before = repo.readTree().projects;
      const third = repo.saveProject({
        name: "Third",
        roots: hostId === "local" ? [] : ["/third"],
      });
      expect(repo.readTree().projects.map((project) => project.id)).toEqual([
        third.id,
        first.id,
        second.id,
      ]);
      expect(repo.readTree().projects.slice(1)).toEqual(before);
      expect(port.repository(db, hostId).readTree().projects[0]?.id).toBe(third.id);
    },
  );

  it("keeps existing positions when editing or restoring and allocates independently for each Host", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const first = repo.saveProject({ name: "First" });
    const second = repo.saveProject({ name: "Second" });
    const third = repo.saveProject({ name: "Third" });
    expect(repo.saveProject({ id: first.id, name: "Renamed", pinned: true }).position).toBe(
      first.position,
    );
    repo.deleteProject(second.id);
    expect(repo.saveProject({ restoreProjectId: second.id, roots: [] }).position).toBe(
      second.position,
    );
    expect(repo.readTree().projects.map((project) => project.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:other','server')");
    const remote = port.repository(db, "remote:server:other");
    const remoteFirst = remote.saveProject({ name: "Remote first", roots: ["/first"] });
    const remoteSecond = remote.saveProject({ name: "Remote second", roots: ["/second"] });
    expect(remoteFirst.position).toBe(0);
    expect(remoteSecond.position).toBeLessThan(remoteFirst.position);
    expect(repo.readTree().projects.map((project) => project.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });
});
