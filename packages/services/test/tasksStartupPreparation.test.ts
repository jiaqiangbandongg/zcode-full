import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { prepareTasksIndexStorage } from "../src/session/tasksDatabase/startup.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

it("prepares the same frozen ledger as the old runner and preserves completed data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-"));
  const expected = new DatabaseSync(":memory:");
  try {
    runTasksDatabaseMigrations(expected);
    const path = join(dir, "tasks.sqlite");
    const phases: string[] = [];
    await prepareTasksIndexStorage(path, (phase) => {
      phases.push(phase);
    });
    const db = new DatabaseSync(path);
    try {
      expect(
        db.prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id").all(),
      ).toEqual(
        expected.prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id").all(),
      );
      db.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('user change')");
    } finally {
      db.close();
    }
    await prepareTasksIndexStorage(path, () => {});
    const reopened = new DatabaseSync(path);
    try {
      expect(reopened.prepare("SELECT value FROM preserved").get()?.value).toBe("user change");
    } finally {
      reopened.close();
    }
    expect(phases.at(-1)).toBe("ready");
  } finally {
    expected.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not reuse an in-process preparation marker after the database was replaced", async () => {
  const { markTasksStoragePrepared, isTasksStoragePrepared } =
    await import("../src/session/tasksDatabase/prepared.js");
  const db = new DatabaseSync(":memory:");
  try {
    markTasksStoragePrepared("/replacement-test");
    expect(isTasksStoragePrepared("/replacement-test", db)).toBe(false);
    runTasksDatabaseMigrations(db);
    expect(isTasksStoragePrepared("/replacement-test", db)).toBe(true);
    db.exec("UPDATE tasks_schema_migration SET checksum='invalid'");
    expect(() => isTasksStoragePrepared("/replacement-test", db)).toThrow("checksum mismatch");
  } finally {
    db.close();
  }
});

it("retains the primary preparation failure when repository cleanup also fails", async () => {
  const { TaskIndexRepo } = await import("../src/session/taskIndexRepo.js");
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-cleanup-"));
  const primary = Object.assign(new Error("storage full"), { code: "ENOSPC" });
  const prepare = vi.spyOn(TaskIndexRepo.prototype, "ensureReady").mockRejectedValue(primary);
  const close = vi.spyOn(TaskIndexRepo.prototype, "close").mockImplementation(() => {
    throw new Error("cleanup failed");
  });
  try {
    await expect(prepareTasksIndexStorage(join(dir, "tasks.sqlite"), () => {})).rejects.toBe(
      primary,
    );
  } finally {
    prepare.mockRestore();
    close.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("SILENTDB-01/02: reports maintenance separately and no migration for a prepared database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-silent-startup-"));
  const path = join(dir, "tasks.sqlite");
  try {
    const first: unknown[] = [];
    await prepareTasksIndexStorage(path, (phase, migration) => first.push({ phase, migration }));
    expect(
      (first.at(-1) as { migration: { lastAppliedMigrationId: unknown } }).migration
        .lastAppliedMigrationId,
    ).toBeNull();
    expect(first).toContainEqual({
      phase: "checking",
      migration: { kind: "initialize", executedCount: 0, committedCount: 0 },
    });
    expect(first).toContainEqual(
      expect.objectContaining({
        migration: {
          kind: "initialize",
          executedCount: 3,
          committedCount: 3,
          lastAppliedMigrationId: null,
        },
      }),
    );
    const second: { phase: string; migration: unknown }[] = [];
    await prepareTasksIndexStorage(path, (phase, migration) => second.push({ phase, migration }));
    expect(second.some((s) => s.phase === "migrating")).toBe(false);
    expect(second.at(-1)).toMatchObject({
      migration: { lastAppliedMigrationId: "0003_official_glm_selection" },
    });
    expect(second.some((s) => s.phase === "maintaining")).toBe(true);
    expect(second).toContainEqual(
      expect.objectContaining({ migration: { kind: "none", executedCount: 0, committedCount: 0 } }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains committed facts if closing the migration connection fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-close-facts-"));
  const primary = new Error("migration connection close failed");
  const original = DatabaseSync.prototype.close;
  const close = vi
    .spyOn(DatabaseSync.prototype, "close")
    .mockImplementationOnce(function (this: DatabaseSync) {
      original.call(this);
      throw primary;
    });
  const states: { phase: string; migration: unknown }[] = [];
  try {
    await expect(
      prepareTasksIndexStorage(join(dir, "tasks.sqlite"), (phase, migration) => {
        states.push({ phase, migration });
      }),
    ).rejects.toBe(primary);
    expect(states.at(-1)).toMatchObject({
      migration: {
        kind: "initialize",
        executedCount: 3,
        committedCount: 3,
        lastAppliedMigrationId: null,
      },
    });
    expect(states.some(({ phase }) => phase === "ready")).toBe(false);
  } finally {
    close.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("updates wait visibility after migration precheck even if journal setup already waited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-repeated-lock-"));
  const original = DatabaseSync.prototype.exec;
  const blocked = new Set(["PRAGMA journal_mode = WAL", "BEGIN IMMEDIATE"]);
  const exec = vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql) {
      if (blocked.delete(sql)) throw Object.assign(new Error("busy"), { errcode: 5 });
      original.call(this, sql);
    });
  const waits: unknown[] = [];
  try {
    await prepareTasksIndexStorage(join(dir, "tasks.sqlite"), (phase, migration) => {
      if (phase === "waiting_for_lock") waits.push(migration?.kind);
    });
    expect(waits).toEqual([undefined, "initialize"]);
  } finally {
    exec.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps the pre-upgrade task ledger ID after committing the remaining migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-baseline-"));
  const path = join(dir, "tasks.sqlite");
  try {
    await prepareTasksIndexStorage(path, () => {});
    const db = new DatabaseSync(path);
    try {
      db.exec("DELETE FROM tasks_schema_migration WHERE id='0003_official_glm_selection'");
    } finally {
      db.close();
    }
    const states: unknown[] = [];
    await prepareTasksIndexStorage(path, (phase, migration) => states.push({ phase, migration }));
    expect(states.at(-1)).toMatchObject({
      phase: "ready",
      migration: {
        kind: "upgrade",
        executedCount: 1,
        committedCount: 1,
        lastAppliedMigrationId: "0002_provider_selection",
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
