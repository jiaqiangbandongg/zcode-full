import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  moveTargetSuffix: undefined as string | undefined,
  promoteCurrentTargetSuffix: undefined as string | undefined,
  promoteTargetSuffix: undefined as string | undefined,
  recoverBackupTargetSuffix: undefined as string | undefined,
  removeTargetSuffix: undefined as string | undefined,
  runtimeManifestNotFoundTargetSuffix: undefined as string | undefined,
  runtimeManifestTargetSuffix: undefined as string | undefined,
  seedLockHeldTargetSuffixes: [] as string[],
  seedLockObservedTimeoutsMs: [] as number[],
}));

vi.mock("../src/app/official-plugin-cache-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/official-plugin-cache-fs.js")>();
  return {
    ...actual,
    removeOfficialPluginCacheDirectory(path: string): void {
      if (faults.removeTargetSuffix && path.endsWith(faults.removeTargetSuffix)) {
        throw exhaustedErrno("EPERM");
      }
      actual.removeOfficialPluginCacheDirectory(path);
    },
    renameOfficialPluginCachePath(
      fromPath: string,
      toPath: string,
      budget: ReturnType<typeof actual.createOfficialPluginCacheRetryBudget>,
    ): void {
      if (
        faults.recoverBackupTargetSuffix &&
        fromPath === `${toPath}.backup` &&
        toPath.endsWith(faults.recoverBackupTargetSuffix)
      ) {
        throw errno("EOWNER");
      }
      if (
        faults.moveTargetSuffix &&
        fromPath.endsWith(faults.moveTargetSuffix) &&
        toPath.startsWith(`${fromPath}.backup-`)
      ) {
        actual.removeOfficialPluginCacheDirectory(fromPath, budget);
        throw errno("ENOENT");
      }
      if (
        faults.promoteCurrentTargetSuffix &&
        fromPath.includes(".tmp-") &&
        toPath.endsWith(faults.promoteCurrentTargetSuffix)
      ) {
        actual.renameOfficialPluginCachePath(fromPath, toPath, budget);
        throw errno("EEXIST");
      }
      if (
        faults.promoteTargetSuffix &&
        fromPath.includes(".tmp-") &&
        toPath.endsWith(faults.promoteTargetSuffix)
      ) {
        throw exhaustedErrno("EPERM");
      }
      actual.renameOfficialPluginCachePath(fromPath, toPath, budget);
    },
    writeTextFileAtomicallyWithRetry(
      path: string,
      contents: string,
      budget: ReturnType<typeof actual.createOfficialPluginCacheRetryBudget>,
    ): void {
      if (
        faults.runtimeManifestNotFoundTargetSuffix &&
        path.endsWith(faults.runtimeManifestNotFoundTargetSuffix)
      ) {
        throw errno("ENOENT");
      }
      if (faults.runtimeManifestTargetSuffix && path.endsWith(faults.runtimeManifestTargetSuffix)) {
        throw exhaustedErrno("EPERM");
      }
      actual.writeTextFileAtomicallyWithRetry(path, contents, budget);
    },
  };
});

vi.mock("../src/app/official-plugin-seed-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/official-plugin-seed-lock.js")>();
  return {
    ...actual,
    withOfficialPluginSeedLock<T>(
      targetRoot: string,
      action: () => T,
      options?: Parameters<typeof actual.withOfficialPluginSeedLock>[2],
    ): T {
      if (!faults.seedLockHeldTargetSuffixes.some((suffix) => targetRoot.endsWith(suffix))) {
        return actual.withOfficialPluginSeedLock(targetRoot, action, options);
      }
      faults.seedLockObservedTimeoutsMs.push(options?.timeoutMs ?? -1);
      // 只压缩等待参数并保留调用方预算上限（默认 15s 会拖垮测试），
      // 仍走真实锁竞争与真实超时错误。
      return actual.withOfficialPluginSeedLock(targetRoot, action, {
        ...options,
        retryDelayMs: 1,
        timeoutMs: Math.min(10, options?.timeoutMs ?? 10),
      });
    },
  };
});

import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { resolveZCodePlugins } from "../src/plugins.js";

const OFFICIAL_CACHE_ROOT = join("cache", "zcode-plugins-official");
const BROWSER_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, "browser-use", "0.5.1");
const ANDROID_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, "android-emulator", "0.1.0");
const SKILL_CREATOR_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, "skill-creator", "0.1.0");
const ANDROID_MANIFEST_SUFFIX = join(ANDROID_CACHE_SUFFIX, ".zcode-plugin", "plugin.json");
const CUA_DEFINITION = OFFICIAL_PLUGIN_DEFINITIONS.find(({ name }) => name === "computer-use");
if (!CUA_DEFINITION) throw new Error("computer-use official plugin definition is missing");
const CUA_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, CUA_DEFINITION.name, CUA_DEFINITION.version);

