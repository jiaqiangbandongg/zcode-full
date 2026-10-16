import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

describe("DB109 App 库统一迁移", () => {
  const databases: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("DB109-02/03：任意 Repo 所需八张表一次创建，重开不改账本", () => {
    const db = open();
    runTasksDatabaseMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    expect(tables.map((row) => row.name)).toEqual([
      "automation_runs",
      "automations",
      "off_peak_tasks",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "task_groups",
      "tasks",
      "tasks_schema_migration",
    ]);
    const ledger = db.prepare("SELECT * FROM tasks_schema_migration").all();
    expect(ledger).toHaveLength(3);
    runTasksDatabaseMigrations(db);
    expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual(ledger);
  });

  it("DB109-04/08：旧格式来源明确才转，原列/时间保留，不依赖账号", () => {
    const db = open();
    runTasksDatabaseMigrations(db);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection'");
    const insert = db.prepare(
      `INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,thought_level,model_selection) VALUES(?, '* * * * *','正文','ws','/ws',1,2,?,?,?,?)`,
    );
    insert.run("known", "custom:builtin%3Abigmodel-coding-plan:GLM-5.3", "zcode", "high", "null");
    insert.run("unknown", "unknown-model", "zcode", "high", "null");
    insert.run("default", null, null, null, null);
    runTasksDatabaseMigrations(db);
    const known = db.prepare("SELECT * FROM automations WHERE automation_id='known'").get()!;
    expect(JSON.parse(String(known.model_selection))).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    });
    expect(known).toMatchObject({
      model: "custom:builtin%3Abigmodel-coding-plan:GLM-5.3",
      provider: "zcode",
      thought_level: "high",
      prompt: "正文",
      created_at: 1,
      updated_at: 2,
    });
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='unknown'").get()
        ?.model_selection,
    ).toBeNull();
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='default'").get()
        ?.model_selection,
    ).toBe("null");
    db.exec("UPDATE automations SET model_selection=NULL WHERE automation_id='known'");
    runTasksDatabaseMigrations(db);
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='known'").get()
        ?.model_selection,
    ).toBeNull();
  });

  it("GLM112：新增版本仅规范官方当前选择，旧列、坏值和回滚后缺失不改写", () => {
    const db = open();
    runTasksDatabaseMigrations(db);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0003_official_glm_selection'");
    const oldLedger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    const cases = [
      [
        "official",
        JSON.stringify({
          providerId: "account:zai-start-plan",
          modelId: "glm-5.3-flash",
          options: { reasoningLevel: "high" },
        }),
      ],
      ["custom", JSON.stringify({ providerId: "personal-proxy", modelId: "glm-5.3-flash" })],
      [
        "offpeak",
        JSON.stringify({ providerId: "account:zai-offpeak-idle-plan", modelId: "glm-5.3-flash" }),
      ],
      ["unknown", JSON.stringify({ providerId: "account:zai-start-plan", modelId: "glm-unknown" })],
      ["broken", "{broken"],
      ["missing", null],
    ] as const;
    const insert =
      db.prepare(`INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,model_selection)
      VALUES(?, '* * * * *', '任务正文', 'remote:ws', '/ws', 1, 2, '旧选择原文', ?)`);
    for (const [id, selection] of cases) insert.run(id, selection);
    runTasksDatabaseMigrations(db);
    expect(
      db
        .prepare(
          "SELECT * FROM tasks_schema_migration WHERE id != '0003_official_glm_selection' ORDER BY id",
        )
        .all(),
    ).toEqual(oldLedger);
    for (const [id, selection] of cases) {
      const row = db.prepare("SELECT * FROM automations WHERE automation_id=?").get(id)!;
      expect(row).toMatchObject({
        prompt: "任务正文",
        model: "旧选择原文",
        created_at: 1,
        updated_at: 2,
      });
      expect(row.model_selection).toBe(
        id === "official" ? selection?.replace("glm-5.3-flash", "GLM-5.3-Flash") : selection,
      );
    }
    const ledger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    db.exec("UPDATE automations SET model_selection=NULL WHERE automation_id='official'");
    expect(() => runTasksDatabaseMigrations(db)).not.toThrow();
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='official'").get()
        ?.model_selection,
    ).toBeNull();
    expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(ledger);
  });

  it("DB109-05/07：SQL 故障不记成功，checksum 错误不重跑", () => {
    const db = open();
    db.exec("CREATE TABLE automations(automation_id TEXT)");
    expect(() => runTasksDatabaseMigrations(db)).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='tasks_schema_migration'").get(),
    ).toBeUndefined();
    const ready = open();
    runTasksDatabaseMigrations(ready);
    ready.exec("UPDATE tasks_schema_migration SET checksum='broken'");
    expect(() => runTasksDatabaseMigrations(ready)).toThrow(/checksum/);
  });

  it("DB109-02/05：部分旧 schema 补列，数据转换中途失败连补列一起回滚", () => {
    const db = open();
    runTasksDatabaseMigrations(db);
    db.exec(`DELETE FROM tasks_schema_migration;
      ALTER TABLE automations DROP COLUMN model_selection;
      ALTER TABLE automations DROP COLUMN scheduled_run_count;
      INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,run_count)
      VALUES('legacy','* * * * *','旧任务正文','remote:/same','/same',11,12,'p/model','zcode',7);
      CREATE TRIGGER reject_migration BEFORE UPDATE ON automations
      BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
    expect(() => runTasksDatabaseMigrations(db)).toThrow(/injected failure/);
    expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual([]);
    expect(
      db
        .prepare("PRAGMA table_info(automations)")
        .all()
        .map((row) => row.name),
    ).not.toContain("model_selection");
    db.exec("DROP TRIGGER reject_migration");
    runTasksDatabaseMigrations(db);
    expect(
      db.prepare("SELECT * FROM automations WHERE automation_id='legacy'").get(),
    ).toMatchObject({
      prompt: "旧任务正文",
      workspace_key: "remote:/same",
      workspace_path: "/same",
      created_at: 11,
      updated_at: 12,
      model: "p/model",
      provider: "zcode",
      run_count: 7,
      scheduled_run_count: 7,
      model_selection: JSON.stringify({ providerId: "p", modelId: "model" }),
    });
  });

  it.each([
    [
      "custom:builtin:bigmodel-coding-plan:GLM-5.3",
      "account:bigmodel-individual-coding-plan",
      "GLM-5.3",
      "high",
    ],
    ["custom:proxy:vendor%2Fmodel%3Abeta", "proxy", "vendor/model:beta", "high"],
    ["proxy/vendor/model$low", "proxy", "vendor/model", "low"],
    ["custom:proxy:bad%escape", "proxy", "bad%escape", "high"],
  ])("DB109-04：冻结旧选择编码 %s", (model, providerId, modelId, reasoningLevel) => {
    const db = open();
    runTasksDatabaseMigrations(db);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection'");
    db.prepare(`INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,thought_level)
      VALUES('legacy','* * * * *','正文','ws','/ws',1,2,?,'zcode','high')`).run(model);
    runTasksDatabaseMigrations(db);
    const row = db.prepare("SELECT model,model_selection FROM automations").get()!;
    expect(row.model).toBe(model);
    expect(JSON.parse(String(row.model_selection))).toEqual({
      providerId,
      modelId,
      options: { reasoningLevel },
    });
  });

  it("DB109-06：两个独立线程同时打开旧库，数据转换只发生一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-db109-concurrent-"));
    const path = join(root, "tasks.sqlite");
    const db = new DatabaseSync(path);
    const workers: Worker[] = [];
    try {
      runTasksDatabaseMigrations(db);
      db.exec(`DELETE FROM tasks_schema_migration;
        INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model)
        VALUES('old','* * * * *','正文','ws','/ws',1,2,'proxy/model');
        CREATE TABLE migration_probe(value INTEGER);
        CREATE TRIGGER count_conversion AFTER UPDATE OF model_selection ON automations
        BEGIN INSERT INTO migration_probe VALUES(1); END;`);
      const compiled = await build({
        entryPoints: [resolve("packages/services/src/session/tasksDatabase/migrations.ts")],
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        alias: { "#src": resolve("packages/services/src") },
      });
      const gate = new SharedArrayBuffer(4);
      for (let index = 0; index < 2; index++) {
        workers.push(
          new Worker(
            `${compiled.outputFiles[0]!.text}
          const { parentPort, workerData } = require('node:worker_threads');
          const database = new (require('node:sqlite').DatabaseSync)(workerData.path, { timeout: 5000 });
          const gate = new Int32Array(workerData.gate);
          parentPort.postMessage('ready');
          Atomics.wait(gate, 0, 0);
          module.exports.runTasksDatabaseMigrations(database);
          database.close();`,
            { eval: true, workerData: { path, gate } },
          ),
        );
      }
      const exits = workers.map((worker) => once(worker, "exit"));
      await Promise.all(workers.map((worker) => once(worker, "message")));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      expect(await Promise.all(exits)).toEqual([[0], [0]]);
      expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toHaveLength(3);
      expect(db.prepare("SELECT * FROM migration_probe").all()).toHaveLength(1);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
