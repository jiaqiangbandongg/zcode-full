import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_ENTRY_MODEL_SELECTION, createProjectId, createSessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

const sessionID = createSessionId("legacy-selection");
const oldProvider = "builtin:bigmodel-coding-plan";
const newProvider = "account:bigmodel-individual-coding-plan";
const current = {
  providerId: newProvider,
  modelId: "GLM-5.3",
  options: { reasoningLevel: "high" },
};

describe("旧 Session 当前选择的单次迁移", () => {
  let root: string;
  let store: ReturnType<typeof createSqliteSessionStore>;
  let db: DatabaseSync;
  let opened = false;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-selection-migration-"));
    const dbPath = join(root, "session.sqlite");
    store = createSqliteSessionStore({ dbPath });
    opened = true;
    db = new DatabaseSync(dbPath);
    await store.createSession({
      id: sessionID,
      projectID: createProjectId("migration"),
      directory: root,
      slug: "migration",
      title: "Old history",
      version: "old",
    });
    // 此夹具只用新版建空表；删除尚未播种数据的 0020 记录，模拟升级前库。
    db.prepare("DELETE FROM schema_migration WHERE id = ?").run("0020_provider_model_selection");
  });
  const migrate = async (_input: { sessionID: typeof sessionID }) => {
    if (opened) store.close();
    opened = false;
    store = createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    opened = true;
  };
  afterEach(async () => {
    db.close();
    if (opened) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const entry = async (data: unknown) =>
    store.saveSessionEntry({
      id: `${sessionID}:runtime-model-selection`,
      sessionID,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: 1, updated: 1 },
      data,
    });
  // 已发布 fixture 直接写磁盘；不能经过新版 writer 后假装是升级前数据。
  const legacyEntry = (data: unknown) => {
    db.prepare(
      "insert into session_entry(id, session_id, type, time_created, time_updated, data) values(?,?,?,?,?,?)",
    ).run(
      `${sessionID}:runtime-model-selection`,
      sessionID,
      SESSION_ENTRY_MODEL_SELECTION,
      1,
      1,
      JSON.stringify(data),
    );
  };
  const rawEntry = () =>
    JSON.parse(
      String(
        db
          .prepare("select data from session_entry where type = ?")
          .get(SESSION_ENTRY_MODEL_SELECTION)?.data,
      ),
    );
  const message = (data: unknown, id = "old-message", sequence = 1) => {
    db.prepare(
      "insert into message(id, session_id, sequence, time_created, time_updated, data) values(?,?,?,?,?,?)",
    ).run(id, sessionID, sequence, sequence, sequence, JSON.stringify(data));
  };
  const oldMessage = () =>
    message({
      role: "user",
      agent: "zcode-agent",
      time: { created: 1 },
      model: { providerID: oldProvider, modelID: "GLM-5.3", variant: "high" },
    });
  const read = async () =>
    (await store.sessionEntries({ sessionID, type: SESSION_ENTRY_MODEL_SELECTION })).at(-1)?.data;

  it("离线迁移旧消息并固定同域个人身份；消息旧成员和任务活动时间不变", async () => {
    oldMessage();
    const before = db.prepare("select data from message").get();
    const sessionBefore = await store.getSession(sessionID);
    await migrate({ sessionID });
    expect(await read()).toEqual(current);
    expect(rawEntry()).toEqual({ modelSelection: current });
    expect(JSON.parse(String(db.prepare("select data from message").get()?.data))).toMatchObject(
      JSON.parse(String(before?.data)),
    );
    expect((await store.getSession(sessionID))?.time).toEqual(sessionBefore?.time);
    await migrate({ sessionID });
    expect(await read()).toEqual(current);
  });

  it.each([{}, { providerId: "current" }, current])(
    "已有当前 entry %j 不从旧消息补值",
    async (data) => {
      oldMessage();
      await entry(data);
      await migrate({ sessionID });
      expect(await read()).toEqual(data);
    },
  );

  it("旧消息身份的损坏 options 不丢失可确定的模型身份", async () => {
    const selection = {
      providerId: oldProvider,
      modelId: "GLM-5.3",
      options: { reasoningLevel: 42 },
    };
    message({
      role: "user",
      modelSelection: selection,
      model: { providerID: "other", modelID: "other", variant: "high" },
    });
    await migrate({
      sessionID,
    });
    expect(await read()).toEqual({ providerId: newProvider, modelId: "GLM-5.3" });
  });

  it("重复打开幂等，新保存的选择不被后续启动覆盖", async () => {
    oldMessage();
    await Promise.all([migrate({ sessionID }), migrate({ sessionID })]);
    expect(await read()).toEqual(current);
    expect(
      db
        .prepare("select count(*) as count from session_entry where type = ?")
        .get(SESSION_ENTRY_MODEL_SELECTION)?.count,
    ).toBe(1);
    const userSelection = {
      providerId: "custom",
      modelId: "user-chosen",
      options: { reasoningLevel: "low" },
    };
    await entry(userSelection);
    await migrate({ sessionID });
    expect(await read()).toEqual(userSelection);
  });

  it("最近消息已有当前结构，不向更老的消息寻找替代选择", async () => {
    oldMessage();
    message({ role: "user", modelSelection: {} }, "current-message", 2);
    await migrate({ sessionID });
    expect(await read()).toBeUndefined();
  });

  it("未知退役身份不猜默认绑定，旧记录保持不变", async () => {
    legacyEntry({ providerId: "builtin:unknown", modelId: "old-model", thoughtLevel: "high" });
    const before = db.prepare("select data from session_entry").get();
    await migrate({ sessionID });
    expect(db.prepare("select data from session_entry").get()).toEqual(before);
  });

  it("真正旧 entry 的 thoughtLevel 仅在单向迁移时搬入 options", async () => {
    legacyEntry({ providerId: "custom", modelId: "old-model", thoughtLevel: "low" });
    await migrate({ sessionID });
    const row = db
      .prepare("select data from session_entry where type = ?")
      .get(SESSION_ENTRY_MODEL_SELECTION);
    expect(JSON.parse(String(row?.data))).toEqual({
      providerId: "custom",
      modelId: "old-model",
      thoughtLevel: "low",
      modelSelection: {
        providerId: "custom",
        modelId: "old-model",
        options: { reasoningLevel: "low" },
      },
    });
  });

  it.each([undefined, "high"])(
    "保留旧身份/档位和其他字段，普通更新只改新成员：%s",
    async (thoughtLevel) => {
      const legacy = {
        providerId: oldProvider,
        modelId: "GLM-5.3",
        ...(thoughtLevel ? { thoughtLevel } : {}),
        note: { preserve: true },
      };
      legacyEntry(legacy);
      expect(await read()).toBeUndefined();
      await migrate({ sessionID });
      const migrated = {
        providerId: newProvider,
        modelId: "GLM-5.3",
        ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
      };
      expect(rawEntry()).toEqual({ ...legacy, modelSelection: migrated });
      expect(await read()).toEqual(migrated);
      const next = { providerId: "custom", modelId: "next-model" };
      await entry(next);
      await migrate({ sessionID });
      expect(rawEntry()).toEqual({ ...legacy, modelSelection: next });
      // 来源：790884b1ce server-operations.ts:3931-3953 的旧 reader 纯字段投影。
      // 不代表已启动旧 App；用该投影检查真实 JSON 仍恢复旧身份及 variant。
      const oldReader = (candidate: Record<string, unknown>) => {
        const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
        const providerId =
          typeof candidate.providerId === "string" ? candidate.providerId.trim() : "";
        if (!modelId || !providerId) return undefined;
        const thoughtLevel =
          typeof candidate.thoughtLevel === "string" ? candidate.thoughtLevel.trim() : "";
        return {
          model: { modelId, providerId, ...(thoughtLevel ? { variant: thoughtLevel } : {}) },
          ...(thoughtLevel ? { thoughtLevel } : {}),
        };
      };
      expect(oldReader(rawEntry())).toEqual(oldReader(legacy));
      store.close();
      store = createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
      expect(await read()).toEqual(next);
    },
  );

  it("无旧档位的自定义模型也只迁一次", async () => {
    const legacy = { providerId: "custom-provider", modelId: "custom/model" };
    legacyEntry(legacy);
    await migrate({ sessionID });
    expect(rawEntry()).toEqual({ ...legacy, modelSelection: legacy });
    const before = db.prepare("select * from session_entry").get();
    await migrate({ sessionID });
    expect(db.prepare("select * from session_entry").get()).toEqual(before);
  });

  it.each([null, {}, { providerId: "new" }])(
    "新选择 %j 不复活保留的旧字段/旧消息",
    async (selection) => {
      const legacy = { providerId: oldProvider, modelId: "GLM-5.3", thoughtLevel: "high" };
      legacyEntry(legacy);
      oldMessage();
      await migrate({ sessionID });
      await entry(selection);
      store.close();
      store = createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
      await migrate({ sessionID });
      expect(rawEntry()).toEqual({ ...legacy, modelSelection: selection });
      expect(await read()).toEqual(selection);
    },
  );

  it("数据库写失败不损坏旧快照或留下部分迁移", async () => {
    legacyEntry({ providerId: oldProvider, modelId: "GLM-5.3", thoughtLevel: "high" });
    const before = db.prepare("select * from session_entry").get();
    db.exec(
      "create trigger block_selection_update before update on session_entry begin select raise(abort, 'fixture write failure'); end",
    );
    await expect(migrate({ sessionID })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "fixture write failure" }),
    });
    expect(db.prepare("select * from session_entry").get()).toEqual(before);
    db.exec("drop trigger block_selection_update");
    await migrate({ sessionID });
    expect(await read()).toEqual(current);
  });
});
