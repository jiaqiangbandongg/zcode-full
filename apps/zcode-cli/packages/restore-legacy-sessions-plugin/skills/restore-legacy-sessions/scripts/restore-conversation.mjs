#!/usr/bin/env node
/**
 * Restore a single legacy ACP-era conversation snapshot into the new ZCode stores.
 *
 * Usage:
 *   restore-conversation.mjs --snapshot <path> [--task-index <path>] [--cli-db <path>]
 *
 * Options:
 *   --snapshot <path>   Path to the legacy snapshot JSON file (required)
 *   --task-index <path> Task index sqlite path. Default: ~/.zcode/v2/tasks-index.sqlite
 *   --cli-db <path>     New ZCode session sqlite path. Default: ~/.zcode/cli/db/db.sqlite
 *   --dry-run           Print what would be done without writing
 */

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const originalEmitWarning = process.emitWarning;
process.emitWarning = function filterSqliteExperimentalWarning(warning, ...args) {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return originalEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmitWarning;

const ZCODE_PROVIDER = "glm";
const defaultTaskIndexPath = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
const defaultCliDbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

function parseArgs(argv) {
  const args = {
    snapshot: null,
    taskIndexPath: defaultTaskIndexPath,
    cliDbPath: defaultCliDbPath,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    const next = argv[++i];
    if (!next) throw new Error(`Missing value for ${item}`);
    if (item === "--snapshot") args.snapshot = next;
    else if (item === "--task-index") args.taskIndexPath = next;
    else if (item === "--cli-db") args.cliDbPath = next;
    else throw new Error(`Unknown option: ${item}`);
  }

  if (!args.snapshot) throw new Error("--snapshot is required");
  if (!existsSync(args.snapshot)) throw new Error(`Snapshot not found: ${args.snapshot}`);
  return args;
}

function ensureExistingDb(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} is not a populated sqlite file: ${path}`);
  }
}

function backupDb(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.bak-${stamp}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function projectIdFromPath(workspacePath) {
  // 保持和现有 CLI session project_id 约定一致。
  return "proj_" + workspacePath.replace(/^\//, "").replace(/\//g, "-");
}

function workspaceKey(workspacePath, workspaceIdentity) {
  return (workspaceIdentity || "").trim() || workspacePath;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function jsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function jsonText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function messageContent(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content === undefined || message.content === null
      ? ""
      : String(message.content);
}

function messageCompletedAt(message, messageTimestamp) {
  return typeof message.timestamp === "number"
    ? message.timestamp + (optionalNumber(message.durationMs) ?? 0)
    : messageTimestamp;
}

function legacyToolName(tool) {
  const raw = jsonObject(tool.raw);
  const meta = jsonObject(raw._meta);
  const claudeCode = jsonObject(meta.claudeCode);
  return (
    optionalString(claudeCode.toolName) ||
    optionalString(tool.toolName) ||
    optionalString(tool.name) ||
    optionalString(tool.kind) ||
    optionalString(tool.title) ||
    "legacy_tool"
  );
}

function legacyToolTitle(tool, toolName) {
  return optionalString(tool.title) || toolName;
}

function legacyToolCallId(messageId, toolIndex, tool) {
  return (
    optionalString(tool.id) ||
    optionalString(tool.callID) ||
    optionalString(tool.callId) ||
    `call_legacy_${messageId}_${toolIndex}`
  );
}

function legacyToolMetadata(tool) {
  return removeUndefined({
    legacyRestore: true,
    legacyKind: optionalString(tool.kind),
    legacyStatus: optionalString(tool.status),
  });
}

function buildToolPartData(tool, messageId, toolIndex, messageTimestamp, completedAt) {
  const toolName = legacyToolName(tool);
  const input = jsonObject(tool.input);
  const metadata = legacyToolMetadata(tool);
  const status = optionalString(tool.status) || "completed";
  const startedAt = optionalNumber(tool.startedAt) ?? messageTimestamp;
  const endedAt = optionalNumber(tool.completedAt) ?? completedAt;
  let state;

  // Bugfix: CLI session-store 持久化的是 contracts 形状，tool 时间必须放在 state.time。
  // 如果直接写 protocol 的 startedAt/completedAt，app-server 映射 session/read 时会读不到 state.time 而失败。
  if (status === "running") {
    state = {
      status: "running",
      input,
      title: legacyToolTitle(tool, toolName),
      metadata,
      time: { start: startedAt },
    };
  } else if (status === "pending") {
    state = {
      status: "pending",
      input,
      raw: jsonText(tool.raw || tool),
    };
  } else if (status === "failed" || status === "error" || status === "denied") {
    state = {
      status: "error",
      input,
      error: jsonText(tool.error || tool.output || status),
      metadata,
      time: { start: startedAt, end: endedAt },
    };
  } else {
    state = {
      status: "completed",
      input,
      output: jsonText(tool.output),
      title: legacyToolTitle(tool, toolName),
      metadata,
      time: { start: startedAt, end: endedAt },
    };
  }

  return {
    type: "tool",
    callID: legacyToolCallId(messageId, toolIndex, tool),
    tool: toolName,
    state,
  };
}

function buildTextPartData(text, messageTimestamp, completedAt) {
  return {
    type: "text",
    text,
    time: {
      start: messageTimestamp,
      end: completedAt,
    },
  };
}

function buildReasoningPartData(text, messageTimestamp, completedAt) {
  return {
    type: "reasoning",
    text,
    time: {
      start: messageTimestamp,
      end: completedAt,
    },
  };
}

function buildPartDataList(message, messageId, messageTimestamp) {
  const content = messageContent(message);
  const completedAt = messageCompletedAt(message, messageTimestamp);
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const persistedParts = Array.isArray(message.parts) ? message.parts : [];
  const partDataList = [];

  if (message.role === "assistant" && persistedParts.length > 0) {
    for (const part of persistedParts) {
      if (part?.type === "content" && typeof part.content === "string" && part.content.length > 0) {
        partDataList.push(buildTextPartData(part.content, messageTimestamp, completedAt));
      } else if (
        part?.type === "thought" &&
        typeof part.content === "string" &&
        part.content.length > 0
      ) {
        partDataList.push(buildReasoningPartData(part.content, messageTimestamp, completedAt));
      } else if (part?.type === "tool-call" && Number.isInteger(part.toolIndex)) {
        const tool = tools[part.toolIndex];
        if (tool) {
          partDataList.push(
            buildToolPartData(tool, messageId, part.toolIndex, messageTimestamp, completedAt),
          );
        }
      }
    }
  } else {
    const thought = optionalString(message.thought);
    if (message.role === "assistant" && thought) {
      partDataList.push(buildReasoningPartData(thought, messageTimestamp, completedAt));
    }
    if (content.length > 0) {
      partDataList.push(buildTextPartData(content, messageTimestamp, completedAt));
    }
    for (const [toolIndex, tool] of tools.entries()) {
      partDataList.push(
        buildToolPartData(tool, messageId, toolIndex, messageTimestamp, completedAt),
      );
    }
  }

  const hasVisibleText = partDataList.some(
    (part) => (part.type === "text" || part.type === "reasoning") && part.text.length > 0,
  );
  if (!hasVisibleText && content.length > 0) {
    partDataList.push(buildTextPartData(content, messageTimestamp, completedAt));
  }
  return partDataList;
}

function buildRestorePlan(snapshotPath) {
  const raw = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const meta = raw.meta || {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];

  const legacyTaskId = String(meta.taskId || basename(snapshotPath, ".json"));
  const acpSessionId = optionalString(meta.acpSessionId) || "";
  const restoredTaskId = acpSessionId || legacyTaskId;
  const workspacePath = optionalString(meta.workspacePath) || "";
  if (!workspacePath) {
    throw new Error(`Snapshot has no workspacePath: ${snapshotPath}`);
  }

  const workspaceIdentity = optionalString(meta.workspaceIdentity) || "";
  const workspaceHash = basename(dirname(snapshotPath));
  const sourceProvider = optionalString(meta.provider) || "unknown";
  const title = optionalString(meta.title) || "Untitled session";
  const mode = optionalString(meta.mode) || "build";
  const model = optionalString(meta.model) || "";
  const traceId = optionalString(meta.traceId) || `zcode-${restoredTaskId}`;
  const createdAt = optionalNumber(meta.createdAt) ?? Date.now();
  const updatedAt = optionalNumber(meta.updatedAt) ?? createdAt;

  // 旧 ACP provider 只代表来源。恢复后的新 ZCode 任务必须按 glm 写入，否则任务列表会被过滤掉。
  const normalizedMeta = removeUndefined({
    ...meta,
    taskId: restoredTaskId,
    traceId,
    title,
    workspacePath,
    workspaceIdentity: workspaceIdentity || undefined,
    createdAt,
    updatedAt,
    mode,
    model: model || undefined,
    thoughtLevel: optionalString(meta.thoughtLevel),
    runtimeEpoch: optionalNumber(meta.runtimeEpoch),
    provider: ZCODE_PROVIDER,
    legacyTaskId,
    restoredTaskId,
    workspaceHash,
    messageCount: messages.length,
    migrationSource: undefined,
  });

  return {
    snapshotPath,
    raw,
    meta,
    messages,
    legacyTaskId,
    restoredTaskId,
    workspacePath,
    workspaceIdentity,
    workspaceHash,
    workspaceKey: workspaceKey(workspacePath, workspaceIdentity),
    projectId: projectIdFromPath(workspacePath),
    sourceProvider,
    title,
    mode,
    model,
    traceId,
    createdAt,
    updatedAt,
    searchableText: messages.map((message) => String(message.content || "")).join("\n"),
    metaJson: JSON.stringify(normalizedMeta),
  };
}

function printPlan(plan, dryRun) {
  console.log("=== Restoring conversation ===");
  console.log(`  Title:          ${plan.title}`);
  console.log(`  SourceProvider: ${plan.sourceProvider}`);
  console.log(`  RuntimeProvider: ${ZCODE_PROVIDER}`);
  console.log(`  Model:          ${plan.model}`);
  console.log(`  Workspace:      ${plan.workspacePath}`);
  console.log(`  Messages:       ${plan.messages.length}`);
  console.log(`  restoredTaskId: ${plan.restoredTaskId}`);
  console.log(`  legacyTaskId:   ${plan.legacyTaskId}`);
  console.log(`  workspaceHash:  ${plan.workspaceHash}`);
  console.log("  migrationSource: <empty>");
  console.log(`  Dry run:        ${dryRun}`);
  console.log();
}

function writeTaskIndex(taskDb, plan) {
  const upsertTask = taskDb.prepare(`
    INSERT INTO tasks
      (workspace_key, workspace_path, workspace_identity, task_id, title,
       task_status, provider, mode, model, migration_source, forked_from_task_id,
       created_at, updated_at, unread_at, meta_json, searchable_text)
    VALUES
      (@workspace_key, @workspace_path, @workspace_identity, @task_id, @title,
       @task_status, @provider, @mode, @model, NULL, @forked_from_task_id,
       @created_at, @updated_at, @unread_at, @meta_json, @searchable_text)
    ON CONFLICT(workspace_key, task_id) DO UPDATE SET
      workspace_path = excluded.workspace_path,
      workspace_identity = excluded.workspace_identity,
      title = CASE
        WHEN tasks.title_overridden = 1 THEN tasks.title
        ELSE excluded.title
      END,
      task_status = excluded.task_status,
      provider = excluded.provider,
      mode = excluded.mode,
      model = excluded.model,
      migration_source = NULL,
      forked_from_task_id = excluded.forked_from_task_id,
      created_at = MIN(tasks.created_at, excluded.created_at),
      updated_at = MAX(tasks.updated_at, excluded.updated_at),
      unread_at = tasks.unread_at,
      searchable_text = CASE
        WHEN tasks.updated_at > excluded.updated_at THEN tasks.searchable_text
        ELSE excluded.searchable_text
      END,
      meta_json = excluded.meta_json
  `);

  upsertTask.run({
    workspace_key: plan.workspaceKey,
    workspace_path: plan.workspacePath,
    workspace_identity: plan.workspaceIdentity || null,
    task_id: plan.restoredTaskId,
    title: plan.title,
    task_status: optionalString(plan.meta.status) || null,
    provider: ZCODE_PROVIDER,
    mode: plan.mode,
    model: plan.model || null,
    forked_from_task_id: optionalString(plan.meta.forkedFromTaskId) || null,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    unread_at: optionalNumber(plan.meta.unreadAt) ?? null,
    meta_json: plan.metaJson,
    searchable_text: plan.searchableText,
  });
}

function writeSession(cliDb, plan) {
  const upsertSession = cliDb.prepare(`
    INSERT INTO session
      (id, project_id, workspace_id, slug, directory, path, title, version,
       time_created, time_updated, task_type, title_source, trace_id)
    VALUES
      (@id, @project_id, @workspace_id, @slug, @directory, @path, @title, @version,
       @time_created, @time_updated, @task_type, @title_source, @trace_id)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      workspace_id = excluded.workspace_id,
      slug = excluded.slug,
      directory = excluded.directory,
      path = excluded.path,
      title = CASE
        WHEN session.title_source = 'custom' THEN session.title
        ELSE excluded.title
      END,
      version = excluded.version,
      time_created = MIN(session.time_created, excluded.time_created),
      time_updated = MAX(session.time_updated, excluded.time_updated),
      task_type = excluded.task_type,
      trace_id = COALESCE(session.trace_id, excluded.trace_id)
  `);

  upsertSession.run({
    id: plan.restoredTaskId,
    project_id: plan.projectId,
    workspace_id: plan.workspaceHash,
    slug: plan.restoredTaskId,
    directory: plan.workspacePath,
    path: plan.workspacePath,
    title: plan.title,
    version: "0.14.5",
    time_created: plan.createdAt,
    time_updated: plan.updatedAt,
    task_type: "interactive",
    title_source: "first_input",
    trace_id: plan.traceId,
  });
}

function writeMessages(cliDb, plan) {
  const insertMessage = cliDb.prepare(`
    INSERT OR REPLACE INTO message
      (id, session_id, time_created, time_updated, data)
    VALUES
      (@id, @session_id, @time_created, @time_updated, @data)
  `);
  const insertPart = cliDb.prepare(`
    INSERT OR REPLACE INTO part
      (id, message_id, session_id, time_created, time_updated, data)
    VALUES
      (@id, @message_id, @session_id, @time_created, @time_updated, @data)
  `);
  const deleteLegacyParts = cliDb.prepare(`
    DELETE FROM part
    WHERE session_id = @session_id AND id LIKE @id_prefix
  `);

  let partCount = 0;
  let latestUserMessageId = "";
  deleteLegacyParts.run({
    session_id: plan.restoredTaskId,
    id_prefix: `part_legacy_${plan.restoredTaskId}_%`,
  });
  for (const [index, message] of plan.messages.entries()) {
    const messageTimestamp = optionalNumber(message.timestamp) ?? plan.updatedAt;
    const completedAt = messageCompletedAt(message, messageTimestamp);
    const messageId = `msg_legacy_${plan.restoredTaskId}_${index}`;
    const role = message.role === "assistant" ? "assistant" : "user";
    const baseMessageData = {
      role,
      time: removeUndefined({
        created: messageTimestamp,
        completed: role === "assistant" ? completedAt : undefined,
      }),
      agent: "zcode-agent",
    };
    // Bugfix: 恢复脚本必须写当前消息契约；继续生成旧消息身份字段会迫使正常读取链依赖 legacy codec，
    // 并让新恢复的数据再次成为待迁移数据。
    const messageData =
      role === "assistant"
        ? {
            ...baseMessageData,
            content: message.content,
            modelId: message.model || plan.model || "unknown",
            providerId: ZCODE_PROVIDER,
            mode: plan.mode,
            path: {
              cwd: plan.workspacePath,
              root: plan.workspacePath,
            },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: "stop",
            ...(latestUserMessageId ? { parentID: latestUserMessageId } : {}),
            ...(Array.isArray(message.tools) && message.tools.length > 0
              ? {
                  toolCalls: message.tools.map((tool, toolIndex) => ({
                    id: `tool_${messageId}_${toolIndex}`,
                    toolName: tool.title || "",
                    kind: tool.kind || "other",
                    status: tool.status || "completed",
                    input: tool.input || {},
                    output: tool.output || "",
                    ...(tool.raw ? { raw: tool.raw } : {}),
                  })),
                }
              : {}),
            ...(message.characterCount !== undefined
              ? { characterCount: message.characterCount }
              : {}),
            ...(message.turnIndex !== undefined ? { turnIndex: message.turnIndex } : {}),
          }
        : {
            ...baseMessageData,
            content: message.content,
            modelSelection: {
              providerId: ZCODE_PROVIDER,
              modelId: message.model || plan.model || "unknown",
            },
            // 旧 Reader 无条件访问 User.model；显式导入绕过普通 Writer，也必须补最小对象防止回滚打不开正文。
            // 不复制模型身份：当前选择只有 modelSelection，旧版允许模型失效但不能读取抛错。
            model: {},
            ...(message.characterCount !== undefined
              ? { characterCount: message.characterCount }
              : {}),
            ...(message.turnIndex !== undefined ? { turnIndex: message.turnIndex } : {}),
          };

    insertMessage.run({
      id: messageId,
      session_id: plan.restoredTaskId,
      time_created: messageTimestamp,
      time_updated: messageTimestamp,
      data: JSON.stringify(removeUndefined(messageData)),
    });

    // Bugfix: 详情页从 part 表还原可见正文；只有 message.data.content 会出现任务可打开但历史区空白。
    const partDataList = buildPartDataList(message, messageId, messageTimestamp);
    for (const [partIndex, partData] of partDataList.entries()) {
      const partTimestamp = messageTimestamp + partIndex;
      insertPart.run({
        id: `part_legacy_${plan.restoredTaskId}_${String(index).padStart(4, "0")}_${String(
          partIndex,
        ).padStart(4, "0")}`,
        message_id: messageId,
        session_id: plan.restoredTaskId,
        time_created: partTimestamp,
        time_updated: partTimestamp,
        data: JSON.stringify(partData),
      });
      partCount++;
    }

    if (role === "user") {
      latestUserMessageId = messageId;
    }
  }
  return { messageCount: plan.messages.length, partCount };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildRestorePlan(args.snapshot);
  printPlan(plan, args.dryRun);

  if (args.dryRun) {
    console.log("Dry run mode: no writes performed.");
    return;
  }

  ensureExistingDb(args.taskIndexPath, "Task index");
  ensureExistingDb(args.cliDbPath, "CLI DB");
  const taskBackupPath = backupDb(args.taskIndexPath);
  const cliBackupPath = backupDb(args.cliDbPath);
  console.log(`Backed up task index: ${taskBackupPath}`);
  console.log(`Backed up CLI DB:     ${cliBackupPath}`);

  const taskDb = new DatabaseSync(args.taskIndexPath);
  const cliDb = new DatabaseSync(args.cliDbPath);
  let taskInTx = false;
  let cliInTx = false;

  try {
    taskDb.exec("BEGIN IMMEDIATE");
    taskInTx = true;
    cliDb.exec("BEGIN IMMEDIATE");
    cliInTx = true;

    console.log("[1/2] Writing task index...");
    writeTaskIndex(taskDb, plan);
    console.log(`  tasks row ready: ${plan.restoredTaskId}`);

    console.log("[2/2] Writing CLI session DB...");
    writeSession(cliDb, plan);
    const writeResult = writeMessages(cliDb, plan);
    console.log(`  message rows ready: ${writeResult.messageCount}`);
    console.log(`  part rows ready:    ${writeResult.partCount}`);

    taskDb.exec("COMMIT");
    taskInTx = false;
    cliDb.exec("COMMIT");
    cliInTx = false;

    console.log();
    console.log("=== Restore complete ===");
  } catch (error) {
    if (taskInTx) {
      try {
        taskDb.exec("ROLLBACK");
      } catch {}
    }
    if (cliInTx) {
      try {
        cliDb.exec("ROLLBACK");
      } catch {}
    }
    console.error("Restore failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    taskDb.close();
    cliDb.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
