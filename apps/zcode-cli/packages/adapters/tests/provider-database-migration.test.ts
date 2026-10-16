import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionId, createPartId, createMessageId, createProjectId } from "@zcode/contracts";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { seedUnrelatedProviderTables } from "./fixtures/provider-migration-unrelated-tables.js";
import {
  mapMessageWithParts as oldMap,
  modelChangeToModelOf as oldTimeline,
} from "./fixtures/staging-backup-model-readers.mjs";

const migrationId = "0020_provider_model_selection";
const sessionID = createSessionId("provider-migration-session");
const legacyProvider = "builtin:bigmodel-coding-plan";
const historicalSelection = {
  providerId: legacyProvider,
  modelId: "GLM-5.3",
  options: { reasoningLevel: "high" },
};
const currentSelection = {
  ...historicalSelection,
  providerId: "account:bigmodel-individual-coding-plan",
};

describe("DB109 会话库正式数据迁移", () => {
  let root: string;
  let path: string;
  let db: DatabaseSync;
  let store: ReturnType<typeof createSqliteSessionStore> | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-db109-"));
    path = join(root, "session.sqlite");
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      "CREATE TABLE schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
    );
    // 直接播种发布格式，不能先过新版 Writer 再冒充旧数据。
    for (const migration of SQLITE_MIGRATIONS.filter((item) => item.id < migrationId)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
        migration.id,
        createHash("sha256").update(migration.sql.trim()).digest("hex"),
        migration.appVersion,
        1,
      );
    }
    db.prepare(
      "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
    ).run(sessionID, "project", "old", root, "旧会话内容", "old", 11, 12);
  });
  afterEach(async () => {
    store?.close();
    store = undefined;
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const raw = (table: "message" | "part" | "session_entry", id: string) =>
    JSON.parse(String(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)?.data));
  const message = (id: string, value: unknown, sequence = 1) =>
    db
      .prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?)",
      )
      .run(id, sessionID, 11, 12, JSON.stringify(value), sequence);
  const entry = (value: unknown) =>
    db
      .prepare("INSERT INTO session_entry VALUES(?,?,?,?,?,?)")
      .run("selection", sessionID, "runtime/model_selection", 11, 12, JSON.stringify(value));
  const oldModel = { providerID: legacyProvider, modelID: "GLM-5.3", variant: "high" };

  it("DB109-01/11：22 张业务表全部有覆盖，无关表、账本旧记录与外键关系不变", () => {
    const unrelated = seedUnrelatedProviderTables(db, sessionID);
    const allTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migration'",
      )
      .all()
      .map((row) => row.name)
      .sort();
    expect(allTables).toEqual([...unrelated, "session", "session_entry", "message", "part"].sort());
    expect(allTables).toHaveLength(22);
    const before = unrelated.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    entry({ providerId: legacyProvider, modelId: "GLM-5.3" });
    store = createSqliteSessionStore({ dbPath: path });
    expect(unrelated.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(
      db.prepare("SELECT * FROM schema_migration WHERE id<? ORDER BY id").all(migrationId),
    ).toEqual(ledger);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("DB109-04：当前选择保留旧 parser 的 trim 语义，原值本身不修改", () => {
    entry({ providerId: ` ${legacyProvider} `, modelId: " GLM-5.3 ", thoughtLevel: " high " });
    store = createSqliteSessionStore({ dbPath: path });
    expect(raw("session_entry", "selection").modelSelection).toEqual(currentSelection);
    expect(raw("session_entry", "selection").providerId).toBe(` ${legacyProvider} `);
  });

  it("DB109-01/11：一次迁移保留旧成员、正文、来源和元数据，Part 新旧分开存", async () => {
    const oldUser = {
      role: "user",
      time: { created: 11 },
      agent: "main",
      model: oldModel,
      note: { keep: true },
    };
    const oldAssistant = {
      role: "assistant",
      time: { created: 11 },
      providerID: legacyProvider,
      modelID: "GLM-5.3",
      variant: "high",
    };
    message("user", oldUser);
    message("assistant", oldAssistant, 2);
    const oldEntry = {
      providerId: legacyProvider,
      modelId: "GLM-5.3",
      thoughtLevel: "high",
      keep: [1, 2],
    };
    entry(oldEntry);
    const parts = [
      { id: "body", value: { type: "text", text: "正文绝不能丢失" } },
      {
        id: "timeline",
        value: {
          type: "timeline",
          timelineType: "model_change",
          toModel: { ...oldModel, label: "GLM" },
          fromModel: oldModel,
        },
      },
      {
        id: "subtask",
        value: {
          type: "subtask",
          prompt: "子任务正文",
          description: "说明",
          agent: "worker",
          model: oldModel,
        },
      },
    ];
    for (const [index, part] of parts.entries()) {
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?,?)",
      ).run(part.id, "assistant", sessionID, 11, 12, JSON.stringify(part.value), index);
    }
    const sessionBefore = db.prepare("SELECT * FROM session").get();
    store = createSqliteSessionStore({ dbPath: path });
    expect(store.debugMigrationIds()).toContain(migrationId);
    expect(store.debugMigrationIds().at(-1)).toBe("0022_backfilled_session_reasoning");
    expect(raw("session_entry", "selection")).toEqual({
      ...oldEntry,
      modelSelection: currentSelection,
    });
    expect(raw("message", "user")).toEqual({ ...oldUser, modelSelection: historicalSelection });
    expect(raw("message", "assistant")).toEqual({
      ...oldAssistant,
      providerId: legacyProvider,
      modelId: "GLM-5.3",
      reasoningLevel: "high",
    });
    expect(raw("part", "timeline")).toEqual({
      ...parts[1]!.value,
      fromModelSelection: historicalSelection,
      toModelSelection: { ...historicalSelection, label: "GLM" },
    });
    expect(raw("part", "subtask")).toMatchObject({
      ...parts[2]!.value,
      modelSelection: historicalSelection,
    });
    expect(raw("part", "body")).toEqual(parts[0]!.value);
    expect(db.prepare("SELECT * FROM session").get()).toEqual(sessionBefore);
    const history = await store.messages({ sessionID });
    expect(history[0]?.info).not.toHaveProperty("model");
    expect(history[1]?.info).not.toHaveProperty("providerID");
    expect(history[1]?.parts.find((part) => part.id === "timeline")).toMatchObject({
      toModel: { ...historicalSelection, label: "GLM" },
    });
  });

  it("DB109-03/10：再升级缺新字段不补迁，历史正文仍然可读", async () => {
    message("user", { role: "user", time: { created: 11 }, agent: "main", model: oldModel });
    store = createSqliteSessionStore({ dbPath: path });
    expect(store.debugMigrationIds()).toContain(migrationId);
    store.close();
    db.prepare("UPDATE message SET data=json_remove(data,'$.modelSelection')").run();
    db.prepare("UPDATE session_entry SET data=json_remove(data,'$.modelSelection')").run();
    message(
      "after-rollback",
      { role: "user", time: { created: 13 }, agent: "main", model: oldModel },
      3,
    );
    store = createSqliteSessionStore({ dbPath: path });
    const history = await store.messages({ sessionID });
    expect(history).toHaveLength(2);
    expect(history.every((item) => !("modelSelection" in item.info))).toBe(true);
    expect((await store.getSession(sessionID))?.title).toBe("旧会话内容");
    expect(raw("message", "user")).not.toHaveProperty("modelSelection");
  });

  it("DB109-04：有明确旧来源时重建目标新字段，未知身份留空而不丢来源", () => {
    entry({
      providerId: legacyProvider,
      modelId: "GLM-5.3",
      thoughtLevel: "high",
      modelSelection: null,
    });
    store = createSqliteSessionStore({ dbPath: path });
    expect(raw("session_entry", "selection").modelSelection).toEqual(currentSelection);
  });

  it("DB109-05：数据写入失败回滚整个 migration，移除故障后可重试", () => {
    entry({ providerId: legacyProvider, modelId: "GLM-5.3", thoughtLevel: "high" });
    const before = db.prepare("SELECT * FROM session_entry").all();
    db.exec(
      "CREATE TRIGGER reject_entry BEFORE UPDATE ON session_entry BEGIN SELECT RAISE(ABORT,'db109 write failure'); END",
    );
    expect(() => createSqliteSessionStore({ dbPath: path })).toThrow();
    expect(db.prepare("SELECT * FROM session_entry").all()).toEqual(before);
    expect(
      db.prepare("SELECT id FROM schema_migration WHERE id=?").get(migrationId),
    ).toBeUndefined();
    db.exec("DROP TRIGGER reject_entry");
    store = createSqliteSessionStore({ dbPath: path });
    expect(raw("session_entry", "selection").modelSelection).toEqual(currentSelection);
  });

  it("DB109-09/12：新模型切换保留旧 Reader 必需的 toModel，更新保留旧快照但正常替换新字段", async () => {
    message("user", {
      role: "user",
      time: { created: 11 },
      agent: "main",
      model: oldModel,
      metadata: { removable: true },
    });
    store = createSqliteSessionStore({ dbPath: path });
    const first = (await store.messages({ sessionID }))[0]!.info;
    await store.saveMessage({ ...first, metadata: {}, modelSelection: undefined } as typeof first);
    expect(raw("message", "user").model).toEqual(oldModel);
    expect(raw("message", "user").metadata).toEqual({});
    const part = {
      id: "new-switch" as ReturnType<typeof createPartId>,
      messageID: first.id,
      sessionID,
      type: "timeline" as const,
      timelineType: "model_change" as const,
      toModel: { ...currentSelection, label: "GLM" },
      time: { start: 11, end: 12 },
    };
    await store.savePart(part);
    const disk = raw("part", "new-switch");
    expect(disk.toModelSelection).toEqual(part.toModel);
    // 来源：staging_backup transcript-hydration.ts 的旧 Reader 直接解引用 toModel。
    expect(() => String(disk.toModel.providerID)).not.toThrow();
    expect(disk.toModel.providerID).toBe(currentSelection.providerId);
    await store.savePart({
      ...part,
      toModel: { providerId: "custom", modelId: "next", label: "Next" },
    });
    expect(raw("part", "new-switch").toModel).toEqual(disk.toModel);
    expect(raw("part", "new-switch").toModelSelection).toEqual({
      providerId: "custom",
      modelId: "next",
      label: "Next",
    });
    await store.saveMessage(
      { ...first, id: "copied-user" as typeof first.id },
      { sessionID, id: first.id },
    );
    expect(raw("message", "copied-user").model).toEqual(oldModel);
    await store.savePart(
      { ...part, id: "copied-part" as typeof part.id },
      { sessionID, id: part.id },
    );
    expect(raw("part", "copied-part").toModel).toEqual(disk.toModel);
  });

  it("DB109-09：新版新增/无模型的用户消息经冻结旧协议 Reader 仍可打开正文", async () => {
    store = createSqliteSessionStore({ dbPath: path });
    for (const selection of [undefined, currentSelection]) {
      const id = (selection ? "new-selected" : "new-empty") as Parameters<
        typeof store.saveMessage
      >[0]["id"];
      await store.saveMessage({
        id,
        sessionID,
        role: "user",
        time: { created: 15 },
        agent: "main",
        modelSelection: selection,
      });
      const content = { type: "text", text: "正文不能因选型格式而打不开" };
      const mapped = oldMap({ info: { ...raw("message", id), id, sessionID }, parts: [content] });
      expect(mapped.parts[0].text).toBe(content.text);
    }
    const id = "timeline-parent" as Parameters<typeof store.saveMessage>[0]["id"];
    await store.saveMessage({ id, sessionID, role: "user", time: { created: 16 }, agent: "main" });
    await store.savePart({
      id: "empty-switch" as ReturnType<typeof createPartId>,
      messageID: id,
      sessionID,
      type: "timeline",
      timelineType: "model_change",
      time: { start: 16, end: 17 },
    });
    const history = { info: raw("message", id), parts: [raw("part", "empty-switch")] };
    expect(() => oldMap(history)).not.toThrow();
    expect(() => oldTimeline(history)).not.toThrow();
  });

  it("DB109-12：原子 fork 从父记录搬运旧快照，新子选择与旧快照彼此独立", async () => {
    message("parent-user", { role: "user", time: { created: 11 }, agent: "main", model: oldModel });
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run(
      "parent-part",
      "parent-user",
      sessionID,
      11,
      12,
      JSON.stringify({
        type: "subtask",
        prompt: "子任务正文",
        description: "旧描述",
        agent: "worker",
        model: oldModel,
      }),
    );
    store = createSqliteSessionStore({ dbPath: path });
    const source = (await store.messages({ sessionID }))[0]!;
    const childId = createSessionId("copy-child"),
      messageId = createMessageId("copy-message"),
      partId = createPartId("copy-part");
    const childMessage = {
      ...source.info,
      id: messageId,
      sessionID: childId,
      modelSelection: currentSelection,
    };
    const childPart = { ...source.parts[0]!, id: partId, messageID: messageId, sessionID: childId };
    await store.commitForkBundle!({
      child: {
        id: childId,
        parentID: sessionID,
        projectID: createProjectId("project"),
        slug: "copy-child",
        directory: root,
        title: "副本",
        version: "test",
      },
      messages: [{ info: childMessage, parts: [childPart] }],
      entries: [],
      copySources: {
        messages: { [messageId]: source.info.id },
        parts: { [partId]: source.parts[0]!.id },
      },
      commandFact: {
        parentSessionId: sessionID,
        sourceCommandId: "copy-command",
        ack: {
          commandId: "copy-command",
          status: "accepted",
          revisionAtDecision: 1,
          result: { type: "editUserQuery", disposition: "fork", sessionId: childId },
        },
        metadata: { source: "compact-edit" },
      },
    });
    expect(raw("message", messageId).model).toEqual(oldModel);
    expect(raw("message", messageId).modelSelection).toEqual(currentSelection);
    expect(raw("part", partId).model).toEqual(oldModel);
    expect((await store.messages({ sessionID: childId }))[0]?.parts[0]).toMatchObject({
      prompt: "子任务正文",
      model: historicalSelection,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
