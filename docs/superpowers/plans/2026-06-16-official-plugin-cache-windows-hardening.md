# Windows 官方插件缓存加固实施计划

> **给执行该计划的 agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项执行。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 修复 Windows 上内置官方插件 seed/cache 替换时 `ENOTEMPTY` / `EPERM` 留下 `0.1.0.tmp-*`，并被插件发现流程当成真实版本加载的问题。

**架构：** 把修复拆成两层：bootstrap seed 写入端负责有界重试、陈旧工作目录清理、seed lock 和 manifest 原子写重试；adapter 插件发现端负责忽略官方插件缓存里的工作目录，保证历史残留不会污染插件加载。bootstrap 和 adapters 分属不同包，不互相跨包导入实现辅助模块；bootstrap 放文件系统重试辅助模块，adapters 放最小扫描过滤逻辑。

**技术栈：** TypeScript、Node.js `fs` 同步 API、Vitest、`@zcode/bootstrap` 官方插件 seed、`@zcode/adapters` 插件发现。

---

## 背景与根因

已确认的失败链路：

- `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts` 的 `seedBundledOfficialPlugins()` 会把官方插件先写到 `${targetRoot}.tmp-${process.pid}-${Date.now()}`，再通过 `replaceSeedRoot()` 删除正式版本目录并 `renameSync(tmp, targetRoot)`。
- 当前 `replaceSeedRoot()` 只把 `EEXIST` / `ENOTEMPTY` 当成有限竞争重试，且 `rmSync(targetRoot)`、catch 里的 `rmSync(temporaryRoot)` 没有统一的有界重试/退避。Windows 上文件句柄、MCP 子进程、Defender/EDR 扫描都可能让目录删除或 rename 暂时失败。
- `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts` 的 `writeTextFileAtomically()` 对 `.zcode-plugin/plugin.json` 的重写也是裸 `renameSync`，带 MCP server 的官方插件更容易碰到 Windows manifest 句柄竞争。
- `apps/zcode-cli/packages/adapters/src/plugins/index.ts` 的 `scanOfficialCache()` 会把 `cache/zcode-plugins-official/<plugin>/` 下所有目录都当作版本候选，没有过滤 `0.1.0.tmp-*` 或 `0.1.0.seed-lock`。

修复判定标准：

- 不能再因为短暂 Windows 文件系统竞争直接留下大量 tmp 并启动失败。
- 机器上已经存在的 `0.1.0.tmp-*` 不能再进入插件发现流程。
- 桌面端 continuous / Web remote replayable 链路不应受影响；本次只改 agent bootstrap/adapters 文件系统与插件发现流程，不改 app/remote/session/task realtime 协议。

## 文件结构

- 新增：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-cache-fs.ts`
  - bootstrap 专用的官方插件缓存文件系统辅助模块。
  - 负责临时 Windows 错误识别、同步重试/退避、目录删除、rename、manifest 原子写、陈旧 tmp/lock 清理、seed lock。
- 修改：`apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`
  - 使用辅助模块替换 `replaceSeedRoot()` 中的裸 `rmSync` / `renameSync`。
  - seed 前清理陈旧工作目录，并用版本级 seed lock 串行化同一插件版本的替换。
  - 获取 lock 后重新检查 `isSeedCurrent()`，避免并发进程等待期间重复 seed。
- 修改：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts`
  - 使用辅助模块的 `writeTextFileAtomicallyWithRetry()` 重写 `.zcode-plugin/plugin.json`。
- 修改：`apps/zcode-cli/packages/adapters/src/plugins/index.ts`
  - `scanOfficialCache()` 过滤官方插件缓存工作目录，避免把 `*.tmp-*` / `*.seed-lock` 当成插件版本目录。
- 新增测试：`apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts`
  - 单测重试/退避、临时错误判断、陈旧工作目录清理、陈旧 seed lock 接管。
- 修改测试：`apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts`
  - 增加官方插件 seed 清理陈旧 `0.1.0.tmp-*` 并仍落正式版本的回归测试。
