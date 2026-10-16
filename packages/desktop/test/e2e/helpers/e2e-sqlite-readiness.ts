import { DatabaseSync, type SQLInputValue } from "node:sqlite";

interface SqliteReadinessDatabase {
  close: () => void;
  prepare: (sql: string) => {
    get: (...params: SQLInputValue[]) => unknown;
  };
}

interface WaitForSqliteTableOptions {
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  openDatabase?: (databasePath: string) => SqliteReadinessDatabase;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const DEFAULT_SQLITE_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_SQLITE_READINESS_POLL_INTERVAL_MS = 100;

export async function waitForSqliteTable(
  databasePath: string,
  tableName: string,
  options: WaitForSqliteTableOptions = {},
) {
  const delay = options.delay ?? defaultDelay;
  const now = options.now ?? Date.now;
  const openDatabase = options.openDatabase ?? openReadonlyDatabase;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SQLITE_READINESS_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SQLITE_READINESS_TIMEOUT_MS;
  const startedAt = now();
  let lastError = `table ${tableName} 尚未完成 migration`;

  while (now() - startedAt <= timeoutMs) {
    let database: SqliteReadinessDatabase | null = null;
    try {
      // Bug 根因：renderer ready 早于 Agent SQLite migration 完成。只用只读方式探测，
      // 避免 fixture 抢先创建空 db.sqlite，再让 Agent 在错误的初始状态上跑 migration。
      database = openDatabase(databasePath);
      const ready = database
        .prepare("select 1 as ready from sqlite_master where type = 'table' and name = ?")
        .get(tableName);
      if (ready) return;
      lastError = `table ${tableName} 尚未完成 migration`;
    } catch (error) {
      lastError = describeError(error);
    } finally {
      database?.close();
    }

    if (now() - startedAt >= timeoutMs) break;
    await delay(pollIntervalMs);
  }

  throw new Error(
    `SQLite fixture 等待超时: path=${databasePath}, table=${tableName}, lastError=${lastError}`,
  );
}

function openReadonlyDatabase(databasePath: string): SqliteReadinessDatabase {
  // Node 内置 SQLite 当前只提供同步句柄；这里只做一次 sqlite_master 查询并立即关闭，
  // 重试等待本身保持异步，不阻塞事件循环等待文件或 migration。
  return new DatabaseSync(databasePath, { readOnly: true });
}

function defaultDelay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
