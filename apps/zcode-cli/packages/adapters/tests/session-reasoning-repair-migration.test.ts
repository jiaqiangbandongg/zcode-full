import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

const REPAIR_ID = "0022_backfilled_session_reasoning";
const ORIGINAL_ID = "0020_provider_model_selection";
const APPLIED_AT = 1_000;
const SESSION_ID = createSessionId("reasoning-repair");
const ENTRY_ID = `${SESSION_ID}:runtime-model-selection`;

describe("Todo121：只补 0020 回填后未动过的会话档位", () => {
  let root: string;
  let path: string;
  let db: DatabaseSync;
  let store: ReturnType<typeof createSqliteSessionStore> | undefined;

  function applyBefore(id: string) {
    for (const migration of SQLITE_MIGRATIONS.filter((item) => item.id < id)) {
      if (db.prepare("SELECT 1 FROM schema_migration WHERE id=?").get(migration.id)) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
        migration.id,
        createHash("sha256").update(migration.sql.trim()).digest("hex"),
        migration.appVersion,
        APPLIED_AT,
      );
    }
  }
  function insertMessage(id: string, data: unknown, sequence: number) {
    db.prepare(
      "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?)",
    ).run(id, SESSION_ID, 11, 12, JSON.stringify(data), sequence);
  }
  function seed(providerId = "custom-provider", modelId = "stealth/ox-alpha") {
    insertMessage(
      "user",
      {
        role: "user",
        agent: "main",
        time: { created: 11 },
        model: { providerID: providerId, modelID: modelId, variant: "max" },
      },
      1,
    );
    insertMessage(
      "assistant",
      {
        role: "assistant",
        parentID: "user",
        time: { created: 11, completed: 12 },
        providerID: providerId,
        modelID: modelId,
      },
      2,
    );
  }
  function setEntry(data: unknown) {
    db.prepare("UPDATE session_entry SET data=? WHERE id=?").run(JSON.stringify(data), ENTRY_ID);
  }
  function readEntry() {
    return JSON.parse(
      String(db.prepare("SELECT data FROM session_entry WHERE id=?").get(ENTRY_ID)?.data),
    );
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-reasoning-repair-"));
    path = join(root, "session.sqlite");
    db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
    );
    applyBefore(ORIGINAL_ID);
    db.prepare(
      "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
    ).run(SESSION_ID, "project", "old", root, "旧会话正文不能丢", "old", 11, 12);
  });
  afterEach(async () => {
    store?.close();
    store = undefined;
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["custom-provider", "stealth/ox-alpha", "custom-provider", "stealth/ox-alpha"],
    [
      "builtin:bigmodel-coding-plan",
      "glm-5.3",
      "account:bigmodel-individual-coding-plan",
      "GLM-5.3",
    ],
    ["builtin:zai-start-plan", "glm-5.3-flash", "account:zai-start-plan", "GLM-5.3-Flash"],
  ])(
    "首次升级 %s/%s：同一启动完成补值，正式 Reader 读到档位",
    async (provider, model, targetProvider, targetModel) => {
      seed(provider, model);
      store = createSqliteSessionStore({ dbPath: path });
      expect(store.debugMigrationIds()).toContain(REPAIR_ID);
      expect(readEntry().modelSelection).toEqual({
        providerId: targetProvider,
        modelId: targetModel,
        options: { reasoningLevel: "max" },
      });
      expect(
        (await store.sessionEntries({ sessionID: SESSION_ID, type: "runtime/model_selection" }))[0]
          ?.data,
      ).toEqual(readEntry().modelSelection);
      expect((await store.getSession(SESSION_ID))?.title).toBe("旧会话正文不能丢");
      expect(await store.messages({ sessionID: SESSION_ID })).toHaveLength(2);
    },
  );

  it("已执行 0020：仅补新档位，历史字段/时间/消息/旧账本均不动，重启不重跑", () => {
    seed();
    applyBefore(REPAIR_ID);
    const messages = db.prepare("SELECT * FROM message").all();
    const session = db.prepare("SELECT * FROM session").get();
    const entry = db.prepare("SELECT * FROM session_entry").get();
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    store = createSqliteSessionStore({ dbPath: path });
    expect(readEntry().modelSelection.options).toEqual({ reasoningLevel: "max" });
    expect(db.prepare("SELECT * FROM message").all()).toEqual(messages);
    expect(db.prepare("SELECT * FROM session").get()).toEqual(session);
    expect(db.prepare("SELECT * FROM session_entry").get()).toEqual({
      ...entry,
      data: JSON.stringify(readEntry()),
    });
    expect(
      db.prepare("SELECT * FROM schema_migration WHERE id<? ORDER BY id").all(REPAIR_ID),
    ).toEqual(ledger);
    store.close();
    store = undefined;
    db.prepare("UPDATE session_entry SET data=json_remove(data,'$.modelSelection.options')").run();
    store = createSqliteSessionStore({ dbPath: path });
    expect(readEntry().modelSelection).not.toHaveProperty("options");
  });

  it.each([
    "session-touched",
    "selection-touched",
    "options-empty",
    "options-null",
    "selection-cleared",
    "old-flat",
    "different-model",
    "different-provider",
    "third-party-case",
    "latest-user-empty",
    "latest-user-no-level",
    "bad-json",
    "invalid-identity",
    "wrong-entry-id",
  ])("不修复不确定或用户改过的记录：%s", (scenario) => {
    seed();
    applyBefore(REPAIR_ID);
    const data = readEntry();
    switch (scenario) {
      case "session-touched":
        db.prepare("UPDATE session SET time_updated=?").run(APPLIED_AT + 1);
        break;
      case "selection-touched":
        db.prepare("UPDATE session_entry SET time_updated=?").run(APPLIED_AT + 1);
        break;
      case "options-empty":
        setEntry({ modelSelection: { ...data.modelSelection, options: {} } });
        break;
      case "options-null":
        setEntry({ modelSelection: { ...data.modelSelection, options: null } });
        break;
      case "selection-cleared":
        setEntry({ modelSelection: null });
        break;
      case "old-flat":
        setEntry({ ...data, thoughtLevel: null });
        break;
      case "different-model":
        setEntry({ modelSelection: { ...data.modelSelection, modelId: "other" } });
        break;
      case "different-provider":
        setEntry({ modelSelection: { ...data.modelSelection, providerId: "other" } });
        break;
      case "third-party-case":
        setEntry({ modelSelection: { ...data.modelSelection, modelId: "STEALTH/OX-ALPHA" } });
        break;
      case "latest-user-empty":
        insertMessage("later-user", { role: "user", modelSelection: null }, 3);
        break;
      case "latest-user-no-level":
        insertMessage("later-user", { role: "user", modelSelection: data.modelSelection }, 3);
        break;
      case "bad-json":
        db.prepare("UPDATE session_entry SET data='{' ").run();
        break;
      case "invalid-identity":
        setEntry({ modelSelection: { providerId: 123, modelId: "stealth/ox-alpha" } });
        break;
      case "wrong-entry-id":
        db.prepare("UPDATE session_entry SET id='another-entry'").run();
        break;
    }
    const before = db.prepare("SELECT * FROM session_entry").all();
    store = createSqliteSessionStore({ dbPath: path });
    expect(store.debugMigrationIds()).toContain(REPAIR_ID);
    expect(db.prepare("SELECT * FROM session_entry").all()).toEqual(before);
  });

  it("迁移失败整笔回滚，重试可成功", () => {
    seed();
    applyBefore(REPAIR_ID);
    const before = db.prepare("SELECT * FROM session_entry").all();
    db.exec(
      "CREATE TRIGGER reject_repair BEFORE UPDATE ON session_entry BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
    );
    expect(() => createSqliteSessionStore({ dbPath: path })).toThrow();
    expect(db.prepare("SELECT * FROM session_entry").all()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM schema_migration WHERE id=?").get(REPAIR_ID)).toBeUndefined();
    db.exec("DROP TRIGGER reject_repair");
    store = createSqliteSessionStore({ dbPath: path });
    expect(readEntry().modelSelection.options).toEqual({ reasoningLevel: "max" });
  });
});
