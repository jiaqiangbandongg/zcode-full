import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 引导资格的"本机使用证据"判定（docs/onboarding-record-spec.md §4）。
 *
 * 缺陷背景（2026-10 线上误弹）：原实现只查 tasks-index，而索引是 session 同步器的
 * 衍生投影——同步器在 agent/provider 就绪后才回填历史任务，判定却在登录完成、主界面
 * 挂载时执行，早于回填。索引为空被当成"新用户"，老用户被误弹引导（取证确认判定时
 * 刻全部历史任务行还在 WAL 中未落库）。
 *
 * 证据源（任一命中即存量用户）：
 * 1. tasks-index 投影（含 tombstone，清空过任务列表的存量用户不失去资格）；
 * 2. agent 会话库——只查**可确定性镜像**的定位结果（评审三轮 CR-01：不复制 CLI
 *    解析规则，无法确定按"未知"跳过）：
 *    - env ZCODE_SESSION_DB_PATH / ZCODE_SESSION_DB（双别名并存时按 env 键序取
 *      后者，与 CLI env adapter 的赋值顺序一致）；
 *    - ~/.zcode/cli/config.json 的 storage.sessionDbPath（CLI createConfig 默认
 *      位置在 home，不随 App dataBaseDir 迁移）；
 *    - 默认 ~/.zcode/cli/db/db.sqlite（homedir 展开）。
 *    值为相对路径时按未知跳过本证据源（CLI 按各工作区 cwd 解析，host 无法镜像）；
 *    project 级配置覆盖同样视为未知（已知限制，spec §4）。
 *    只读查询 session 表至少一行。
 * 3. 旧版任务快照目录（v2/sessions，含 .deleted.json）。
 *
 * 禁止的替代判据（评审两轮教训）：tasks-index 文件存在性、会话库文件存在性（空库/
 * 刚建库不代表有会话）、cli/sessions 目录（是工作流文件输出）。"读不了"（非 ENOENT）
 * 一律上抛由 UI 保守判不弹——读不了 ≠ 没有。
 */

const DEFAULT_SESSION_DB_PATH = "~/.zcode/cli/db/db.sqlite";

/** 目录非空。仅 ENOENT 视为"无证据"；其他异常上抛，由 UI 侧保守判不弹。 */
async function hasDirEntry(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/**
 * CLI 侧 `~/` 由 resolvePath 展开 homedir，host 可镜像；绝对路径原样可用。
 * 相对路径的解析基准是 agent 进程的工作区 cwd（各工作区不同），host 无法镜像。
 */
function resolveMirroredSessionDbPath(path: string, home: string): string | null {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return path;
  return null;
}

/** env 双别名按 env 键序取最后出现的值（与 CLI env adapter 的覆盖顺序一致）。 */
function pickEnvSessionDbPath(env: NodeJS.ProcessEnv): string | undefined {
  let picked: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if ((key === "ZCODE_SESSION_DB_PATH" || key === "ZCODE_SESSION_DB") && value !== undefined) {
      picked = value;
    }
  }
  return picked?.trim() || undefined;
}

export interface ResolveAgentSessionDbPathOptions {
  /** 默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()。 */
  homedirPath?: string;
  /** 默认 ~/.zcode/cli/config.json（CLI createConfig 的默认 user config 位置）。 */
  userConfigPath?: string;
  readConfigFile?: (path: string) => Promise<string>;
}

/**
 * 解析 agent 会话库路径。返回 null 表示"无法确定"（相对路径或 project 级覆盖）——
 * 调用方跳过会话证据源，而不是猜测默认路径（评审三轮 CR-01：相对路径按 agent
 * 工作区 cwd 解析、project 配置按 workspace 叠加，host 均无法镜像）。配置读取/
 * 解析失败（非 ENOENT）仍上抛：读不出 ≠ 没有。
 */
export async function resolveAgentSessionDbPath(
  options: ResolveAgentSessionDbPathOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const home = options.homedirPath ?? homedir();
  const readConfigFile = options.readConfigFile ?? ((path) => readFile(path, "utf-8"));

  const fromEnv = pickEnvSessionDbPath(env);
  if (fromEnv) return resolveMirroredSessionDbPath(fromEnv, home);

  // CLI createConfig 的默认 user config 位置在 home（~/.zcode/cli/config.json），
  // 与 App dataBaseDir 无关（评审三轮 CR-01 第 1 条，zcode-protocol-entrypoint 实证）。
  const userConfigPath = options.userConfigPath ?? join(home, ".zcode", "cli", "config.json");
  let raw: string;
  try {
    raw = await readConfigFile(userConfigPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return resolveMirroredSessionDbPath(DEFAULT_SESSION_DB_PATH, home);
    }
    throw cause;
  }
  const parsed = JSON.parse(raw) as { storage?: { sessionDbPath?: string } };
  const configured = parsed.storage?.sessionDbPath?.trim();
  if (configured) {
    const mirrored = resolveMirroredSessionDbPath(configured, home);
    if (mirrored === null) return null;
    return mirrored;
  }
  return resolveMirroredSessionDbPath(DEFAULT_SESSION_DB_PATH, home);
}

/**
 * Agent 会话库只读检查：session 表存在且至少一行。库文件不存在 = 从未持久化会话 =
 * 无证据（stat 保留错误码，仅 ENOENT 视为无证据——评审 CR-02：existsSync 会把
 * EACCES/ENOTDIR 吞成 false）；WAL 未 checkpoint 的行对只读连接同样可见，与回填
 * 时序无关；其他打开/查询失败上抛，由 UI 保守判不弹。node:sqlite 仅提供同步 API，
 * 与 TaskIndexRepo 同一先例。
 */
export async function hasAnyAgentSessionRow(dbPath: string): Promise<boolean> {
  try {
    await stat(dbPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // busy_timeout：与运行中的 CLI（WAL 持有方）并发时短暂等待而不是立即 BUSY。
    db.exec("PRAGMA busy_timeout = 2000");
    const hasTable = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session') AS has",
      )
      .get();
    if (!hasTable?.has) return false;
    return Boolean(db.prepare("SELECT 1 FROM session LIMIT 1").get());
  } finally {
    db.close();
  }
}

export interface CreateHasExistingLocalTaskOptions {
  /** 设备全局任务索引查询；装配层须传 includeDeleted: true（tombstone 也是使用证据）。 */
  listIndexTasks: () => Promise<unknown[]>;
  /** agent 会话库行查询（组合 resolveAgentSessionDbPath + hasAnyAgentSessionRow）；惰性调用。 */
  hasAgentSessionRow: () => Promise<boolean>;
  /** 旧版任务快照目录（{dataBaseDir}/.zcode/v2/sessions，含 .deleted.json）；惰性解析。 */
  resolveLegacyTaskSessionsDir: () => string;
}

export type HasExistingLocalTask = () => Promise<boolean>;

export function createHasExistingLocalTask(
  options: CreateHasExistingLocalTaskOptions,
): HasExistingLocalTask {
  return async () => {
    if ((await options.listIndexTasks()).length > 0) return true;
    if (await options.hasAgentSessionRow()) return true;
    return hasDirEntry(options.resolveLegacyTaskSessionsDir());
  };
}
