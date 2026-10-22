import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationBackup, SqliteMigration, SqliteMigrationsContract } from "./contract.js";
import { sqliteMigrations } from "./index.js";

const port: SqliteMigrationsContract = sqliteMigrations;
const directories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-migration-"));
  directories.push(directory);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`pragma foreign_keys=on;
    create table session(id text primary key, title text not null);
    create table message(id text primary key, session_id text references session(id) on delete cascade);
    create table part(id text primary key, message_id text references message(id) on delete cascade, data blob);
    insert into session values ('s', 'original');
    insert into message values ('m', 's');
    insert into part values ('p', 'm', X'0001FF');`);
  return { db, directory, options: { database: "cli", backupDirectories: [directory] } };
}

const migration: SqliteMigration = {
  id: "0020",
  appVersion: "3.12",
  touchedTables: ["session"],
  sql: "update session set title='migrated'",
};

function content(db: DatabaseSync, table: string) {
  return db.prepare(`select * from ${table} order by id`).all();
}

describe("sqlite-migrations contract with real SQLite", () => {
  it("adopts a renamed migration only after validating its previous checksum", async () => {
    const { db, options, directory } = await fixture();
    await port.migrate(db, [migration], options);
    db.exec("update session set title='user-edited'");
    const before = await readdir(directory);
    const renamed = { ...migration, id: "0023", previousIds: [migration.id] };
    expect((await port.migrate(db, [renamed], options)).applied).toEqual([]);
    expect(content(db, "session")[0]).toMatchObject({ title: "user-edited" });
    expect(await readdir(directory)).toEqual(before);
    expect(db.prepare("select id from schema_migration order by id").all()).toEqual([
      { id: "0020" },
      { id: "0023" },
    ]);
    db.exec("update schema_migration set checksum='corrupt' where id='0020'");
    await expect(port.migrate(db, [renamed], options)).rejects.toThrow(/checksum/i);
    expect(content(db, "session")[0]).toMatchObject({ title: "user-edited" });
  });

  it.each([undefined, [], [""], ["bad;table"]].map((touchedTables) => ({ touchedTables })))(
    "rejects invalid touchedTables before changing the database: %j",
    async ({ touchedTables }) => {
      const { db, options, directory } = await fixture();
      await expect(
        port.migrate(db, [{ ...migration, touchedTables } as SqliteMigration], options),
      ).rejects.toThrow(/touchedTables/);
      expect(content(db, "session")[0]).toMatchObject({ title: "original" });
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("preserves the upstream task journal shape and restores its own migration records", async () => {
    const { db, options } = await fixture();
    db.exec(
      "create table tasks_schema_migration(id text primary key,checksum text not null,time_applied integer not null)",
    );
    const result = await port.migrate(db, [migration], {
      ...options,
      journalTable: "tasks_schema_migration",
    });
    expect(
      db
        .prepare("pragma table_info(tasks_schema_migration)")
        .all()
        .map((row) => row.name),
    ).toEqual(["id", "checksum", "time_applied"]);
    expect(
      (await port.migrate(db, [migration], { ...options, journalTable: "tasks_schema_migration" }))
        .applied,
    ).toEqual([]);
    await port.restore(db, result.backupPath!);
    expect(content(db, "session")[0]).toMatchObject({ title: "original" });
    expect(db.prepare("select * from tasks_schema_migration").all()).toEqual([]);
  });

  it("uses a writable fallback volume and reports an explicit skip if none is available", async () => {
    const { db, directory, options } = await fixture();
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "occupied");
    const fallback = join(directory, "fallback");
    const result = await port.migrate(db, [migration], {
      ...options,
      backupDirectories: [blocked],
      fallbackBackupDirectories: async () => [fallback],
    });
    expect(result.backupPath?.startsWith(fallback)).toBe(true);
    expect(result.backupSkipped).toBe(false);
    let notified = false;
    const skipped = await port.migrate(db, [{ ...migration, id: "next" }], {
      ...options,
      backupDirectories: [blocked],
      fallbackBackupDirectories: async () => [],
      onBackupSkipped: () => {
        notified = true;
      },
    });
    expect(skipped.backupSkipped).toBe(true);
    expect(notified).toBe(true);
  });

  it("backs up only declared tables and restores without cascading message/part deletion", async () => {
    const { db, options } = await fixture();
    const before = {
      session: content(db, "session"),
      message: content(db, "message"),
      part: content(db, "part"),
    };
    const result = await port.migrate(db, [migration], options);
    expect(result.applied).toEqual(["0020"]);
    expect(content(db, "session")).not.toEqual(before.session);
    expect(content(db, "message")).toEqual(before.message);
    expect(content(db, "part")).toEqual(before.part);
    const metadata = JSON.parse(
      await readFile(join(result.backupPath!, "backup.json"), "utf8"),
    ) as MigrationBackup;
    expect(metadata.tables.map((table) => table.name)).toEqual(["session"]);
    db.exec("alter table session add column time_deleted integer");
    await port.restore(db, result.backupPath!);
    expect(db.prepare("select id,title from session").all()).toEqual(before.session);
    expect(content(db, "message")).toEqual(before.message);
    expect(content(db, "part")).toEqual(before.part);
    expect(db.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("select * from schema_migration").all()).toEqual([]);
    expect((await port.migrate(db, [migration], options)).applied).toEqual(["0020"]);
  });

  it("rolls back the complete migration batch but retains its pre-migration backup", async () => {
    const { db, options, directory } = await fixture();
    const before = content(db, "session");
    await expect(
      port.migrate(
        db,
        [migration, { ...migration, id: "0021", sql: "insert into missing values (1)" }],
        options,
      ),
    ).rejects.toThrow();
    expect(content(db, "session")).toEqual(before);
    const backups = await readdir(directory);
    expect(backups).toHaveLength(1);
    const metadata = JSON.parse(
      await readFile(join(directory, backups[0]!, "backup.json"), "utf8"),
    ) as MigrationBackup;
    expect(metadata.migrations).toEqual(["0020", "0021"]);
  });

  it("keeps historical checksums, ignores unknown ids and does not back up on ordinary startup", async () => {
    const { db, options, directory } = await fixture();
    await port.migrate(db, [migration], { ...options, appliedAtColumn: "time_applied" });
    db.exec("insert into schema_migration values ('future', 'future-checksum', '9', 1)");
    const checksum = createHash("sha256").update(migration.sql.trim()).digest("hex");
    expect(db.prepare("select checksum from schema_migration where id='0020'").get()).toEqual({
      checksum,
    });
    const before = await readdir(directory);
    expect(
      await port.migrate(db, [migration], { ...options, appliedAtColumn: "time_applied" }),
    ).toEqual({ applied: [], backupSkipped: false });
    expect(await readdir(directory)).toEqual(before);
    await expect(port.migrate(db, [{ ...migration, sql: "select 1" }], options)).rejects.toThrow(
      /checksum/i,
    );
    expect(content(db, "session")[0]).toMatchObject({ title: "migrated" });
  });

  it("rejects corrupted backup metadata without changing any table", async () => {
    const { db, options } = await fixture();
    const { backupPath } = await port.migrate(db, [migration], options);
    const path = join(backupPath!, "backup.json");
    const metadata = JSON.parse(await readFile(path, "utf8")) as MigrationBackup;
    metadata.tables[0]!.hash = "invalid";
    await writeFile(path, JSON.stringify(metadata));
    await expect(port.restore(db, backupPath!)).rejects.toThrow(/hash/i);
    expect(content(db, "session")[0]).toMatchObject({ title: "migrated" });
    expect(content(db, "message")).toHaveLength(1);
    expect(content(db, "part")).toHaveLength(1);
    expect(db.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("restores all declared tables, including binary values, independent of FK order", async () => {
    const { db, options } = await fixture();
    const before = ["session", "message", "part"].map((table) => content(db, table));
    const { backupPath } = await port.migrate(
      db,
      [{ ...migration, touchedTables: ["part", "message", "session"], sql: "delete from session" }],
      options,
    );
    await port.restore(db, backupPath!);
    expect(["session", "message", "part"].map((table) => content(db, table))).toEqual(before);
  });

  it("serializes concurrent connections before the async backup without blocking the event loop", async () => {
    const { directory, options } = await fixture();
    const path = join(directory, "concurrent.sqlite");
    const first = new DatabaseSync(path);
    const second = new DatabaseSync(path);
    databases.push(first, second);
    first.exec(
      "pragma journal_mode=wal; create table session(id text primary key,title text); insert into session values ('s','original')",
    );
    const results = await Promise.all([
      port.migrate(first, [migration], options),
      port.migrate(second, [migration], options),
    ]);
    expect(results.map((result) => result.applied)).toEqual([["0020"], []]);
    expect(first.prepare("select count(*) as n from schema_migration").get()).toEqual({ n: 1 });
  });

  it("keeps the newest two backups", async () => {
    const { db, options, directory } = await fixture();
    for (const id of ["1", "2", "3"]) await port.migrate(db, [{ ...migration, id }], options);
    expect(await readdir(directory)).toHaveLength(2);
  });
});
