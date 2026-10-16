import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import {
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
} from "../src/storage/session-store/migration-runner.js";

const SELECTION = "0020_provider_model_selection";
const REASONING = "0022_backfilled_session_reasoning";
const APPLIED_AT = 1_000;
const databases: DatabaseSync[] = [];
const checksum = (sql: string) => createHash("sha256").update(sql.trim()).digest("hex");
const legacy = { providerID: "builtin:bigmodel-coding-plan", modelID: "glm-5.3", variant: "high" };

function createFixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
  );
  applyFrozen(db, SELECTION);
  return db;
}
function applyFrozen(db: DatabaseSync, before = "9999") {
  for (const migration of SQLITE_MIGRATIONS.filter((m) => m.id < before)) {
    if (db.prepare("SELECT 1 FROM schema_migration WHERE id=?").get(migration.id)) continue;
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
      migration.id,
      checksum(migration.sql),
      migration.appVersion,
      APPLIED_AT,
    );
  }
}
function seedSession(db: DatabaseSync, id: string) {
  db.prepare(
    "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, "project", id, "/fixture", "历史正文", "old", 1, 2);
}
function message(db: DatabaseSync, session: string, id: string, data: unknown, sequence = 1) {
  db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?)",
  ).run(id, session, 10, 12, JSON.stringify(data), sequence);
}
function entry(db: DatabaseSync, session: string, data: unknown) {
  db.prepare(
    "INSERT INTO session_entry(id,session_id,type,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
  ).run(
    `${session}:runtime-model-selection`,
    session,
    "runtime/model_selection",
    1,
    2,
    JSON.stringify(data),
  );
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries(
    ["session", "message", "part", "session_entry", "schema_migration"].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ]),
  );
}
function seedSelections(db: DatabaseSync) {
  const models = [
    undefined,
    null,
    {},
    legacy,
    { ...legacy, label: "标签", unknown: { body: "保留" } },
    { providerID: null },
    { providerID: 3, modelID: "x" },
    { providerID: " p ", modelID: " m ", variant: " " },
    { providerId: "new", modelId: "new" },
  ];
  for (const [i, model] of models.entries()) {
    const session = `session-${i}`;
    seedSession(db, session);
    message(db, session, `user-${i}`, { role: "user", model, unknown: ["正文", 1] });
    message(
      db,
      session,
      `assistant-${i}`,
      { role: "assistant", ...legacy, providerId: "existing", reasoningLevel: "low" },
      2,
    );
    for (const [j, toModel] of models.entries()) {
      const data = {
        type: "timeline",
        timelineType: "model_change",
        fromModel: model,
        toModel,
        fromModelSelection: { existing: true },
        unknown: { text: "正文", file: "attachment://ref" },
      };
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(`part-${i}-${j}`, `user-${i}`, session, 11, 13, JSON.stringify(data));
    }
    for (const [j, type] of ["subtask", "text", "tool"].entries()) {
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(
        `sub-${i}-${j}`,
        `user-${i}`,
        session,
        11,
        13,
        JSON.stringify({ type, model, text: "不可删除", modelSelection: null }),
      );
    }
  }
  seedSession(db, "explicit-null");
  message(db, "explicit-null", "null-old", { role: "user", model: legacy });
  // sequence/time_created 相同：必须按 rowid 选最后明确来源，不越过 null。
  message(db, "explicit-null", "null-new", { role: "user", modelSelection: null });
  seedSession(db, "entry");
  entry(db, "entry", { providerId: "custom", modelId: "x", thoughtLevel: "max", unknown: true });
  seedSession(db, "bad");
  message(db, "bad", "bad-json", {});
  db.exec("UPDATE message SET data='{' WHERE id='bad-json'");
  db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
  ).run("bad-part", "bad-json", "bad", 1, 2, "{");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe("Todo144：启动 runner 保持冻结迁移合同", () => {
  it.each(["sync", "async"])(
    "%s 启动执行原迁移：所有行、JSON、旧字段、时间与账本一致",
    async (mode) => {
      vi.spyOn(Date, "now").mockReturnValue(APPLIED_AT);
      const oldDb = createFixture();
      const nextDb = createFixture();
      for (const db of [oldDb, nextDb]) seedSelections(db);
      applyFrozen(oldDb);
      if (mode === "async") await runSqliteSessionMigrationsAsync(nextDb, ":memory:");
      else runSqliteSessionMigrations(nextDb, ":memory:");
      expect(snapshot(nextDb)).toEqual(snapshot(oldDb));
      expect(nextDb.prepare("SELECT count(*) AS n FROM part").get()?.n).toBe(109);
    },
  );

  it("已迁移的原账本可反复读取；用户清空新选择后不重迁", () => {
    const db = createFixture();
    seedSelections(db);
    applyFrozen(db);
    db.exec("UPDATE session_entry SET data=json_set(data,'$.modelSelection',NULL)");
    const before = snapshot(db);
    runSqliteSessionMigrations(db, ":memory:");
    applyFrozen(db);
    expect(snapshot(db)).toEqual(before);
  });

  it("checksum 不符仍失败并回滚，不篡改账本", () => {
    const db = createFixture();
    applyFrozen(db);
    db.prepare("UPDATE schema_migration SET checksum='changed' WHERE id=?").run(SELECTION);
    const before = snapshot(db);
    expect(() => runSqliteSessionMigrations(db, ":memory:")).toThrow(/checksum mismatch/);
    expect(snapshot(db)).toEqual(before);
  });

  it("原 SQL 遇到 trigger 拒绝写入时整笔回滚，重试可恢复", () => {
    const db = createFixture();
    seedSelections(db);
    db.exec(
      "CREATE TRIGGER reject_part BEFORE UPDATE ON part BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    const before = snapshot(db);
    expect(() => runSqliteSessionMigrations(db, ":memory:")).toThrow(/migration/);
    expect(snapshot(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
    db.exec("DROP TRIGGER reject_part");
    runSqliteSessionMigrations(db, ":memory:");
    expect(db.prepare("SELECT 1 FROM schema_migration WHERE id=?").get(REASONING)).toBeDefined();
  });
});