- 修改测试：`apps/zcode-cli/packages/adapters/tests/plugins.test.ts`
  - 增加插件发现流程忽略官方插件缓存 tmp/lock 工作目录的回归测试。
- 新增文档：`docs/official-plugin-cache-windows-hardening.md`
  - 记录本 bug 的原因、修复策略和 Windows 验证边界，满足 bugfix 轨迹要求。

---

### 任务 1：先锁住 adapter 发现流程的 tmp/lock 污染回归

**文件：**
- 修改：`apps/zcode-cli/packages/adapters/tests/plugins.test.ts`
- 修改：`apps/zcode-cli/packages/adapters/src/plugins/index.ts`

- [ ] **步骤 1：写失败测试，证明 `.tmp-*` 和 `.seed-lock` 目前会污染插件发现**

在 `apps/zcode-cli/packages/adapters/tests/plugins.test.ts` 的 `describe("NodePluginAdapter", () => { ... })` 内追加：

```ts
  it("ignores official cache work directories left by interrupted seed attempts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-official-cache-workdirs-"));
    const storageRoot = join(dir, "plugins");
    const cacheRoot = join(storageRoot, "cache", "zcode-plugins-official", "document-skills");
    const temporaryVersionRoot = join(cacheRoot, "0.1.0.tmp-1234-1700000000000");
    const lockRoot = join(cacheRoot, "0.1.0.seed-lock");

    try {
      await writePluginManifest(temporaryVersionRoot, {
        name: "document-skills",
        skills: "skills",
        version: "0.1.0",
      });
      await mkdir(join(temporaryVersionRoot, "skills", "docx"), { recursive: true });
      await writeFile(join(temporaryVersionRoot, "skills", "docx", "SKILL.md"), "# docx");
      await mkdir(lockRoot, { recursive: true });

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });

      expect(outcome.plugins).toEqual([]);
      expect(outcome.skillRoots).toEqual([]);
      expect(outcome.diagnostics).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
```

- [ ] **步骤 2：运行测试，确认它先失败**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/plugins.test.ts
```

预期（实现前）：失败（FAIL）。失败点应是 `outcome.plugins` 包含 `document-skills@zcode-plugins-official`，或 diagnostics 包含 lock 目录缺少 manifest 的错误。

- [ ] **步骤 3：在发现流程扫描端过滤工作目录**

修改 `apps/zcode-cli/packages/adapters/src/plugins/index.ts`。

在 `scanOfficialCache()` 上方新增 helper：

```ts
function isOfficialCacheWorkDirectoryName(name: string): boolean {
  return name.includes(".tmp-") || name.endsWith(".seed-lock");
}
```

把 `scanOfficialCache()` 内层循环改成：

```ts
      for (const versionEntry of readdirSync(pluginDir, { withFileTypes: true })) {
        // Bugfix：Windows official plugin seed 失败后可能残留 0.1.0.tmp-* 或
        // 0.1.0.seed-lock；discovery 必须忽略这些工作目录，避免把未完成替换当真实版本加载。
        if (isOfficialCacheWorkDirectoryName(versionEntry.name)) continue;
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
```

- [ ] **步骤 4：运行 adapter 测试，确认通过**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/plugins.test.ts
```

预期（实现后）：通过（PASS），新增测试不再从 tmp/lock 目录发现插件。

---

### 任务 2：Bootstrap 新增官方插件缓存文件系统辅助模块

**文件：**
- 新增：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-cache-fs.ts`
- 新增：`apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts`

- [ ] **步骤 1：写辅助模块的失败测试**

创建 `apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts`：

```ts
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupStaleOfficialPluginWorkDirectories,
  isTransientOfficialPluginCacheFsError,
  retryOfficialPluginCacheFs,
  withOfficialPluginSeedLock,
} from "../src/app/official-plugin-cache-fs.js";

