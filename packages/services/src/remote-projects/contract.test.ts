import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";
import { createRemoteProjectService } from "#src/remote-projects/index.js";
import type { RemoteProjectCache } from "#src/remote-projects/contract.js";
const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const directory = await mkdtemp(join(tmpdir(), "remote-project-test-"));
  directories.push(directory);
  await projectStorage.migrate(db, { backupDirectories: [directory] });
  const afterChange = vi.fn();
  const service = createRemoteProjectService({
    database: async () => db,
    afterChange,
    now: () => 100,
  });
  const target = { kind: "ssh" as const, host: "example.test", username: "user" };
  await service.saveHost({ id: "source", target });
  const project: RemoteProjectCache = {
    projectId: "p",
    name: "Remote",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  return { db, service, afterChange, target, project };
}
describe("remote project entry ownership", () => {
  it("reconnects through the existing connector and reads runtime state without persisting it", async () => {
    const { db, target } = await fixture();
    const connectHost = vi.fn(async () => "source");
    const state = {
      connectionStatus: "offline" as "offline" | "online",
      lastConnectionError: "SSH refused" as string | undefined,
    };
    const service = createRemoteProjectService({
      database: async () => db,
      connectHost,
      readConnectionStates: async () => new Map([["source", state]]),
    });
    expect((await service.readDirectory()).hosts[0]?.lastConnectionError).toBe("SSH refused");
    state.connectionStatus = "online";
    state.lastConnectionError = undefined;
    const host = await service.connectHost("source");
    expect(host.lastConnectionError).toBeUndefined();
    expect(connectHost).toHaveBeenCalledWith(expect.objectContaining({ id: "source", target }));
    expect(host.connectionStatus).toBe("online");
    expect(db.prepare("SELECT * FROM hosts WHERE host_id=?").get("source")).toMatchObject({
      last_connection_status: null,
      last_connection_error: null,
    });
    await service.removeHost("source");
    await expect(service.connectHost("source")).rejects.toThrow("remote-project.host-not-found");
    expect(connectHost).toHaveBeenCalledTimes(1);
  });
  it("allows an owner-only client to read its project tree without touching controller storage", async () => {
    const database = vi.fn(async () => {
      throw new Error("must not access controller storage");
    });
    const service = createRemoteProjectService({ database, controller: false });
    await expect(service.readDirectory()).resolves.toEqual({ hosts: [], entries: [] });
    await expect(
      service.saveHost({ id: "remote:server:s", target: { kind: "docker", container: "s" } }),
    ).rejects.toThrow("remote-project.controller-only");
    await expect(service.removeEntry("entry")).rejects.toThrow("remote-project.controller-only");
    expect(database).not.toHaveBeenCalled();
  });
  it("deduplicates legacy cwd entries only after a matching CAS resolves their project", async () => {
    const { db, service, project } = await fixture();
    const retained = await service.addEntry({ hostId: "source", project });
    db.prepare(
      "INSERT INTO remote_project_entries(entry_id,host_id,cached_name,cached_roots_json) VALUES('legacy','source','old','[]')",
    ).run();
    expect(
      await service.refreshEntry({ entryId: "legacy", expectedLastSyncedAt: 1, project }),
    ).toBe(false);
    expect((await service.readDirectory()).entries).toHaveLength(2);
    expect(
      await service.refreshEntry({ entryId: "legacy", expectedLastSyncedAt: null, project }),
    ).toBe(true);
    expect((await service.readDirectory()).entries).toEqual([retained]);
    expect(
      await service.refreshEntry({ entryId: "legacy", expectedLastSyncedAt: null, project }),
    ).toBe(false);
  });
  it("binds an address alias atomically while retaining existing stable project entries", async () => {
    const { service, target, project } = await fixture();
    const pending = (await service.readDirectory()).hosts[0]!;
    await service.saveHost({ id: "remote:server:s", target });
    const retained = await service.addEntry({ hostId: "remote:server:s", project });
    const duplicate = await service.addEntry({ hostId: pending.id, project });
    const legacy = await service.addEntry({
      hostId: pending.id,
      project: { ...project, projectId: "p2" },
    });
    const bound = await service.bindHost({
      id: pending.id,
      membershipId: pending.membershipId,
      resolvedId: "remote:server:s",
    });
    expect(bound?.id).toBe("remote:server:s");
    const directory = await service.readDirectory();
    expect(directory.hosts).toHaveLength(1);
    expect(directory.entries.map((entry) => entry.id).sort()).toEqual(
      [retained.id, legacy.id].sort(),
    );
    expect(directory.entries.every((entry) => entry.hostId === "remote:server:s")).toBe(true);
    expect(
      await service.refreshEntry({
        entryId: duplicate.id,
        expectedLastSyncedAt: duplicate.lastSyncedAt,
        project,
      }),
    ).toBe(false);
  });
  it("does not bind a removed and re-added membership from an older handshake", async () => {
    const { service, target } = await fixture();
    const old = (await service.readDirectory()).hosts[0]!;
    await service.removeHost(old.id);
    expect(
      await service.bindHost({
        id: old.id,
        membershipId: old.membershipId,
        resolvedId: "remote:server:old",
      }),
    ).toBeNull();
    const fresh = await service.saveHost({ id: old.id, target });
    expect(fresh.membershipId).not.toBe(old.membershipId);
    expect(
      await service.bindHost({
        id: old.id,
        membershipId: old.membershipId,
        resolvedId: "remote:server:old",
      }),
    ).toBeNull();
    expect((await service.readDirectory()).hosts.map((host) => host.id)).toEqual([old.id]);
  });
  it("does not transplant project entries between distinct stable physical Sources", async () => {
    const { service, target } = await fixture();
    const host = await service.saveHost({ id: "remote:server:a", target });
    await expect(
      service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId: "remote:server:b",
      }),
    ).rejects.toThrow("remote-project.source-identity-changed");
  });
  it("creates a separately confirmed Source without moving the old Source entries", async () => {
    const { service, target, project } = await fixture();
    const old = await service.saveHost({ id: "remote:server:a", target });
    const entry = await service.addEntry({ hostId: old.id, project });
    const next = await service.bindHost({
      id: old.id,
      membershipId: old.membershipId,
      resolvedId: "remote:server:b",
      createDistinctHost: true,
    });
    expect(next?.id).toBe("remote:server:b");
    expect(next?.membershipId).not.toBe(old.membershipId);
    expect((await service.readDirectory()).entries).toEqual([entry]);
    await service.removeHost(old.id);
    expect(
      await service.bindHost({
        id: old.id,
        membershipId: old.membershipId,
        resolvedId: "remote:server:c",
        createDistinctHost: true,
      }),
    ).toBeNull();
  });
  it("does not resurrect removed entries on late refresh or overwrite an explicit re-add", async () => {
    const { service, project } = await fixture();
    const old = await service.addEntry({ hostId: "source", project });
    await service.removeEntry(old.id);
    expect(
      await service.refreshEntry({
        entryId: old.id,
        expectedLastSyncedAt: old.lastSyncedAt,
        project,
      }),
    ).toBe(false);
    expect((await service.readDirectory()).entries).toEqual([]);
    const next = await service.addEntry({ hostId: "source", project });
    expect(next.id).not.toBe(old.id);
    expect(
      await service.refreshEntry({
        entryId: old.id,
        expectedLastSyncedAt: old.lastSyncedAt,
        project: { ...project, name: "stale" },
      }),
    ).toBe(false);
    expect((await service.readDirectory()).entries[0]?.name).toBe("Remote");
  });
  it("compares refresh versions even when the clock returns the same time", async () => {
    const { service, project } = await fixture();
    const entry = await service.addEntry({ hostId: "source", project });
    const input = { entryId: entry.id, expectedLastSyncedAt: entry.lastSyncedAt };
    expect(await service.refreshEntry({ ...input, project: { ...project, name: "new" } })).toBe(
      true,
    );
    expect(await service.refreshEntry({ ...input, project: { ...project, name: "stale" } })).toBe(
      false,
    );
    expect((await service.readDirectory()).entries[0]?.name).toBe("new");
  });
  it("removes only the host and its entries, leaving other hosts and authoritative projects", async () => {
    const { db, service, target, project } = await fixture();
    await service.saveHost({ id: "second", target });
    await service.addEntry({ hostId: "source", project });
    await service.addEntry({ hostId: "second", project });
    const local = projectStorage.repository(db).saveProject({ name: "Local", roots: [] });
    await service.removeHost("source");
    const directory = await service.readDirectory();
    expect(directory.hosts.map((host) => host.id)).toEqual(["second"]);
    expect(directory.entries.map((entry) => entry.hostId)).toEqual(["second"]);
    expect(db.prepare("SELECT project_id FROM projects").get()?.project_id).toBe(local.id);
    await expect(service.removeHost("local")).rejects.toThrow("remote-project.local-host");
  });
  it("keeps entry ID stable when explicitly adding an already retained project", async () => {
    const { service, project } = await fixture();
    const first = await service.addEntry({ hostId: "source", project });
    const again = await service.addEntry({
      hostId: "source",
      project: { ...project, name: "renamed" },
    });
    expect(again.id).toBe(first.id);
    expect((await service.readDirectory()).entries).toHaveLength(1);
  });
  it("does not expose historical shadow hosts or count them as saved connections", async () => {
    const { db, service, target } = await fixture();
    for (let n = 0; n < 30; n++)
      db.prepare("INSERT INTO hosts(host_id,kind) VALUES (?,'ssh')").run(`shadow-${n}`);
    expect((await service.readDirectory()).hosts.map((host) => host.id)).toEqual(["source"]);
    for (let n = 1; n < 20; n++) await service.saveHost({ id: `retained-${n}`, target });
    await expect(service.saveHost({ id: "shadow-1", target })).rejects.toThrow(
      "remote-project.host-limit",
    );
  });
  it("advances an unchanged refresh version without broadcasting a projection change", async () => {
    const { service, project, afterChange } = await fixture();
    const entry = await service.addEntry({ hostId: "source", project });
    afterChange.mockClear();
    expect(
      await service.refreshEntry({
        entryId: entry.id,
        expectedLastSyncedAt: entry.lastSyncedAt,
        project,
      }),
    ).toBe(true);
    expect(afterChange).not.toHaveBeenCalled();
    const current = (await service.readDirectory()).entries[0]!;
    expect(current.lastSyncedAt).toBeGreaterThan(entry.lastSyncedAt!);
    expect(
      await service.refreshEntry({
        entryId: entry.id,
        expectedLastSyncedAt: entry.lastSyncedAt,
        project: { ...project, name: "stale" },
      }),
    ).toBe(false);
  });
  it("enforces host capacity atomically and permits editing an existing host", async () => {
    const { service, target } = await fixture();
    for (let n = 1; n < 20; n++) await service.saveHost({ id: `host-${n}`, target });
    await expect(service.saveHost({ id: "overflow", target })).rejects.toThrow(
      "remote-project.host-limit",
    );
    await service.saveHost({ id: "source", target: { ...target, host: "updated" } });
    expect((await service.readDirectory()).hosts).toHaveLength(20);
  });
  it("rejects credentials and malformed project cache before writing", async () => {
    const { service, target, project, afterChange } = await fixture();
    afterChange.mockClear();
    await expect(
      service.saveHost({
        id: "secret",
        target: { ...target, password: "secret" } as typeof target,
      }),
    ).rejects.toThrow();
    await expect(service.addEntry({ hostId: "missing", project })).rejects.toThrow();
    await expect(
      service.addEntry({
        hostId: "source",
        project: { ...project, roots: [{ ...project.roots[0]!, isPrimary: false }] },
      }),
    ).rejects.toThrow();
    expect(afterChange).not.toHaveBeenCalled();
  });
});
