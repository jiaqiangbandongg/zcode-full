import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PROVIDER_READINESS_HISTORY_SESSION_ID,
  seedProviderReadinessHistoryFixture,
} from "./provider-readiness-history-fixture.js";

export const TASK_INDEX_ROW_AUTHORITY_TOTAL = 25;
export const TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_ID = "sess_e2e_task_index_only_24";
export const TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_TITLE =
  "E2E_TASK_INDEX_ONLY_24 无摘要持久任务";
export const TASK_INDEX_ROW_AUTHORITY_TASK_IDS = [
  PROVIDER_READINESS_HISTORY_SESSION_ID,
  ...Array.from(
    { length: TASK_INDEX_ROW_AUTHORITY_TOTAL - 1 },
    (_, index) => `sess_e2e_task_index_only_${String(index + 1).padStart(2, "0")}`,
  ),
];

interface SeedTaskIndexRowAuthorityFixtureOptions {
  cliEntryPoint: string;
  e2eHomeDir: string;
  workspacePath: string;
}

/**
 * 预置 25 个 tasks-index 行，但只让其中 1 个拥有真实 CLI session summary。
 *
 * Bug 根因：旧列表把 sessions-index snapshot 当成左表，摘要缺失的持久 task 会在冷启动时
 * 消失。这里用真 SQLite 构造 1 个有摘要、24 个无摘要的等价类，验证行集合只由 tasks-index 决定。
 */
export function seedTaskIndexRowAuthorityFixture(
  options: SeedTaskIndexRowAuthorityFixtureOptions,
): void {
  seedProviderReadinessHistoryFixture(options);

  // Node 当前内置 SQLite 只提供 DatabaseSync；fixture 在 Electron/Host 启动前执行，
  // 没有与产品进程争用句柄，写完立即关闭。
  const database = new DatabaseSync(join(options.e2eHomeDir, ".zcode", "v2", "tasks-index.sqlite"));
  const insert = database.prepare(`
    INSERT INTO tasks (
      workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
      provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
      created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden,
      searchable_text, meta_json
    ) VALUES (?, ?, null, ?, ?, ?, 'glm', 'build', 'missing-model', null, null,
      null, ?, ?, null, 0, 0, 0, 1, ?, ?)
  `);
  const baseTimestamp = Date.now() - 120_000;

  database.exec("begin immediate");
  try {
    for (let index = 1; index < TASK_INDEX_ROW_AUTHORITY_TOTAL; index += 1) {
      const taskId = TASK_INDEX_ROW_AUTHORITY_TASK_IDS[index];
      if (!taskId) {
        throw new Error(`task row authority fixture 缺少第 ${index} 个 taskId`);
      }
      const isMissingSummarySentinel = taskId === TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_ID;
      const title = isMissingSummarySentinel
        ? TASK_INDEX_ROW_AUTHORITY_MISSING_SUMMARY_TITLE
        : `E2E_TASK_INDEX_ONLY_${String(index).padStart(2, "0")} 无摘要持久任务`;
      const status = isMissingSummarySentinel ? "running" : "completed";
      const createdAt = baseTimestamp - index * 1_000;
      const updatedAt = createdAt + 500;
      const meta = {
        taskId,
        traceId: `trace_${taskId}`,
        title,
        titleOverridden: true,
        workspacePath: options.workspacePath,
        createdAt,
        updatedAt,
        mode: "build",
        model: "missing-model",
        provider: "glm",
        status,
      };

      insert.run(
        options.workspacePath,
        options.workspacePath,
        taskId,
        title,
        status,
        createdAt,
        updatedAt,
        title,
        JSON.stringify(meta),
      );
    }
    database.exec("commit");
  } catch (error) {
    database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }
}