describe("official plugin cache fs helpers", () => {
  it("classifies Windows directory replacement errors as transient", () => {
    for (const code of ["ENOTEMPTY", "EPERM", "EBUSY", "EEXIST"]) {
      expect(isTransientOfficialPluginCacheFsError(Object.assign(new Error(code), { code }))).toBe(
        true,
      );
    }
    expect(isTransientOfficialPluginCacheFsError(Object.assign(new Error("missing"), {
      code: "ENOENT",
    }))).toBe(false);
  });

  it("retries transient file-system errors with bounded attempts", () => {
    let attempts = 0;
    const result = retryOfficialPluginCacheFs(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("busy"), { code: "EPERM" });
        }
        return "ok";
      },
      { attempts: 4, delayMs: 0 },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("removes stale official plugin tmp and lock directories but keeps active tmp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-official-plugin-cache-fs-"));
    const pluginDir = join(dir, "document-skills");
    const staleTmp = join(pluginDir, "0.1.0.tmp-111-1700000000000");
    const freshTmp = join(pluginDir, "0.1.0.tmp-222-1700000001000");
    const staleLock = join(pluginDir, "0.1.0.seed-lock");
    const oldDate = new Date(Date.now() - 10 * 60_000);

    try {
      await mkdir(staleTmp, { recursive: true });
      await mkdir(freshTmp, { recursive: true });
      await mkdir(staleLock, { recursive: true });
      await writeFile(join(staleTmp, "marker.txt"), "stale");
      await writeFile(join(freshTmp, "marker.txt"), "fresh");
      await utimes(staleTmp, oldDate, oldDate);
      await utimes(staleLock, oldDate, oldDate);

      cleanupStaleOfficialPluginWorkDirectories(pluginDir, "0.1.0", {
        minimumAgeMs: 60_000,
        nowMs: Date.now(),
      });

      expect(existsSync(staleTmp)).toBe(false);
      expect(existsSync(staleLock)).toBe(false);
      expect(existsSync(freshTmp)).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("takes over a stale seed lock and releases it after the action", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-official-plugin-seed-lock-"));
    const targetRoot = join(dir, "document-skills", "0.1.0");
    const lockRoot = `${targetRoot}.seed-lock`;
    const oldDate = new Date(Date.now() - 10 * 60_000);

    try {
      await mkdir(lockRoot, { recursive: true });
      await utimes(lockRoot, oldDate, oldDate);

      let ran = false;
      withOfficialPluginSeedLock(
        targetRoot,
        () => {
          ran = true;
        },
        { attempts: 2, staleLockAgeMs: 60_000, delayMs: 0 },
      );

      expect(ran).toBe(true);
      expect(existsSync(lockRoot)).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
```

- [ ] **步骤 2：运行新测试，确认它先失败**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/official-plugin-cache-fs.test.ts
```

预期（实现前）：失败（FAIL），原因是 `../src/app/official-plugin-cache-fs.js` 还不存在。

- [ ] **步骤 3：创建辅助模块实现**

创建 `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-cache-fs.ts`：

```ts
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const TRANSIENT_OFFICIAL_PLUGIN_CACHE_ERROR_CODES = new Set([
  "EBUSY",
  "EEXIST",
  "ENOTEMPTY",
  "EPERM",
]);

const DEFAULT_RETRY_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_WORK_DIRECTORY_AGE_MS = 5 * 60_000;
const DEFAULT_STALE_LOCK_AGE_MS = 5 * 60_000;

interface RetryOptions {
  attempts?: number;
  delayMs?: number;
}

interface CleanupOptions {
  minimumAgeMs?: number;
  nowMs?: number;
}

interface SeedLockOptions extends RetryOptions {
  staleLockAgeMs?: number;
}

export function isTransientOfficialPluginCacheFsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = String((error as NodeJS.ErrnoException).code ?? "");
  return TRANSIENT_OFFICIAL_PLUGIN_CACHE_ERROR_CODES.has(code);
}

export function retryOfficialPluginCacheFs<T>(
  operation: () => T,
  options: RetryOptions = {},
): T {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransientOfficialPluginCacheFsError(error) || attempt === attempts - 1) {
        throw error;
      }
      sleepSync(delayMs * (attempt + 1));
    }
  }

  throw lastError;
}

export function removeOfficialPluginCacheDirectory(path: string): void {
  retryOfficialPluginCacheFs(() => {
    rmSync(path, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: DEFAULT_RETRY_DELAY_MS,
    });
  });
}

export function renameOfficialPluginCacheDirectory(from: string, to: string): void {
  retryOfficialPluginCacheFs(() => renameSync(from, to));
}

export function writeTextFileAtomicallyWithRetry(filePath: string, contents: string): void {
  const temporaryPath = join(
    dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    writeFileSync(temporaryPath, contents);
    retryOfficialPluginCacheFs(() => renameSync(temporaryPath, filePath));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function cleanupStaleOfficialPluginWorkDirectories(
  pluginDirectory: string,
  version: string,
  options: CleanupOptions = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_STALE_WORK_DIRECTORY_AGE_MS;

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(pluginDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isOfficialPluginWorkDirectoryName(entry.name, version)) continue;

    const entryPath = join(pluginDirectory, entry.name);
    let ageMs = 0;
    try {
      ageMs = nowMs - statSync(entryPath).mtimeMs;
    } catch (error) {
      if (isNotFoundError(error)) continue;
      throw error;
    }
    if (ageMs < minimumAgeMs) continue;
    removeOfficialPluginCacheDirectory(entryPath);
  }
}

export function withOfficialPluginSeedLock<T>(
  targetRoot: string,
  action: () => T,
  options: SeedLockOptions = {},
): T {
  const lockRoot = `${targetRoot}.seed-lock`;
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockAgeMs = options.staleLockAgeMs ?? DEFAULT_STALE_LOCK_AGE_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      mkdirSync(dirname(lockRoot), { recursive: true });
      mkdirSync(lockRoot);
      try {
        writeFileSync(
          join(lockRoot, "owner.json"),
          JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }, null, 2),
        );
        return action();
      } finally {
        removeOfficialPluginCacheDirectory(lockRoot);
      }
    } catch (error) {
      if (!isAlreadyExistsError(error) || attempt === attempts - 1) throw error;
      cleanupStaleOfficialPluginWorkDirectories(dirname(targetRoot), basename(targetRoot), {
        minimumAgeMs: staleLockAgeMs,
      });
      sleepSync(delayMs * (attempt + 1));
    }
  }

  return action();
}

function isOfficialPluginWorkDirectoryName(name: string, version: string): boolean {
  return name.startsWith(`${version}.tmp-`) || name === `${version}.seed-lock`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "EEXIST"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
```

- [ ] **步骤 4：运行辅助模块测试，确认通过**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/official-plugin-cache-fs.test.ts
```

预期（实现后）：通过（PASS），4 个辅助模块测试全部通过。

---

### 任务 3：Bootstrap seed 写入端增加 lock、陈旧目录清理和重试

**文件：**
- 修改：`apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`
- 修改：`apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts`

- [ ] **步骤 1：写陈旧 tmp 清理回归测试**

在 `apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts` 顶部 import 增加 `utimes`：

```ts
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
```

在 `describe("ZCode plugins", () => { ... })` 内追加：

```ts
  it("cleans stale official plugin seed work directories before reseeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-stale-plugin-tmp-"));
    const entryRoot = join(root, "resources", "glm");
    const pluginStorageRoot = join(root, "plugins");
    const staleTmpRoot = join(
      pluginStorageRoot,
      "cache",
      "zcode-plugins-official",
      "document-skills",
      "0.1.0.tmp-1234-1700000000000",
    );
    const targetRoot = join(pluginStorageRoot, OFFICIAL_DOCUMENT_SKILLS_PLUGIN_CACHE_PATH);
    const originalEntrypoint = process.argv[1];
    const oldDate = new Date(Date.now() - 10 * 60_000);

    try {
      await writeTestFile(join(entryRoot, "zcode.cjs"), "");
      await writePackagedPluginFixture(entryRoot, "document-skills-plugin", "document-skills");
      await writeTestFile(join(staleTmpRoot, ".zcode-plugin", "plugin.json"), "{}");
      await utimes(staleTmpRoot, oldDate, oldDate);

      process.argv[1] = join(entryRoot, "zcode.cjs");
      resolveOfficialPluginRoots({ storageRoot: pluginStorageRoot });

      expect(existsSync(staleTmpRoot)).toBe(false);
      expect(existsSync(join(targetRoot, ".zcode-plugin", "plugin.json"))).toBe(true);
      expect(existsSync(join(targetRoot, "skills", "demo", "SKILL.md"))).toBe(true);
    } finally {
      process.argv[1] = originalEntrypoint;
      await rm(root, { force: true, recursive: true });
    }
  });
```

- [ ] **步骤 2：运行 bootstrap plugins 测试，确认新测试先失败**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/plugins.test.ts
```

预期（实现前）：失败（FAIL）。失败点应是陈旧 tmp 仍然存在。

- [ ] **步骤 3：修改 `bundled-plugins.ts` imports**

在 `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts` 中：

从 `node:fs` import 移除 `renameSync` 和 `rmSync`，保留其他使用项。

从 `node:path` import 增加 `basename`：

```ts
import { basename, dirname, join, resolve, sep } from "node:path";
```

新增 helper import：

```ts
import {
  cleanupStaleOfficialPluginWorkDirectories,
  removeOfficialPluginCacheDirectory,
  renameOfficialPluginCacheDirectory,
  withOfficialPluginSeedLock,
} from "./official-plugin-cache-fs.js";
```

- [ ] **步骤 4：给 seed 流程加版本级 lock 和 lock 后二次 current check**

把 `for (const plugin of source.plugins) { ... }` 中生成 tmp 和写文件的主体改成以下形态：

```ts
  for (const plugin of source.plugins) {
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    if (isSeedReady(targetRoot, plugin)) continue;

    withOfficialPluginSeedLock(targetRoot, () => {
      cleanupStaleOfficialPluginWorkDirectories(dirname(targetRoot), basename(targetRoot));
      if (isSeedReady(targetRoot, plugin)) return;

      const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
      removeOfficialPluginCacheDirectory(temporaryRoot);
      mkdirSync(temporaryRoot, { recursive: true });

      try {
        for (const file of plugin.files) {
          const bytes = readSeedFileBytes(source, plugin, file);
          if (hashBytes(bytes) !== file.sha256) {
            throw new Error(
              `Bundled plugin asset hash mismatch: ${plugin.definition.name}/${file.path}`,
            );
          }
          const outputPath = join(temporaryRoot, ...file.path.split("/"));
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, bytes);
          chmodSync(outputPath, modeForSeedFile(file.path, file.mode));
        }

        writeFileSync(
          join(temporaryRoot, SEED_MARKER_FILE),
          JSON.stringify(seedMarker(source, plugin), null, 2),
        );
        replaceSeedRoot(temporaryRoot, targetRoot, plugin);
        writeOfficialPluginRuntimeManifest({
          pluginName: plugin.definition.name,
          rootPath: targetRoot,
        });
      } catch (error) {
        // Bugfix：Windows 上 seed 替换失败后，tmp 目录本身也可能被 Defender/EDR 或子进程
        // 短暂占用；这里使用 bounded retry 清理，避免 0.1.0.tmp-* 在后续启动污染 discovery。
        removeOfficialPluginCacheDirectory(temporaryRoot);
        throw error;
      }
    });
  }
```

新增 `isSeedReady()`，替代原来 loop 顶部的 inline manifest rewrite 判断：

```ts
function isSeedReady(targetRoot: string, plugin: OfficialPluginSeedPluginSource): boolean {
  if (!isSeedCurrent(targetRoot, plugin)) return false;
  return tryWriteOfficialPluginRuntimeManifest({
    pluginName: plugin.definition.name,
    rootPath: targetRoot,
  });
}
```

- [ ] **步骤 5：修改 `replaceSeedRoot()` 使用 retry helper**

把 `replaceSeedRoot()` 替换成：

```ts
function replaceSeedRoot(
  temporaryRoot: string,
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    removeOfficialPluginCacheDirectory(targetRoot);
    mkdirSync(dirname(targetRoot), { recursive: true });
    try {
      renameOfficialPluginCacheDirectory(temporaryRoot, targetRoot);
      return;
    } catch (error) {
      if (!isDirectoryReplaceRace(error) || attempt === 2) throw error;
      if (isSeedCurrent(targetRoot, plugin)) {
        removeOfficialPluginCacheDirectory(temporaryRoot);
        return;
      }
    }
  }
}
```

把 `isDirectoryReplaceRace()` 的错误码扩展为：

```ts
    ["EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"].includes(
      String((error as NodeJS.ErrnoException).code),
    )
```

- [ ] **步骤 6：运行 bootstrap plugins 测试，确认通过**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/plugins.test.ts
```

预期（实现后）：通过（PASS），陈旧 tmp 清理回归和既有官方插件 seed 行为都通过。

---

### 任务 4：Runtime manifest 重写使用带重试的原子写

**文件：**
- 修改：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts`
- 修改：`apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts`

- [ ] **步骤 1：给 atomic text write 加覆盖测试**

在 `apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts` import 中加入：

```ts
  readFile,
```

从 helper import 中加入：

```ts
  writeTextFileAtomicallyWithRetry,
```

追加测试：

```ts
  it("writes text files atomically without leaving temporary files on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-official-plugin-atomic-write-"));
    const filePath = join(dir, "plugin.json");

    try {
      writeTextFileAtomicallyWithRetry(filePath, "{\"name\":\"document-skills\"}\n");

      expect(await readFile(filePath, "utf8")).toBe("{\"name\":\"document-skills\"}\n");
      const entries = await import("node:fs/promises").then(({ readdir }) => readdir(dir));
      expect(entries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
```

- [ ] **步骤 2：运行辅助模块测试**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/official-plugin-cache-fs.test.ts
```

预期：通过（PASS）。

- [ ] **步骤 3：修改 runtime manifest 原子写实现**

在 `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts` 中：

移除 `renameSync`、`writeFileSync` import，只保留：

```ts
import { readFileSync } from "node:fs";
```

新增 helper import：

```ts
import { writeTextFileAtomicallyWithRetry } from "./official-plugin-cache-fs.js";
```

把文件末尾的 `writeTextFileAtomically()` 删除，并把调用点：

```ts
  writeTextFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
```

替换为：

```ts
  writeTextFileAtomicallyWithRetry(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
```

- [ ] **步骤 4：运行 bootstrap plugins 测试确认 runtime rewrite 未回归**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/plugins.test.ts
```

预期：通过（PASS），iOS/Android MCP server args 仍指向 official plugin cache 下的 `dist/mcp/server.js`。

---

### 任务 5：记录 bugfix 文档

**文件：**
- 新增：`docs/official-plugin-cache-windows-hardening.md`

- [ ] **步骤 1：写 bugfix 轨迹文档**

创建 `docs/official-plugin-cache-windows-hardening.md`：

```md
# Windows 官方插件缓存加固

## 背景

Windows 桌面端启动时，内置官方插件会 seed 到：

`~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin>/<version>/`

事故日志显示 `document-skills@0.1.0` 附近有大量 `0.1.0.tmp-*` 残留，并伴随 `ENOTEMPTY` 与 `EPERM` rename 失败。

## 根因

seed 流程先写 `${version}.tmp-<pid>-<time>`，再删除正式版本目录并 rename tmp 到正式目录。Windows 上目录删除/rename 可能被运行中的进程、MCP 子进程、Defender 或 EDR 的短暂文件句柄打断。旧实现对 `rmSync`、`renameSync` 和失败后的 tmp 清理缺少统一有界重试，因此会留下完整 tmp 目录。

第二层问题是插件发现流程会扫描官方插件缓存下所有目录。历史残留的 `0.1.0.tmp-*` 会被当成真实版本目录，导致启动继续加载错误候选。

## 修复

- bootstrap seed 使用版本级 seed lock，避免多个进程同时替换同一官方插件缓存。
- seed 前清理足够老的 `${version}.tmp-*` 和 `${version}.seed-lock`。
- 官方插件缓存的 `rm`、`rename`、manifest 原子写统一走有界重试/退避，覆盖 `ENOTEMPTY`、`EPERM`、`EBUSY`、`EEXIST`。
- 插件发现流程明确忽略 `${version}.tmp-*` 和 `${version}.seed-lock` 工作目录，防止历史残留污染插件候选。

## 验证

- `pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/plugins.test.ts`
- `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/official-plugin-cache-fs.test.ts`
- `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/plugins.test.ts`
- `pnpm typecheck`
- `pnpm lint`

## 影响面

本修复只涉及 agent 侧 bootstrap/adapters 官方插件缓存文件系统逻辑，不改变 app/main/host process 职责，不改变 ZCode protocol，不改变桌面端 continuous 与 Web remote replayable 的 task realtime 语义。
```

- [ ] **步骤 2：检查文档没有把计划写成实现承诺**

运行：

```bash
PLACEHOLDER_PATTERN='T[B]D|TO[D]O|implement[ ]later|fill[ ]in[ ]details|待[补]|之后[补]'
rg -n "$PLACEHOLDER_PATTERN" docs/official-plugin-cache-windows-hardening.md
```

预期：无输出。

---

### 任务 6：完整验证并提交

**文件：**
- 验证任务 1-5 修改到的所有文件。

- [ ] **步骤 1：运行 adapter 定向测试**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/plugins.test.ts
```

预期：通过（PASS）。

- [ ] **步骤 2：运行 bootstrap 辅助模块测试**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/official-plugin-cache-fs.test.ts
```

预期：通过（PASS）。

- [ ] **步骤 3：运行 bootstrap plugin 测试**

运行：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/plugins.test.ts
```

预期：通过（PASS）。

- [ ] **步骤 4：运行仓库强制校验**

运行：

```bash
pnpm typecheck
```

预期：通过（PASS）。

运行：

```bash
pnpm lint
```

预期：通过（PASS）。

- [ ] **步骤 5：检查 diff 只包含本计划列出的文件**

运行：

```bash
git diff -- apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts apps/zcode-cli/packages/bootstrap/src/app/official-plugin-cache-fs.ts apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts apps/zcode-cli/packages/adapters/src/plugins/index.ts apps/zcode-cli/packages/adapters/tests/plugins.test.ts docs/official-plugin-cache-windows-hardening.md
```

预期：diff 只包含 Windows 官方插件缓存加固相关改动。

- [ ] **步骤 6：提交 Conventional Commit**

运行：

```bash
git add apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts apps/zcode-cli/packages/bootstrap/src/app/official-plugin-cache-fs.ts apps/zcode-cli/packages/bootstrap/tests/official-plugin-cache-fs.test.ts apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts apps/zcode-cli/packages/adapters/src/plugins/index.ts apps/zcode-cli/packages/adapters/tests/plugins.test.ts docs/official-plugin-cache-windows-hardening.md
git commit -m "fix(cli): harden official plugin cache replacement on Windows"
```

预期：commit 创建成功；如工作区存在无关 staged 文件，改用 pathspec commit 只提交上述文件。

---

## 自检

- 需求覆盖：计划覆盖 seed 写入端重试、runtime manifest 原子写、陈旧 tmp 清理、seed lock、发现流程 tmp/lock 过滤、测试、文档和强制 `pnpm typecheck` / `pnpm lint`。
- 占位词扫描：文档中不保留 plan 技能禁止的占位标记字符串。
- 类型一致性：helper 名称在测试、bootstrap seed、runtime manifest 中保持一致；adapter filter 独立在 adapters 包内，不跨包导入 bootstrap 实现。
