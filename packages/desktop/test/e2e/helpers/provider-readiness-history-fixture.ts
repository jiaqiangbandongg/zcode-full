import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PROVIDER_READINESS_HISTORY_SESSION_ID =
  "sess_e2e_provider_readiness_history";
export const PROVIDER_READINESS_HISTORY_TITLE =
  "E2E_PROVIDER_READINESS_HISTORY 可读历史";
export const PROVIDER_READINESS_HISTORY_USER_TEXT =
  "E2E_PROVIDER_READINESS_HISTORY_USER 已持久化的用户消息";
export const PROVIDER_READINESS_HISTORY_ASSISTANT_TEXT =
  "E2E_PROVIDER_READINESS_HISTORY_ASSISTANT 已持久化的助手回复";
export const CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID = "context-provider";
export const CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME =
  "Context Window Cold Resume E2E";
export const CONTEXT_WINDOW_COLD_RESUME_MODEL_ID = "model-1m";
export const CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS = 1_000_000;
export const CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS = 64_000;

export interface SeedProviderReadinessHistoryFixtureOptions {
  cliEntryPoint: string;
  e2eHomeDir: string;
  history?: ProviderReadinessHistoryFixture;
  workspacePath: string;
}

export interface ProviderReadinessHistoryFixture {
  assistantInputTokens: number;
  assistantOutputTokens: number;
  assistantText: string;
  modelId: string;
  runtimeProviderId: string;
  sessionId: string;
  taskProviderId: string;
  title: string;
  userText: string;
}

const DEFAULT_PROVIDER_READINESS_HISTORY_FIXTURE: ProviderReadinessHistoryFixture =
  {
    assistantInputTokens: 0,
    assistantOutputTokens: 0,
    assistantText: PROVIDER_READINESS_HISTORY_ASSISTANT_TEXT,
    modelId: "missing-model",
    runtimeProviderId: "missing-provider",
    sessionId: PROVIDER_READINESS_HISTORY_SESSION_ID,
    taskProviderId: "glm",
    title: PROVIDER_READINESS_HISTORY_TITLE,
    userText: PROVIDER_READINESS_HISTORY_USER_TEXT,
  };

/**
 * 同时预置 Agent session DB 与 App tasks-index。
 *
 * 修复原因：正式任务不会脱离 App 独立写入 CLI；旧 fixture 只写 session DB，构造了产品中
 * 不存在的 CLI-only 历史，并错误依赖 sessions-index 反向补齐 tasks-index。这里让两个事实源
 * 保持同一 task：tasks-index 提供侧栏 membership，真实只读订阅负责读取 CLI 历史正文。
 */
export function seedProviderReadinessHistoryFixture(
  options: SeedProviderReadinessHistoryFixtureOptions,
): void {
  const history = options.history ?? DEFAULT_PROVIDER_READINESS_HISTORY_FIXTURE;
  execFileSync(
    process.execPath,
    [
      options.cliEntryPoint,
      "--cwd",
      options.workspacePath,
      "app-server",
      "--stdio",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: options.e2eHomeDir,
        USERPROFILE: options.e2eHomeDir,
        ZCODE_DATA_BASE_DIR: options.e2eHomeDir,
      },
      input: "",
      timeout: 30_000,
      windowsHide: true,
    },
  );

  const databasePath = join(
    options.e2eHomeDir,
    ".zcode",
    "cli",
    "db",
    "db.sqlite",
  );
  if (!existsSync(databasePath)) {
    throw new Error(
      `provider readiness history fixture 没有初始化 CLI DB: ${databasePath}`,
    );
  }

  const database = new DatabaseSync(databasePath);
  let timestamps: ProviderReadinessHistoryTimestamps;
  try {
    timestamps = writeHistorySession(database, options.workspacePath, history);
  } finally {
    database.close();
  }
  writeTaskIndex(options, timestamps, history);
}

interface ProviderReadinessHistoryTimestamps {
  createdAt: number;
  completedAt: number;
}

