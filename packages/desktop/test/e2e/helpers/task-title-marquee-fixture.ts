import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveE2EStorageRoot } from "./e2e-runtime-paths.js";
import { seedProviderReadinessHistoryFixture } from "./provider-readiness-history-fixture.js";

export const TASK_TITLE_MARQUEE_SHORT_ID = "sess_e2e_title_short";
export const TASK_TITLE_MARQUEE_LONG_ID = "sess_e2e_title_long";
export const TASK_TITLE_MARQUEE_PINNED_ID = "sess_e2e_title_pinned";
export const TASK_TITLE_MARQUEE_SHORT_TITLE = "E2E 短标题";
export const TASK_TITLE_MARQUEE_LONG_TITLE =
  "E2E_TASK_TITLE_MARQUEE 这是一个足够长的任务名称，用于稳定验证侧栏溢出 mask 与整行 hover 走马灯循环";

interface SeedTaskTitleMarqueeFixtureOptions {
  cliEntryPoint: string;
  e2eHomeDir: string;
  workspacePath: string;
}

export function resolveTaskTitleMarqueeDatabasePath(e2eHomeDir: string): string {
  return join(resolveE2EStorageRoot(e2eHomeDir), "v2", "tasks-index.sqlite");
}

/** 在 Host 打开 tasks-index 前准备短标题、普通长标题与置顶标题。 */
export async function seedTaskTitleMarqueeFixture(
  options: SeedTaskTitleMarqueeFixtureOptions,
): Promise<void> {
  await seedProviderReadinessHistoryFixture(options);
  // Bug 根因：fixture 若自行拼接 storage profile，上游回滚开发态目录后会继续
  // 写到已废弃的 `.zcode-dev`。统一复用 runtime path helper，跟随当前 E2E
  // 固定 `.zcode` 合同；Node 当前仅提供同步 SQLite API，这里仍只在 Host 启动前执行。
  const database = new DatabaseSync(resolveTaskTitleMarqueeDatabasePath(options.e2eHomeDir));
  const insertTask = database.prepare(`
    INSERT OR REPLACE INTO tasks (
      workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
      provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
      created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden,
      searchable_text, meta_json
    ) VALUES (?, ?, null, ?, ?, 'completed', 'glm', 'build', 'missing-model', null, null,
      null, ?, ?, null, ?, 0, 0, 1, ?, ?)
  `);
  const now = Date.now();
  const tasks = [
    {
      id: TASK_TITLE_MARQUEE_SHORT_ID,
      title: TASK_TITLE_MARQUEE_SHORT_TITLE,
      pinned: 0,
    },
    {
      id: TASK_TITLE_MARQUEE_LONG_ID,
      title: TASK_TITLE_MARQUEE_LONG_TITLE,
      pinned: 0,
    },
    {
      id: TASK_TITLE_MARQUEE_PINNED_ID,
      title: `${TASK_TITLE_MARQUEE_LONG_TITLE} PINNED`,
      pinned: 1,
    },
  ];

  database.exec("begin immediate");
  try {
    tasks.forEach((task, index) => {
      const timestamp = now - index * 1_000;
      const meta = {
        taskId: task.id,
        traceId: `trace_${task.id}`,
        title: task.title,
        titleOverridden: true,
        workspacePath: options.workspacePath,
        createdAt: timestamp,
        updatedAt: timestamp,
        mode: "build",
        model: "missing-model",
        provider: "glm",
        status: "completed",
      };
      insertTask.run(
        options.workspacePath,
        options.workspacePath,
        task.id,
        task.title,
        timestamp,
        timestamp,
        task.pinned,
        task.title,
        JSON.stringify(meta),
      );
    });
    database.exec("commit");
  } catch (error) {
    database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }
}
