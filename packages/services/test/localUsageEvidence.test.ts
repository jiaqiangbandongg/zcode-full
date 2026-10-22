import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHasExistingLocalTask,
  hasAnyAgentSessionRow,
  resolveAgentSessionDbPath,
} from "../src/onboarding/localUsageEvidence.js";

/**
 * 老用户使用证据判定（docs/onboarding-record-spec.md §4 2026-10 修订）：
 * tasks-index 是同步器的衍生投影，登录瞬间的判定可能早于回填（线上误弹案例：
 * 空索引把老用户判成新用户）。判定必须 OR 上磁盘级证据；agent 会话证据按 CLI
 * 的解析链定位会话库并查 session 表行数（评审 CR-01：路径有 env/config 覆盖、
 * 默认按 homedir 展开，cli/sessions 是工作流输出目录不得作为证据）；证据"读
 * 不了"（非 ENOENT）不得当成"没有"，必须上抛由 UI 保守判不弹（评审 CR-02）。
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-usage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFactory(
  indexTasks: unknown[],
  hasAgentSessionRow: boolean,
  legacySessionsDir: string,
) {
  return createHasExistingLocalTask({
    listIndexTasks: vi.fn(async () => indexTasks),
    hasAgentSessionRow: vi.fn(async () => hasAgentSessionRow),
    resolveLegacyTaskSessionsDir: () => legacySessionsDir,
  });
}

function createSessionDb(dbPath: string, rows: number): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session (id TEXT)");
  const insert = db.prepare("INSERT INTO session (id) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`s${i}`);
  db.close();
}

describe("createHasExistingLocalTask", () => {
  it("索引有行即存量用户（短路，不查会话库）", async () => {
    const emptyDir = makeTempDir();
    const check = createFactory([{ id: "t1" }], false, emptyDir);
    await expect(check()).resolves.toBe(true);
  });

  it("索引为空但 agent 会话库有行 → 存量用户（索引回填时序缺陷的回归）", async () => {
    const emptyDir = makeTempDir();
    const check = createFactory([], true, emptyDir);
    await expect(check()).resolves.toBe(true);
  });

  it("索引与会话库皆空，旧版任务快照非空 → 存量用户", async () => {
    const legacySessionsDir = makeTempDir();
    writeFileSync(join(legacySessionsDir, "task-1.json"), "{}");
    writeFileSync(join(legacySessionsDir, "task-2.deleted.json"), "{}");
    const check = createFactory([], false, legacySessionsDir);
    await expect(check()).resolves.toBe(true);
  });

  it("三源全空（目录不存在/为空）→ 新用户", async () => {
    const check = createFactory([], false, join(makeTempDir(), "not-exist"));
    await expect(check()).resolves.toBe(false);
    const emptyDir = makeTempDir();
    const checkEmpty = createFactory([], false, emptyDir);
    await expect(checkEmpty()).resolves.toBe(false);
  });

  it("索引查询异常时上抛，由上层保守判不弹", async () => {
    const check = createHasExistingLocalTask({
      listIndexTasks: vi.fn(async () => {
        throw new Error("index db locked");
      }),
      hasAgentSessionRow: vi.fn(async () => true),
      resolveLegacyTaskSessionsDir: () => makeTempDir(),
    });
    await expect(check()).rejects.toThrow("index db locked");
  });
});

describe("hasAnyAgentSessionRow", () => {
  it("session 表有行 → true", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    createSessionDb(dbPath, 2);
    await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(true);
  });

  it("session 表存在但为空 → false（空库不得误判存量）", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    createSessionDb(dbPath, 0);
    await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(false);
  });

  it("库文件存在但无 session 表 → false", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other (a TEXT)");
    db.close();
    await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(false);
  });

  it("库文件不存在（ENOENT）→ false", async () => {
    await expect(
      hasAnyAgentSessionRow(join(makeTempDir(), "not-exist", "db.sqlite")),
    ).resolves.toBe(false);
  });

  it("WAL 未 checkpoint 的行对只读连接可见（写连接保持打开）", async () => {
    // 评审 SG-01：模拟 CLI 持有写连接、行还在 WAL 中未合并的真实场景——
    // 这正是线上误弹案例里"判定时刻数据在 WAL"的形态。
    const dbPath = join(makeTempDir(), "db.sqlite");
    const writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE session (id TEXT)");
    writer.prepare("INSERT INTO session (id) VALUES (?)").run("s1");
    try {
      await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(true);
    } finally {
      writer.close();
    }
  });

  // Windows libuv 把 ENOTDIR 归一化为 ENOENT，该分支在 POSIX CI 上验证；
  // Windows 下同一语义由"库文件损坏 → 上抛"用例覆盖。
  (process.platform === "win32" ? it.skip : it)(
    "父路径是文件（ENOTDIR）→ 上抛而非静默无证据（评审 CR-02 回归）",
    async () => {
      const filePath = join(makeTempDir(), "occupied");
      writeFileSync(filePath, "not a dir");
      await expect(hasAnyAgentSessionRow(join(filePath, "db.sqlite"))).rejects.toThrow();
    },
  );

  it("库文件损坏 → 上抛（读不了 ≠ 没有，交由 UI 保守判不弹）", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    writeFileSync(dbPath, "definitely not a sqlite file");
    await expect(hasAnyAgentSessionRow(dbPath)).rejects.toThrow();
  });
});

describe("resolveAgentSessionDbPath（评审三轮 CR-01：不复制解析规则，无法确定按未知跳过）", () => {
  function freshHome(): { HOME: string; USER_CONFIG: string } {
    const HOME = join(makeTempDir(), "home");
    return { HOME, USER_CONFIG: join(HOME, ".zcode", "cli", "config.json") };
  }

  it("env 单别名：绝对路径原样可用", async () => {
    const customDb = join(makeTempDir(), "custom.sqlite");
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB_PATH: customDb },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(customDb);
  });

  it("env ~/ 值按 homedir 展开", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB: "~/session-alt.sqlite" },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(join(HOME, "session-alt.sqlite"));
  });

  it("双别名并存按 env 键序取后者（与 CLI env adapter 覆盖顺序一致）", async () => {
    const dbA = join(makeTempDir(), "a.sqlite");
    const dbB = join(makeTempDir(), "b.sqlite");
    const { HOME, USER_CONFIG } = freshHome();
    // PATH 别名后出现 → PATH 胜出
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB: dbA, ZCODE_SESSION_DB_PATH: dbB },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(dbB);
    // 交换插入顺序 → DB 别名胜出（固定优先级会在这里产生偏差，评审实证）
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB_PATH: dbB, ZCODE_SESSION_DB: dbA },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(dbA);
  });

  it("env 相对路径 → null（CLI 按工作区 cwd 解析，host 无法镜像）", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB_PATH: "history/session.sqlite" },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBeNull();
  });

  it("user config（home 默认位置）storage.sessionDbPath 覆盖，~/ 展开", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    mkdirSync(join(HOME, ".zcode", "cli"), { recursive: true });
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: "~/data/s.sqlite" } }));
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).resolves.toBe(join(HOME, "data", "s.sqlite"));
  });

  it("user config 相对路径 → null（不按 host cwd 猜测）", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    mkdirSync(join(HOME, ".zcode", "cli"), { recursive: true });
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: "db/rel.sqlite" } }));
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).resolves.toBeNull();
  });

  it("user config 不存在 → 默认 ~/.zcode/cli/db/db.sqlite（homedir 展开）", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).resolves.toBe(join(HOME, ".zcode", "cli", "db", "db.sqlite"));
  });

  it("默认 userConfigPath 钉住为 {home}/.zcode/cli/config.json（评审 SG-01）", async () => {
    // host 侧默认字面量与 CLI file-config.adapter 的 DEFAULT_BASE_DIR 是两处独立
    // 硬编码，漂移时镜像策略失效；此处显式锁定 host 侧拼装结果。
    const { HOME } = freshHome();
    const readPaths: string[] = [];
    await resolveAgentSessionDbPath({
      env: {},
      homedirPath: HOME,
      readConfigFile: async (path) => {
        readPaths.push(path);
        return "{}";
      },
    });
    expect(readPaths).toEqual([join(HOME, ".zcode", "cli", "config.json")]);
  });

  it("user config 非 ENOENT 读取失败 → 上抛", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    const eaccs = Object.assign(new Error("read denied"), { code: "EACCES" });
    await expect(
      resolveAgentSessionDbPath({
        env: {},
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
        readConfigFile: async () => {
          throw eaccs;
        },
      }),
    ).rejects.toThrow(eaccs);
  });

  it("user config 非法 JSON → 上抛", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    mkdirSync(join(HOME, ".zcode", "cli"), { recursive: true });
    writeFileSync(USER_CONFIG, "{broken json");
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).rejects.toThrow();
  });
});