function writeHistorySession(
  database: DatabaseSync,
  workspacePath: string,
  history: ProviderReadinessHistoryFixture,
): ProviderReadinessHistoryTimestamps {
  const createdAt = Date.now() - 60_000;
  const assistantCreatedAt = createdAt + 1_000;
  const completedAt = assistantCreatedAt + 500;
  const workspaceHash = createHash("sha256")
    .update(workspacePath)
    .digest("hex")
    .slice(0, 12);
  const userMessageId = `msg_user_${history.sessionId}`;
  const assistantMessageId = `msg_assistant_${history.sessionId}`;

  database.exec("begin immediate");
  try {
    // 修复原因：本地 sessions-index 以 directory 查询并显式要求 workspace_id IS NULL；
    // 只有远程工作区才把 workspaceIdentity 写进该列，不能拿路径 hash 伪造本地 identity。
    database
      .prepare(
        `insert into session (
          id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
          title, title_source, title_message_id, version, share_url, summary_additions,
          summary_deletions, summary_files, summary_diffs, revert, permission, time_created,
          time_updated, time_title_updated, time_compacting, time_archived
        ) values (?, ?, null, null, ?, 'interactive', ?, ?, ?, ?, 'custom', null, 'e2e', null,
          null, null, null, null, null, ?, ?, ?, ?, null, null)`,
      )
      .run(
        history.sessionId,
        `e2e-provider-readiness-${workspaceHash}`,
        `trace_${history.sessionId}`,
        history.sessionId,
        workspacePath,
        workspacePath,
        history.title,
        JSON.stringify({ defaultMode: "build" }),
        createdAt,
        completedAt,
        createdAt,
      );

    insertMessage(database, {
      data: {
        agent: "zcode-agent",
        content: history.userText,
        model: {
          modelID: history.modelId,
          providerID: history.runtimeProviderId,
        },
        role: "user",
        time: { created: createdAt },
      },
      id: userMessageId,
      sessionId: history.sessionId,
      timeCreated: createdAt,
      timeUpdated: createdAt,
    });
    insertPart(database, {
      data: {
        text: history.userText,
        time: { end: createdAt, start: createdAt },
        type: "text",
      },
      id: `part_user_${history.sessionId}`,
      messageId: userMessageId,
      sessionId: history.sessionId,
      timestamp: createdAt,
    });

    insertMessage(database, {
      data: {
        agent: "zcode-agent",
        content: history.assistantText,
        cost: 0,
        finish: "stop",
        mode: "build",
        modelID: history.modelId,
        parentID: userMessageId,
        path: { cwd: workspacePath, root: workspacePath },
        providerID: history.runtimeProviderId,
        role: "assistant",
        time: { completed: completedAt, created: assistantCreatedAt },
        tokens: {
          cache: { read: 0, write: 0 },
          input: history.assistantInputTokens,
          output: history.assistantOutputTokens,
          reasoning: 0,
        },
      },
      id: assistantMessageId,
      sessionId: history.sessionId,
      timeCreated: assistantCreatedAt,
      timeUpdated: completedAt,
    });
    insertPart(database, {
      data: {
        text: history.assistantText,
        time: { end: completedAt, start: assistantCreatedAt },
        type: "text",
      },
      id: `part_assistant_${history.sessionId}`,
      messageId: assistantMessageId,
      sessionId: history.sessionId,
      timestamp: assistantCreatedAt,
    });
    database.exec("commit");
    return { createdAt, completedAt };
  } catch (error) {
    database.exec("rollback");
    throw error;
  }
}

function writeTaskIndex(
  options: SeedProviderReadinessHistoryFixtureOptions,
  timestamps: ProviderReadinessHistoryTimestamps,
  history: ProviderReadinessHistoryFixture,
): void {
  const appConfigDir = join(options.e2eHomeDir, ".zcode", "v2");
  mkdirSync(appConfigDir, { recursive: true });
  const database = new DatabaseSync(join(appConfigDir, "tasks-index.sqlite"));
  const meta = {
    taskId: history.sessionId,
    traceId: `trace_${history.sessionId}`,
    title: history.title,
    titleOverridden: true,
    workspacePath: options.workspacePath,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.completedAt,
    mode: "default",
    model: history.modelId,
    provider: history.taskProviderId,
    status: "completed",
  };

  try {
    // fixture 在 Host 启动前落盘；字段与 TaskIndexRepo 当前 schema 保持一致，Host 随后会
    // 幂等创建其余索引和分组表。这里不借 sessions-index baseline 生成 membership。
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        task_status TEXT,
        provider TEXT,
        mode TEXT NOT NULL DEFAULT 'build',
        model TEXT,
        migration_source TEXT,
        forked_from_task_id TEXT,
        cron_automation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        unread_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0,
        searchable_text TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (workspace_key, task_id)
      );
    `);
    database
      .prepare(
        `INSERT INTO tasks (
          workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
          provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
          created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden,
          searchable_text, meta_json
        ) VALUES (?, ?, null, ?, ?, 'completed', ?, 'default', ?, null, null,
          null, ?, ?, null, 0, 0, 0, 1, ?, ?)`,
      )
      .run(
        options.workspacePath,
        options.workspacePath,
        history.sessionId,
        history.title,
        history.taskProviderId,
        history.modelId,
        timestamps.createdAt,
        timestamps.completedAt,
        `${history.userText}\n${history.assistantText}`,
        JSON.stringify(meta),
      );
  } finally {
    database.close();
  }
}

function insertMessage(
  database: DatabaseSync,
  input: {
    data: Record<string, unknown>;
    id: string;
    sessionId: string;
    timeCreated: number;
    timeUpdated: number;
  },
): void {
  database
    .prepare(
      "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.sessionId,
      input.timeCreated,
      input.timeUpdated,
      JSON.stringify(input.data),
    );
}

function insertPart(
  database: DatabaseSync,
  input: {
    data: Record<string, unknown>;
    id: string;
    messageId: string;
    sessionId: string;
    timestamp: number;
  },
): void {
  database
    .prepare(
      "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.messageId,
      input.sessionId,
      input.timestamp,
      input.timestamp,
      JSON.stringify(input.data),
    );
}
