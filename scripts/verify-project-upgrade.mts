import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repoRoot, phase, testHome] = process.argv.slice(2);
assert(repoRoot && testHome && phase);
assert(basename(testHome).startsWith("zcode-project-upgrade-"));
for (const key of ["HOME", "USERPROFILE", "ZCODE_DATA_BASE_DIR"])
  assert.equal(
    resolve(process.env[key] ?? ""),
    resolve(testHome),
    "isolated environment required: " + key,
  );
const load = (p: string) => import(pathToFileURL(join(repoRoot!, p)).href);
const { TaskIndexRepo } = await load("packages/services/src/session/taskIndexRepo.ts");
const { SqliteSessionStore } = await load(
  "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts",
);
const cliPath = join(testHome, "cli.sqlite");
await mkdir(testHome, { recursive: true });
const cli = phase.startsWith("old")
  ? new SqliteSessionStore({ dbPath: cliPath })
  : await SqliteSessionStore.open({ dbPath: cliPath });
const repo = new TaskIndexRepo();
await repo.ensureReady();
const cwd = join(testHome, "repo");
const create = async (id: string) => {
  await cli.createSession({
    id,
    projectID: "upgrade-project",
    workspaceID: cwd,
    slug: id,
    directory: cwd,
    path: cwd,
    title: "Title " + id,
    version: "3.12.0",
    time: { created: 100, updated: 200 },
  });
  await repo.syncTaskMeta({
    meta: {
      taskId: id,
      traceId: "trace-" + id,
      title: "Title " + id,
      workspacePath: cwd,
      createdAt: 100,
      updatedAt: 200,
      provider: "glm",
      mode: "default",
      status: "completed",
    },
  });
};
const raw = () => new DatabaseSync(cliPath);
try {
  if (phase === "old-seed") {
    for (const id of ["rename", "delete", "body"]) await create(id);
    await cli.saveMessage({
      id: "body-message",
      sessionID: "body",
      role: "user",
      agent: "zcode-agent",
      model: { providerID: "probe", modelID: "probe" },
      time: { created: 100 },
    });
    await cli.savePart({
      id: "body-part",
      messageID: "body-message",
      sessionID: "body",
      type: "text",
      text: "E2E_UPGRADE_BODY_PRESERVED",
      time: { start: 100, end: 100 },
    });
    const db = raw();
    const ledger = db.prepare("SELECT id,checksum FROM schema_migration ORDER BY id").all();
    db.close();
    await writeFile(join(testHome, "old-ledger.json"), JSON.stringify(ledger));
    console.log("PASS old writers created task index + CLI sessions + body");
  } else if (phase === "upgrade") {
    const db = await repo.getOrganizationDatabase();
    assert(db.prepare("SELECT 1 FROM schema_migration WHERE id='0001_projects'").get());
    const memberships = db
      .prepare("SELECT task_id,project_id,host_id FROM tasks ORDER BY task_id")
      .all();
    assert(memberships.every((r: any) => r.project_id && r.host_id === "local"));
    await writeFile(join(testHome, "memberships.json"), JSON.stringify(memberships));
    await cli.softDeleteSession("body", 456);
    assert(!(await cli.listSessions()).some((s: any) => s.id === "body"));
    console.log("PASS upgrade ledger + first membership + CLI soft delete");
  } else if (phase === "old-write") {
    await cli.updateSession({ id: "rename", title: "CLI old rename", timeUpdated: 901 });
    await repo.updateTaskState({
      workspacePath: cwd,
      taskId: "rename",
      patch: { title: "APP old rename", titleOverridden: true },
    });
    await repo.updateTaskState({ workspacePath: cwd, taskId: "delete", patch: { deleted: true } });
    await create("new-during-downgrade");
    assert((await cli.listSessions()).some((s: any) => s.id === "body"));
    console.log(
      "PASS old repository source reopened new schema, renamed/deleted/created; old list still shows soft-deleted session (accepted)",
    );
  } else if (phase === "reupgrade") {
    const db = await repo.getOrganizationDatabase();
    const rows = db
      .prepare(
        "SELECT task_id,project_id,host_id,handoff_pending,deleted,title FROM tasks ORDER BY task_id",
      )
      .all() as any[];
    const prior = JSON.parse(await readFile(join(testHome, "memberships.json"), "utf8"));
    for (const row of prior)
      assert.equal(rows.find((r) => r.task_id === row.task_id)?.project_id, row.project_id);
    assert.equal(
      rows.find((r) => r.task_id === "new-during-downgrade")?.project_id,
      prior[0].project_id,
    );
    assert.equal(rows.find((r) => r.task_id === "rename")!.handoff_pending & 2, 2);
    assert.equal(rows.find((r) => r.task_id === "delete")!.handoff_pending & 1, 1);
    assert.equal(rows.find((r) => r.task_id === "delete")!.deleted, 1);
    const cdb = raw();
    for (const row of JSON.parse(await readFile(join(testHome, "old-ledger.json"), "utf8")))
      assert.equal(
        cdb.prepare("SELECT checksum FROM schema_migration WHERE id=?").get(row.id)?.checksum,
        row.checksum,
      );
    assert.equal(
      cdb.prepare("SELECT time_deleted FROM session WHERE id='body'").get()?.time_deleted,
      456,
    );
    assert.equal(cdb.prepare("SELECT count(*) AS n FROM message").get()?.n, 1);
    assert.equal(cdb.prepare("SELECT count(*) AS n FROM part").get()?.n, 1);
    assert.match(
      String(cdb.prepare("SELECT data FROM part WHERE id='body-part'").get()?.data),
      /E2E_UPGRADE_BODY_PRESERVED/,
    );
    assert.deepEqual(cdb.prepare("PRAGMA foreign_key_check").all(), []);
    cdb.close();
    console.log(
      "PASS reupgrade kept memberships/checksums/body/FKs and admitted legacy new row + rename/delete intents",
    );
    // 验证真实旧 writer 留下的意图经新 facts owner 交给 CLI；传输端口直接注入 Store，不声称覆盖 stdio。
    const { createTaskFacts } = await load("packages/services/src/task-facts/index.ts");
    const source = {
      async reconcile(_target: unknown, ids: string[]) {
        return {
          sessions: await Promise.all(
            ids.map(async (sessionId: string) => {
              const s = await cli.getSession(sessionId);
              return s
                ? {
                    sessionId,
                    exists: true,
                    deleted: s.time.deleted != null,
                    title: s.title,
                    titleSource: s.titleSource ?? "generated",
                    createdAt: s.time.created,
                    updatedAt: s.time.updated,
                    lastOutcome: s.lastOutcome,
                  }
                : { sessionId, exists: false };
            }),
          ),
        };
      },
      async execute(target: { taskId: string }, intent: { type: string; title?: string }) {
        if (intent.type === "delete") await cli.softDeleteSession(target.taskId);
        else
          await cli.updateSession({
            id: target.taskId,
            title: intent.title,
            titleSource: "custom",
          });
      },
    };
    const facts = createTaskFacts({ store: repo, source, changed: () => {} });
    await facts.reconcile({ workspacePath: cwd }, new Set(), () => true);
    assert.equal((await cli.getSession("rename")).title, "APP old rename");
    assert((await cli.getSession("delete")).time.deleted);
    assert.equal(
      db.prepare("SELECT cli_deleted FROM tasks WHERE task_id='delete'").get()?.cli_deleted,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM tasks WHERE (handoff_pending & 3)<>0").get()?.n,
      0,
    );
    assert.equal(
      (await cli.messages({ sessionID: "body" }))[0].parts[0].text,
      "E2E_UPGRADE_BODY_PRESERVED",
    );
    console.log(
      "PASS new facts owner hands legacy rename/delete intents to CLI and clears acknowledged bits without losing body",
    );
  } else throw new Error("unknown phase");
} finally {
  repo.close();
  cli.close();
}
