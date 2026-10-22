import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";

function hashes(db: DatabaseSync) {
  return new Map(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migration'",
      )
      .all()
      .map(({ name }) => {
        const table = String(name).replaceAll('"', '""');
        const rows = db
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return [String(name), createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
      }),
  );
}

function seedBase(db: DatabaseSync) {
  db.exec(`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated)
    VALUES('session','project','slug','/repo','Title','0.2.0',1,2);
    INSERT INTO message VALUES('message','session',1,2,'{"role":"user","time":{"created":1}}');
    INSERT INTO part VALUES('part','message','session',1,2,'{"type":"text","text":"keep"}');
    INSERT INTO permission VALUES('project',1,2,'[{"permission":"read","pattern":"*","action":"allow"}]');
    INSERT INTO todo VALUES('session','keep','pending','normal',0,1,2);
    INSERT INTO input_history VALUES('input','project','session','keep','prompt',1);
    INSERT INTO session_entry VALUES('entry','session','checkpoint',1,2,'{}');`);
}

describe("each CLI migration writes only its declared tables", () => {
  it.each(SQLITE_MIGRATIONS.map((migration, index) => ({ migration, index })))(
    "$migration.id",
    async ({ migration, index }) => {
      const directory = await mkdtemp(join(tmpdir(), "migration-boundary-"));
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          "PRAGMA foreign_keys=ON; CREATE TABLE untouched(id TEXT PRIMARY KEY,value TEXT); INSERT INTO untouched VALUES('sentinel','keep')",
        );
        // 前序迁移必须经 runner 回放：0022 的 SQL JOIN schema_migration 读取 0020 的记账时间，
        // 裸 exec 不建 journal 会在 0023 之后的每条迁移上报 no such table。
        const options = {
          database: "cli",
          backupDirectories: [directory],
          appliedAtColumn: "time_applied",
        } as const;
        if (index > 0) {
          await sqliteMigrations.migrate(db, SQLITE_MIGRATIONS.slice(0, 1), options);
          seedBase(db);
          if (index > 1)
            await sqliteMigrations.migrate(db, SQLITE_MIGRATIONS.slice(1, index), options);
        }
        const before = hashes(db);
        await sqliteMigrations.migrate(db, [migration], options);
        const after = hashes(db);
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
          (table) => before.get(table) !== after.get(table),
        );
        expect(changed.filter((table) => !migration.touchedTables.includes(table))).toEqual([]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
