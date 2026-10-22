import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "#src/session/sourceServerWorkspaceAliasRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { seedTaskIndex } from "./helpers/taskIndexFixture.js";

const workspacePath = "/srv/project";
const canonicalKey = "remote:ssh:canonical.example:22:dev:/srv/project";
const sourceKey = "remote:ssh:source.example:22:dev:/srv/project";
let root: string;
let taskDbPath: string;
let index: TaskIndexRepo;
let aliases: SourceServerWorkspaceAliasRepo;

function task(key: string, patch: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "shared-task",
    traceId: "trace-shared",
    title: "Shared task",
    workspacePath,
    workspaceIdentity: key,
    createdAt: 10,
    updatedAt: 100,
    mode: "default",
    status: "completed",
    ...patch,
  };
}

/** CLI 事实与组织态由夹具分别写入；正文索引随展示投影一起落库。 */
async function seed(meta: ZCodeTaskMeta, searchableText?: string): Promise<void> {
  await seedTaskIndex(index, { meta, searchableText });
}

/**
 * 把夹具退回项目化前的旧库形态（host_id/cli_* 为空、带旧 ACP wrapper 列），再重开索引走
 * 真实启动链：项目化按旧列初始化 cli_*，随后旧 ACP ID 合并只抬高 wrapperKey 下的 updated_at。
 */
async function restartFromPreProjectionLegacyDb(wrapperKey: string): Promise<void> {
  index.close();
  const db = new DatabaseSync(taskDbPath);
  try {
    db.exec(`UPDATE tasks SET host_id = NULL, cli_title = NULL, cli_title_source = NULL,
      cli_created_at = NULL, cli_updated_at = NULL, cli_last_outcome = NULL, cli_deleted = NULL,
      handoff_pending = 0`);
    db.exec("ALTER TABLE tasks ADD COLUMN acp_session_id TEXT");
    db.prepare(
      "UPDATE tasks SET acp_session_id = 'shared-task' WHERE workspace_key = ? AND task_id = 'legacy-wrapper'",
    ).run(wrapperKey);
  } finally {
    db.close();
  }
  await index.ensureReady();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-alias-projections-"));
  taskDbPath = join(root, "tasks-index.sqlite");
  index = new TaskIndexRepo(undefined, undefined, taskDbPath);
  await index.ensureReady();
  aliases = new SourceServerWorkspaceAliasRepo({
    taskDbPath,
    sessionDbPath: join(root, "absent-session.sqlite"),
    backupRoot: join(root, "backups"),
  });
  // 固定已发布 canonical，任务自身的新旧顺序不应改变线路选举。
  await aliases.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: canonicalKey });
});

afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("Source Server duplicate task projections", () => {
  it.each(["source-newer", "canonical-newer", "same-time"] as const)(
    "projects merged metadata using the newer record: %s",
    async (order) => {
      await seed(
        task(canonicalKey, {
          updatedAt: order === "canonical-newer" ? 600 : 100,
          status: "error",
          model: "model-old",
        }),
      );
      await seed(
        task(sourceKey, {
          title: "Source title",
          createdAt: 5,
          updatedAt: order === "same-time" ? 100 : 500,
          status: "completed",
          provider: "glm",
          mode: "plan",
          model: "model-new",
          migrationSource: "claudeCode",
          forkedFromTaskId: "parent-task",
          cronAutomationId: "automation-1",
          offPeakTaskId: "off-peak-1",
        }),
      );

      await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

      const sourceWins = order !== "canonical-newer";
      const expectedMeta = {
        status: sourceWins ? "completed" : "error",
        provider: "glm",
        mode: sourceWins ? "plan" : "default",
        model: sourceWins ? "model-new" : "model-old",
        migrationSource: "claudeCode",
        forkedFromTaskId: "parent-task",
        cronAutomationId: "automation-1",
        offPeakTaskId: "off-peak-1",
      };
      const db = new DatabaseSync(taskDbPath);
      try {
        const row = db
          .prepare(`SELECT task_status, provider, mode, model, migration_source,
          forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json
          FROM tasks WHERE workspace_key = ? AND task_id = 'shared-task'`)
          .get(canonicalKey)!;
        expect(JSON.parse(String(row.meta_json))).toMatchObject(expectedMeta);
        expect(row).toMatchObject({
          task_status: expectedMeta.status,
          provider: expectedMeta.provider,
          mode: expectedMeta.mode,
          model: expectedMeta.model,
          migration_source: expectedMeta.migrationSource,
          forked_from_task_id: expectedMeta.forkedFromTaskId,
          cron_automation_id: expectedMeta.cronAutomationId,
          off_peak_task_id: expectedMeta.offPeakTaskId,
        });
      } finally {
        db.close();
      }
      // 项目化索引从 cli_* 列投影标题、时间与状态；只合并旧列会让较新的 CLI 事实丢失。
      await expect(index.getTaskMeta(task(canonicalKey))).resolves.toMatchObject({
        ...expectedMeta,
        title: sourceWins ? "Source title" : "Shared task",
        createdAt: 5,
        updatedAt: order === "canonical-newer" ? 600 : order === "same-time" ? 100 : 500,
      });
      await expect(aliases.resolveCanonicalWorkspaceKey({ workspacePath })).resolves.toEqual({
        canonicalKey,
        mergedKeys: [],
      });
    },
  );

  // Bug 原因：旧 ACP ID 合并只抬高 updated_at、不改 cli_*，按 updated_at 选 CLI 胜者会把
  // 较旧的状态/标题配上较新的 cli_updated_at。CLI 事实只能按自身 cli_updated_at 裁决。
  it.each([
    ["source", sourceKey, canonicalKey],
    ["canonical", canonicalKey, sourceKey],
  ] as const)(
    "keeps the newer CLI facts when the legacy ACP merge inflates the %s index time",
    async (_side, olderKey, newerKey) => {
      await seed(task(newerKey, { title: "Newer title", updatedAt: 200, status: "error" }));
      await seed(task(olderKey, { title: "Older title", updatedAt: 100, status: "completed" }));
      await seed(task(olderKey, { taskId: "legacy-wrapper", updatedAt: 300 }));
      await restartFromPreProjectionLegacyDb(olderKey);
      const db = new DatabaseSync(taskDbPath);
      try {
        // 前置条件：真实启动迁移链已让较旧一侧的两种时间分叉。
        expect(
          db
            .prepare(
              "SELECT updated_at, cli_updated_at FROM tasks WHERE workspace_key = ? AND task_id = 'shared-task'",
            )
            .get(olderKey),
        ).toEqual({ updated_at: 300, cli_updated_at: 100 });
      } finally {
        db.close();
      }

      await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

      await expect(index.getTaskMeta(task(canonicalKey))).resolves.toMatchObject({
        title: "Newer title",
        updatedAt: 200,
        status: "error",
      });
    },
  );

  it("does not let a side without CLI facts replace the other side's facts", async () => {
    await seed(task(canonicalKey, { title: "Canonical title", status: "error" }));
    await seed(task(sourceKey, { updatedAt: 500 }));
    const db = new DatabaseSync(taskDbPath);
    try {
      // 只有身份与组织态、尚无 CLI 事实的行，旧索引时间再新也不能清空对方的标题和状态。
      db.prepare(
        "UPDATE tasks SET cli_title = NULL, cli_title_source = NULL, cli_created_at = NULL, cli_updated_at = NULL, cli_last_outcome = NULL, cli_deleted = NULL WHERE workspace_key = ?",
      ).run(sourceKey);
    } finally {
      db.close();
    }

    await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

    await expect(index.getTaskMeta(task(canonicalKey))).resolves.toMatchObject({
      title: "Canonical title",
      updatedAt: 100,
      status: "error",
    });
  });

  it("retains an older optional field when the newer metadata omits it", async () => {
    await seed(task(canonicalKey, { model: "retained-model" }));
    await seed(task(sourceKey, { updatedAt: 500 }));

    await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

    await expect(index.getTaskMeta(task(canonicalKey))).resolves.toMatchObject({
      model: "retained-model",
    });
    const db = new DatabaseSync(taskDbPath);
    try {
      expect(
        db.prepare("SELECT model FROM tasks WHERE workspace_key = ?").get(canonicalKey),
      ).toEqual({ model: "retained-model" });
    } finally {
      db.close();
    }
  });

  it("preserves legacy cron and off-peak markers stored only in projection columns", async () => {
    await seed(task(canonicalKey));
    await seed(task(sourceKey, { updatedAt: 500 }));
    const db = new DatabaseSync(taskDbPath);
    try {
      // 旧版本回填先更新索引列，后续 snapshot 同步才补齐 meta_json。
      db.prepare(
        "UPDATE tasks SET cron_automation_id = 'legacy-auto', off_peak_task_id = 'legacy-off-peak' WHERE workspace_key = ?",
      ).run(sourceKey);
    } finally {
      db.close();
    }

    await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

    await expect(index.getTaskMeta(task(canonicalKey))).resolves.toMatchObject({
      cronAutomationId: "legacy-auto",
      offPeakTaskId: "legacy-off-peak",
    });
  });

  it.each(["cron_automation_id", "off_peak_task_id", "forked_from_task_id"] as const)(
    "rejects incompatible legacy %s markers before deleting either row",
    async (column) => {
      await seed(task(canonicalKey));
      await seed(task(sourceKey));
      const db = new DatabaseSync(taskDbPath);
      try {
        const { workspaceIdentity: _identity, ...legacyMeta } = task(canonicalKey);
        // 两份旧 meta 相同，但索引已分别回填不同身份；相同 JSON 不能绕过身份预检。
        db.prepare("UPDATE tasks SET meta_json = ?").run(JSON.stringify(legacyMeta));
        db.prepare(`UPDATE tasks SET ${column} = ? WHERE workspace_key = ?`).run(
          "target-id",
          canonicalKey,
        );
        db.prepare(`UPDATE tasks SET ${column} = ? WHERE workspace_key = ?`).run(
          "source-id",
          sourceKey,
        );
        const before = db.prepare("SELECT * FROM tasks ORDER BY workspace_key").all();

        await expect(aliases.resolveCanonicalWorkspaceKey({ workspacePath })).rejects.toMatchObject(
          {
            code: "workspace-task-identity-conflict",
          },
        );

        expect(db.prepare("SELECT * FROM tasks ORDER BY workspace_key").all()).toEqual(before);
        expect(
          db.prepare("SELECT canonical_key FROM workspace_alias WHERE path = ?").get(workspacePath),
        ).toEqual({ canonical_key: canonicalKey });
      } finally {
        db.close();
      }
    },
  );

  it.each([false, true])(
    "preserves searchable content (canonical indexed: %s)",
    async (indexed) => {
      await seed(task(canonicalKey), indexed ? "canonicalbody" : undefined);
      await seed(task(sourceKey), "sourcebody");
      await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

      const result = await index.queryTaskList({
        workspaceScopes: [{ workspacePath, workspaceIdentity: canonicalKey }],
        kind: "normal",
        search: indexed ? "canonicalbody" : "sourcebody",
      });
      expect(result.items.map((item) => item.taskId)).toEqual(["shared-task"]);
      const db = new DatabaseSync(taskDbPath);
      try {
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE workspace_key = ?").get(sourceKey),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it.each([
    [undefined, 450, 450],
    [500, 450, 500],
    [400, 450, 450],
  ])("retains unread markers %s / %s", async (canonicalUnread, sourceUnread, expected) => {
    await seed(task(canonicalKey, { unreadAt: canonicalUnread }));
    await seed(task(sourceKey, { unreadAt: sourceUnread }));
    await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

    await expect(index.getTaskMeta(task(canonicalKey))).resolves.toMatchObject({
      unreadAt: expected,
    });
    const db = new DatabaseSync(taskDbPath);
    try {
      expect(
        db
          .prepare("SELECT unread_at, last_unread_at FROM tasks WHERE workspace_key = ?")
          .get(canonicalKey),
      ).toEqual({ unread_at: expected, last_unread_at: expected });
    } finally {
      db.close();
    }
  });

  it("keeps the source unread watermark after that marker was cleared", async () => {
    await seed(task(canonicalKey));
    await seed(task(sourceKey, { unreadAt: 450 }));
    await expect(
      index.clearTaskUnreadIfMatches({ ...task(sourceKey), expectedUnreadAt: 450 }),
    ).resolves.toMatchObject({ cleared: true });

    await aliases.resolveCanonicalWorkspaceKey({ workspacePath });

    const db = new DatabaseSync(taskDbPath);
    try {
      expect(
        db
          .prepare("SELECT unread_at, last_unread_at FROM tasks WHERE workspace_key = ?")
          .get(canonicalKey),
      ).toEqual({ unread_at: null, last_unread_at: 450 });
    } finally {
      db.close();
    }
  });
});