describe("bundled official plugin cache resilience", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    faults.moveTargetSuffix = undefined;
    faults.promoteCurrentTargetSuffix = undefined;
    faults.promoteTargetSuffix = undefined;
    faults.recoverBackupTargetSuffix = undefined;
    faults.removeTargetSuffix = undefined;
    faults.runtimeManifestNotFoundTargetSuffix = undefined;
    faults.runtimeManifestTargetSuffix = undefined;
    faults.seedLockHeldTargetSuffixes = [];
    faults.seedLockObservedTimeoutsMs = [];
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("degrades a persistent transient seed failure when the target is absent", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const logger = createLogger();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ logger, storageRoot })).not.toThrow();

    expect(existsSync(join(storageRoot, BROWSER_CACHE_SUFFIX))).toBe(false);
    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        attempts: 4,
        degraded: true,
        errorCode: "EPERM",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("keeps degraded cache diagnostics through the ordinary plugin resolver", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const logger = createLogger();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    expect(() =>
      resolveZCodePlugins({
        logger,
        pluginStorageRoot: storageRoot,
        skipUserConfig: true,
        workingDirectory: dirname(storageRoot),
      }),
    ).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "EPERM",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("keeps a stale but usable target when promotion fails", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(markerPath, staleMarker.replace('"hash": "', '"hash": "stale-'));
    const logger = createLogger();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ logger, storageRoot })).not.toThrow();

    expect(existsSync(browserRoot)).toBe(true);
    expect(await readFile(markerPath, "utf8")).toContain('"hash": "stale-');
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        errorCode: "EPERM",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("falls back to a previous usable version when the new target cannot be promoted", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    const roots = resolveOfficialPluginRoots({ storageRoot });

    expect(roots).toContain(staleRoot);
  });

  it("degrades an incomplete seed source to a usable previous version instead of failing startup", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    await rm(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX), { force: true, recursive: true });
    // 入口目录旁只有一份缺 dist/docs/skills 的 browser-use 拷贝（升级中的桌面包、
    // 未构建 dist 的旧 checkout）；其余插件继续从真实 monorepo 源解析。
    const entrypointRoot = join(storageRoot, "stale-entrypoint");
    const incompletePluginRoot = join(entrypointRoot, "packages", "browser-use-plugin");
    await mkdir(join(incompletePluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(incompletePluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "browser-use", version: "0.5.1" }),
    );
    process.argv[1] = join(entrypointRoot, "zcode.cjs");
    const logger = createLogger();

    let roots: string[] = [];
    expect(() => {
      roots = resolveOfficialPluginRoots({ logger, storageRoot });
    }).not.toThrow();

    expect(roots).toContain(staleRoot);
    // 残缺源绝不能落成当前版本缓存（会永久命中 hash），也不能拖垮其他插件的 seeding。
    expect(existsSync(currentRoot)).toBe(false);
    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX))).toBe(true);
    const marketplace = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    expect(marketplace.plugins.some((plugin) => plugin.name === "browser-use")).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "ZCODE_PLUGIN_SEED_INCOMPLETE",
        // browser-use 不再携带 node_repl 宿主产物（那是 node-repl-host 的），
        // 它自己必需的运行时资产是 browser-client。
        missingSeedPaths: expect.arrayContaining(["scripts/browser-client.mjs"]),
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("keeps session bootstrap alive when an incomplete seed source has no usable fallback cache", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    // 全新安装：storageRoot 从未 seed 过，也没有任何旧版本缓存可回退。
    const entrypointRoot = join(storageRoot, "fresh-install-entrypoint");
    const incompletePluginRoot = join(entrypointRoot, "packages", "browser-use-plugin");
    await mkdir(join(incompletePluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(incompletePluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "browser-use", version: "0.5.1" }),
    );
    process.argv[1] = join(entrypointRoot, "zcode.cjs");
    const logger = createLogger();

    let outcome!: ReturnType<typeof resolveZCodePlugins>;
    expect(() => {
      outcome = resolveZCodePlugins({
        logger,
        pluginStorageRoot: storageRoot,
        skipUserConfig: true,
        workingDirectory: dirname(storageRoot),
      });
    }).not.toThrow();

    // 降级终态之二：无可用旧缓存时该插件本次缺席（不写残缺缓存），只留 warning 级诊断，
    // 其余 defaultEnabled 插件与会话引导不受影响。
    expect(existsSync(join(storageRoot, BROWSER_CACHE_SUFFIX))).toBe(false);
    expect(
      outcome.plugins.find((plugin) => plugin.id === "browser-use@zcode-plugins-official"),
    ).toBeUndefined();
    const rootNotFound = outcome.diagnostics.filter(
      (diagnostic) => diagnostic.code === "plugin_root_not_found",
    );
    expect(rootNotFound).toEqual([
      expect.objectContaining({
        path: join(storageRoot, BROWSER_CACHE_SUFFIX),
        severity: "warning",
      }),
    ]);
    const documentSkills = outcome.plugins.find(
      (plugin) => plugin.id === "documents@zcode-plugins-official",
    );
    expect(documentSkills?.enabled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        errorCode: "ZCODE_PLUGIN_SEED_INCOMPLETE",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("degrades a held seed lock to a usable previous version instead of failing startup", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    const lockRoot = `${currentRoot}.seed-lock`;
    await mkdir(lockRoot, { recursive: true });
    await writeFile(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    const logger = createLogger();
    faults.seedLockHeldTargetSuffixes = [BROWSER_CACHE_SUFFIX];

    let roots: string[] = [];
    expect(() => {
      roots = resolveOfficialPluginRoots({ logger, storageRoot });
    }).not.toThrow();

    expect(roots).toContain(staleRoot);
    // 锁属于「另一个进程」（owner 存活），降级方绝不能顺手删掉它。
    expect(existsSync(lockRoot)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "ZCODE_PLUGIN_SEED_LOCK_TIMEOUT",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("shares one seed lock wait budget across all plugins", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    for (const cacheSuffix of [BROWSER_CACHE_SUFFIX, SKILL_CREATOR_CACHE_SUFFIX]) {
      const lockRoot = `${join(storageRoot, cacheSuffix)}.seed-lock`;
      await mkdir(lockRoot, { recursive: true });
      await writeFile(
        join(lockRoot, "owner.json"),
        JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
      );
    }
    faults.seedLockHeldTargetSuffixes = [BROWSER_CACHE_SUFFIX, SKILL_CREATOR_CACHE_SUFFIX];

    expect(() => resolveOfficialPluginRoots({ storageRoot })).not.toThrow();

    // 两把被持有的锁必须共享同一截止时间：后一次调用拿到的剩余预算严格更小，
    // 而不是每个插件都重置成完整的 15s（否则成组遗留锁会让启动冻结 N×15s）。
    expect(faults.seedLockObservedTimeoutsMs).toHaveLength(2);
    const [firstBudgetMs, secondBudgetMs] = faults.seedLockObservedTimeoutsMs;
    expect(firstBudgetMs).toBeGreaterThan(0);
    expect(firstBudgetMs).toBeLessThanOrEqual(15_000);
    expect(secondBudgetMs).toBeLessThan(firstBudgetMs as number);
  });

  it("keeps an intact current cache discoverable when the seed lock times out", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    // 当前版本目录保持完整（不 rename 成旧版本），只把锁交给「另一个存活进程」。
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const lockRoot = `${currentRoot}.seed-lock`;
    await mkdir(lockRoot, { recursive: true });
    await writeFile(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    const logger = createLogger();
    faults.seedLockHeldTargetSuffixes = [BROWSER_CACHE_SUFFIX];

    const outcome = resolveZCodePlugins({
      logger,
      pluginStorageRoot: storageRoot,
      skipUserConfig: true,
      workingDirectory: dirname(storageRoot),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        errorCode: "ZCODE_PLUGIN_SEED_LOCK_TIMEOUT",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
    // 锁只保护 seed 写入，不保护读取：等锁超时不能让一份完整的当前缓存从 discovery 消失。
    // 该不变量依赖 bundled marketplace 分片在 seeding 循环之前写入且不按 seed 成败过滤；
    // 若未来把分片写入挪到循环之后，这条断言会失败。
    const browserPlugin = outcome.plugins.find(
      (plugin) => plugin.id === "browser-use@zcode-plugins-official",
    );
    expect(browserPlugin?.rootPath).toBe(currentRoot);
    expect(browserPlugin?.enabled).toBe(true);
    expect(
      outcome.diagnostics.filter((diagnostic) => diagnostic.code === "plugin_root_not_found"),
    ).toEqual([]);
  });

  it("does not mix an old zcode-cua cache with the current consumer contract", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const currentRoot = join(storageRoot, CUA_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.5.9");
    await rename(currentRoot, staleRoot);
    faults.promoteTargetSuffix = CUA_CACHE_SUFFIX;

    const roots = resolveOfficialPluginRoots({ storageRoot });

    expect(roots).not.toContain(staleRoot);
  });

  it("continues when another process moves the target after the existence check", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(markerPath, staleMarker.replace('"hash": "', '"hash": "stale-'));
    faults.moveTargetSuffix = BROWSER_CACHE_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ storageRoot })).not.toThrow();
    expect(await readFile(markerPath, "utf8")).not.toContain('"hash": "stale-');

    faults.moveTargetSuffix = undefined;
    expect(() => resolveOfficialPluginRoots({ storageRoot })).not.toThrow();
    await expectNoSeedBackups(browserRoot);
  });

  it("converges when another process completes the current seed during promotion", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(markerPath, staleMarker.replace('"hash": "', '"hash": "stale-'));
    faults.promoteCurrentTargetSuffix = BROWSER_CACHE_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ storageRoot })).not.toThrow();

    expect(await readFile(markerPath, "utf8")).not.toContain('"hash": "stale-');
    await expectNoSeedBackups(browserRoot);
  });

  it("rebuilds after a legacy backup is left by an interrupted replacement", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const backupRoot = `${browserRoot}.backup`;
    await rename(browserRoot, backupRoot);

    expect(() => resolveOfficialPluginRoots({ storageRoot })).not.toThrow();

    expect(existsSync(browserRoot)).toBe(true);
    await expectNoSeedBackups(browserRoot);
  });

  it("does not restore a fixed backup that may belong to an active replacement", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const backupRoot = `${browserRoot}.backup`;
    await rename(browserRoot, backupRoot);
    faults.recoverBackupTargetSuffix = BROWSER_CACHE_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ storageRoot })).not.toThrow();

    expect(existsSync(browserRoot)).toBe(true);
    await expectNoSeedBackups(browserRoot);
  });

  it("keeps a current target usable when only runtime manifest refresh is locked", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const logger = createLogger();
    process.argv[1] = join(storageRoot, "different-zcode.cjs");
    faults.runtimeManifestTargetSuffix = ANDROID_MANIFEST_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ logger, storageRoot })).not.toThrow();

    expect(existsSync(join(storageRoot, ANDROID_CACHE_SUFFIX))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        operation: "seed_plugin",
        pluginId: "android-emulator@zcode-plugins-official",
      }),
    );
  });

  it("keeps a concurrent winner when runtime manifest temporary file disappears", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const logger = createLogger();
    process.argv[1] = join(storageRoot, "different-zcode.cjs");
    faults.runtimeManifestNotFoundTargetSuffix = ANDROID_MANIFEST_SUFFIX;

    expect(() => resolveOfficialPluginRoots({ logger, storageRoot })).not.toThrow();

    expect(existsSync(join(storageRoot, ANDROID_CACHE_SUFFIX))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "ENOENT",
        operation: "seed_plugin",
        pluginId: "android-emulator@zcode-plugins-official",
      }),
    );
  });

  it("preserves suppressed plugin catalog/cache without attempting a Windows-locked deletion", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    resolveOfficialPluginRoots({ storageRoot });
    const logger = createLogger();
    faults.removeTargetSuffix = SKILL_CREATOR_CACHE_SUFFIX;

    expect(() =>
      resolveOfficialPluginRoots({
        logger,
        storageRoot,
        suppressedBuiltins: new Set(["skill-creator@zcode-plugins-official"]),
      }),
    ).not.toThrow();

    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX))).toBe(true);
    const marketplace = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    // 现行契约：suppressedBuiltins 只控制 runtime discovery。catalog/cache 是恢复入口
    // 的不可变资产，不应触发删除；注入的 EPERM 因而不会被命中，也不产生降级告警。
    expect(marketplace.plugins.some((plugin) => plugin.name === "skill-creator")).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({ operation: "remove_suppressed_plugin" }),
    );
  });
});

async function createStorageRoot(cleanups: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-cache-resilience-"));
  cleanups.push(root);
  return join(root, "plugins");
}

async function expectNoSeedBackups(targetRoot: string): Promise<void> {
  const targetName = basename(targetRoot);
  const siblings = await readdir(dirname(targetRoot));
  expect(siblings.filter((entry) => entry.startsWith(`${targetName}.backup`))).toEqual([]);
}

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function exhaustedErrno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), {
    code,
    zcodeOfficialPluginCacheAttempts: 4,
  });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
