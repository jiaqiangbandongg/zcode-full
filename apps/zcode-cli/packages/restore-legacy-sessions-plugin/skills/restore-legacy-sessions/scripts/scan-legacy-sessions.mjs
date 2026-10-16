#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const originalEmitWarning = process.emitWarning;
process.emitWarning = function filterSqliteExperimentalWarning(warning, ...args) {
  // 只读扫描依赖 node:sqlite 访问本地 DB；过滤该实验提示，避免污染给用户选择用的表格。
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return originalEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmitWarning;

const defaultLegacyDir = join(homedir(), ".zcode", "v2", "sessions");
const defaultTaskIndexPath = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
const defaultCliDbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

function printUsage() {
  console.log(`Usage:
  scan-legacy-sessions.mjs summary [--json]
  scan-legacy-sessions.mjs agents [--json]
  scan-legacy-sessions.mjs workspaces --agent <provider> [--json]
  scan-legacy-sessions.mjs conversations --agent <provider> --workspace <path> [--query <text>] [--limit <n>] [--json]

Options:
  --legacy-dir <path>   Legacy snapshot root. Default: ${defaultLegacyDir}
  --task-index <path>   Task index sqlite path. Default: ${defaultTaskIndexPath}
  --cli-db <path>       New ZCode session sqlite path. Default: ${defaultCliDbPath}
  --agent <provider>    Filter by provider, such as glm, claude, codex, opencode.
  --workspace <path>    Filter by exact workspace path.
  --query <text>        Filter conversations by title, ids, or visible message text.
  --conversation <id>   Filter by restored task id, legacy task id, or ACP session id.
  --limit <n>           Conversation row limit. Default: 30.
  --json                Print JSON instead of Markdown tables.
`);
}

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "summary",
    legacyDir: defaultLegacyDir,
    taskIndexPath: defaultTaskIndexPath,
    cliDbPath: defaultCliDbPath,
    json: false,
    limit: 30,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") {
      args.json = true;
      continue;
    }
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${item}`);
    }
    index += 1;
    if (item === "--legacy-dir") args.legacyDir = next;
    else if (item === "--task-index") args.taskIndexPath = next;
    else if (item === "--cli-db") args.cliDbPath = next;
    else if (item === "--agent") args.agent = next;
    else if (item === "--workspace") args.workspace = next;
    else if (item === "--query") args.query = next;
    else if (item === "--conversation") args.conversation = next;
    else if (item === "--limit") args.limit = Number.parseInt(next, 10);
    else throw new Error(`Unknown option: ${item}`);
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = 30;
  return args;
}

function collectJsonFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const workspaceDir of readdirSync(root)) {
    const dirPath = join(root, workspaceDir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const fileName of readdirSync(dirPath)) {
      if (!fileName.endsWith(".json") || fileName.endsWith(".deleted.json")) continue;
      files.push(join(dirPath, fileName));
    }
  }
  return files;
}

function readSnapshot(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    const legacyTaskId = String(meta.taskId || basename(filePath, ".json"));
    const acpSessionId = typeof meta.acpSessionId === "string" ? meta.acpSessionId : "";
    const restoredTaskId = acpSessionId || legacyTaskId;
    const workspacePath = typeof meta.workspacePath === "string" ? meta.workspacePath : "";
    const provider = typeof meta.provider === "string" ? meta.provider : "unknown";
    const firstUser = messages.find((message) => message?.role === "user");
    const title =
      typeof meta.title === "string" && meta.title.trim()
        ? meta.title.trim()
        : summarizeText(firstUser?.content) || "Untitled session";
    const createdAt = finiteNumber(meta.createdAt) ?? firstTimestamp(messages) ?? 0;
    const updatedAt = finiteNumber(meta.updatedAt) ?? lastTimestamp(messages) ?? createdAt;
    const visibleText = messages.map((message) => String(message?.content ?? "")).join("\n");
    return {
      filePath,
      workspaceHash: basename(join(filePath, "..")),
      legacyTaskId,
      acpSessionId,
      restoredTaskId,
      workspacePath,
      workspaceIdentity:
        typeof meta.workspaceIdentity === "string" ? meta.workspaceIdentity : undefined,
      provider,
      model: typeof meta.model === "string" ? meta.model : undefined,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      userMessageCount: messages.filter((message) => message?.role === "user").length,
      assistantMessageCount: messages.filter((message) => message?.role === "assistant").length,
      visibleText,
    };
  } catch (error) {
    return {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstTimestamp(messages) {
  for (const message of messages) {
    const timestamp = finiteNumber(message?.timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function lastTimestamp(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timestamp = finiteNumber(messages[index]?.timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function summarizeText(value) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function openDatabase(path) {
  if (!existsSync(path)) return null;
  if (statSync(path).size === 0) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function attachStoreStatus(candidates, taskIndexPath, cliDbPath) {
  const taskIndexDb = openDatabase(taskIndexPath);
  const cliDb = openDatabase(cliDbPath);
  const taskByRestored = prepareOrNull(
    taskIndexDb,
    "select count(*) as count from tasks where workspace_path = ? and task_id = ?",
  );
  const taskByLegacy = prepareOrNull(
    taskIndexDb,
    "select count(*) as count from tasks where workspace_path = ? and task_id = ?",
  );
  const cliBySession = prepareOrNull(cliDb, "select count(*) as count from session where id = ?");

  for (const candidate of candidates) {
    if (candidate.error) continue;
    const taskIndexRestored = countResult(
      taskByRestored?.get(candidate.workspacePath, candidate.restoredTaskId),
    );
    const taskIndexLegacy = countResult(
      taskByLegacy?.get(candidate.workspacePath, candidate.legacyTaskId),
    );
    const cliSession = countResult(cliBySession?.get(candidate.restoredTaskId));
    candidate.store = {
      cliDb: cliSession > 0 ? "present" : "missing",
      taskIndex:
        taskIndexRestored > 0 ? "present" : taskIndexLegacy > 0 ? "legacy-task-id" : "missing",
    };
    candidate.restoreState = restoreState(candidate.store);
  }

  taskIndexDb?.close();
  cliDb?.close();
}

function prepareOrNull(db, sql) {
  if (!db) return null;
  try {
    return db.prepare(sql);
  } catch {
    // 目的地 DB 可能刚被备份/清空；扫描阶段只把缺表视为 missing，不能创建或修复。
    return null;
  }
}

function countResult(row) {
  return typeof row?.count === "number" ? row.count : 0;
}

function restoreState(store) {
  const cliPresent = store.cliDb === "present";
  const taskPresent = store.taskIndex === "present";
  if (cliPresent && taskPresent) return "ready";
  if (!cliPresent && taskPresent) return "needs-cli-db";
  if (cliPresent && !taskPresent) return "needs-task-index";
  return "needs-full-import";
}

function filterCandidates(candidates, args) {
  const query = args.query?.toLowerCase();
  const conversation = args.conversation?.toLowerCase();
  return candidates.filter((candidate) => {
    if (candidate.error) return false;
    if (args.agent && args.agent !== "all" && candidate.provider !== args.agent) return false;
    if (args.workspace && candidate.workspacePath !== args.workspace) return false;
    if (
      conversation &&
      ![candidate.restoredTaskId, candidate.legacyTaskId, candidate.acpSessionId]
        .filter(Boolean)
        .some((value) => value.toLowerCase() === conversation)
    ) {
      return false;
    }
    if (!query) return true;
    const haystack = [
      candidate.provider,
      candidate.workspacePath,
      candidate.title,
      candidate.restoredTaskId,
      candidate.legacyTaskId,
      candidate.acpSessionId,
      candidate.visibleText,
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key) ?? [];
    existing.push(item);
    map.set(key, existing);
  }
  return map;
}

function summarizeGroups(candidates, keyFn) {
  return [...groupBy(candidates, keyFn).entries()]
    .map(([key, items]) => ({
      key,
      count: items.length,
      workspaces: new Set(items.map((item) => item.workspacePath)).size,
      ready: items.filter((item) => item.restoreState === "ready").length,
      needsCliDb: items.filter((item) => item.restoreState === "needs-cli-db").length,
      needsTaskIndex: items.filter((item) => item.restoreState === "needs-task-index").length,
      needsFullImport: items.filter((item) => item.restoreState === "needs-full-import").length,
      latestUpdatedAt: Math.max(...items.map((item) => item.updatedAt || 0)),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function markdownTable(headers, rows) {
  const header = `| ${headers.map(escapeCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function formatTime(ms) {
  if (!ms) return "";
  return new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function printAgents(candidates, json) {
  const rows = summarizeGroups(candidates, (item) => item.provider);
  if (json) return printJson(rows);
  console.log(
    markdownTable(
      ["agent", "conversations", "workspaces", "ready", "needs-cli-db", "needs-task-index", "needs-full-import"],
      rows.map((row) => [
        row.key,
        row.count,
        row.workspaces,
        row.ready,
        row.needsCliDb,
        row.needsTaskIndex,
        row.needsFullImport,
      ]),
    ),
  );
}

function printWorkspaces(candidates, json) {
  const rows = summarizeGroups(candidates, (item) => item.workspacePath);
  if (json) return printJson(rows);
  console.log(
    markdownTable(
      ["workspace", "conversations", "ready", "needs-cli-db", "needs-task-index", "needs-full-import", "latest"],
      rows.map((row) => [
        row.key,
        row.count,
        row.ready,
        row.needsCliDb,
        row.needsTaskIndex,
        row.needsFullImport,
        formatTime(row.latestUpdatedAt),
      ]),
    ),
  );
}

function printConversations(candidates, args) {
  const rows = [...candidates]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, args.limit);
  if (args.json) return printJson(rows.map(stripVisibleText));
  console.log(
    markdownTable(
      ["#", "state", "agent", "title", "messages", "updated", "restoredTaskId", "legacyTaskId"],
      rows.map((row, index) => [
        index + 1,
        row.restoreState,
        row.provider,
        row.title,
        row.messageCount,
        formatTime(row.updatedAt),
        row.restoredTaskId,
        row.legacyTaskId,
      ]),
    ),
  );
}

function printSummary(candidates, invalid, json) {
  const payload = {
    total: candidates.length,
    invalid: invalid.length,
    byAgent: summarizeGroups(candidates, (item) => item.provider),
    byState: summarizeGroups(candidates, (item) => item.restoreState),
  };
  if (json) return printJson(payload);
  console.log(`Total legacy conversations: ${payload.total}`);
  if (payload.invalid > 0) console.log(`Invalid snapshots: ${payload.invalid}`);
  console.log("\nBy agent:");
  printAgents(candidates, false);
  console.log("\nBy restore state:");
  console.log(
    markdownTable(
      ["state", "conversations", "workspaces"],
      payload.byState.map((row) => [row.key, row.count, row.workspaces]),
    ),
  );
}

function stripVisibleText(candidate) {
  const { visibleText, ...rest } = candidate;
  return rest;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const raw = collectJsonFiles(args.legacyDir).map(readSnapshot);
  const invalid = raw.filter((candidate) => candidate.error);
  const valid = raw.filter((candidate) => !candidate.error);
  attachStoreStatus(valid, args.taskIndexPath, args.cliDbPath);
  const filtered = filterCandidates(valid, args);

  if (args.command === "summary") printSummary(filtered, invalid, args.json);
  else if (args.command === "agents") printAgents(filtered, args.json);
  else if (args.command === "workspaces") printWorkspaces(filtered, args.json);
  else if (args.command === "conversations") printConversations(filtered, args);
  else {
    throw new Error(`Unknown command: ${args.command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exitCode = 1;
}
