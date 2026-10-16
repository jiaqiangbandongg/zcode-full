import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkStorageRoot } from "../src/storage/adapters/fsWalker.js";
import { probeStorageVolume } from "../src/storage/adapters/volumeProbe.js";
import { createFsStorageCleaner } from "../src/storage/adapters/fsCleaner.js";
import { runStorageScan } from "../src/storage/adapters/inProcessScanRunner.js";
import type { StorageScanEntry } from "../src/storage/domain/usageAggregate.js";

let root: string;

async function seed(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-storage-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("walkStorageRoot", () => {
  it("reports every regular file with size and mtime", async () => {
    await seed({ "cli/debug/a.jsonl": "12345", "v2/logs/b.log": "12", "top.txt": "1" });
    const entries: StorageScanEntry[] = [];
    const result = await walkStorageRoot({
      rootPath: root,
      onEntry: (e) => entries.push(e),
      concurrency: 2,
    });
    expect(entries.map((e) => [e.relativePath, e.bytes]).sort()).toEqual([
      ["cli/debug/a.jsonl", 5],
      ["top.txt", 1],
      ["v2/logs/b.log", 2],
    ]);
    expect(entries.every((e) => e.mtimeMs > 0)).toBe(true);
    expect(result).toMatchObject({ filesScanned: 3, missingRoot: false });
    expect(result.directoriesScanned).toBe(5);
  });

  // Windows 普通用户无 SeCreateSymbolicLinkPrivilege（开发者模式才赋予），fs.symlink 直接
  // EPERM；普通文件扫描已拆到上一条跨平台用例，这里只验证链接目录不被递归，
  // skipped 在报告里可见，覆盖由 CI Linux 承担。
  it.skipIf(process.platform === "win32")(
    "skips symlinked directories instead of recursing into them",
    async () => {
      await seed({ "cli/debug/a.jsonl": "12345", "v2/logs/b.log": "12", "top.txt": "1" });
      await symlink(join(root, "cli"), join(root, "link-to-cli"));
      const entries: StorageScanEntry[] = [];
      const result = await walkStorageRoot({
        rootPath: root,
        onEntry: (e) => entries.push(e),
        concurrency: 2,
      });
      // 链接目录不得被递归：目标内容不得重复出现，目录计数也不把它算作被扫描的目录。
      expect(entries.map((e) => [e.relativePath, e.bytes]).sort()).toEqual([
        ["cli/debug/a.jsonl", 5],
        ["top.txt", 1],
        ["v2/logs/b.log", 2],
      ]);
      expect(result).toMatchObject({ filesScanned: 3, missingRoot: false });
      expect(result.directoriesScanned).toBe(5);
    },
  );

  it("treats a missing root as empty and collects unreadable directories as errors", async () => {
    const missing = await walkStorageRoot({ rootPath: join(root, "nope"), onEntry: () => {} });
    expect(missing).toEqual({ directoriesScanned: 0, filesScanned: 0, missingRoot: true });
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await seed({ "locked/x": "1", "open/y": "1" });
    await chmod(join(root, "locked"), 0o000);
    const errors: Array<{ path: string; code: string }> = [];
    try {
      const result = await walkStorageRoot({
        rootPath: root,
        onEntry: () => {},
        onError: (e) => errors.push(e),
      });
      expect(result.filesScanned).toBe(1);
      expect(errors).toEqual([{ path: "locked", code: "EACCES" }]);
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });

  it("stops promptly when aborted", async () => {
    await seed(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`d${i % 5}/f${i}`, "x"])));
    const controller = new AbortController();
    let seen = 0;
    await expect(
      walkStorageRoot({
        rootPath: root,
        yieldEvery: 1,
        onEntry: () => {
          seen += 1;
          if (seen === 3) controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBeLessThan(50);
  });
});

describe("probeStorageVolume", () => {
  it("returns the volume of an existing path and null for a missing one", async () => {
    const volume = await probeStorageVolume(root);
    expect(volume).not.toBeNull();
    expect(volume!.totalBytes).toBeGreaterThan(0);
    expect(volume!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(root.startsWith(volume!.mountPoint)).toBe(true);
    expect(await probeStorageVolume(join(root, "missing"))).toBeNull();
  });
});

describe("createFsStorageCleaner", () => {
  it("lists recursive and shallow scopes without duplicates", async () => {
    await seed({
      "cli/db/db.sqlite": "live",
      "cli/db/db.sqlite.bak-1": "bak",
      "cli/db/backup/db.pre.sqlite": "old",
      "cli/db/backup/nested/x": "old",
    });
    const cleaner = createFsStorageCleaner();
    const candidates = await cleaner.listCandidates(root, [
      { prefix: "cli/db/backup", recursive: true },
      { prefix: "cli/db", recursive: false },
      { prefix: "does-not-exist", recursive: true },
      { prefix: "nor-this", recursive: false },
    ]);
    expect(candidates.map((c) => c.relativePath).sort()).toEqual([
      "cli/db/backup/db.pre.sqlite",
      "cli/db/backup/nested/x",
      "cli/db/db.sqlite",
      "cli/db/db.sqlite.bak-1",
    ]);
  });

  it("deletes targets, prunes emptied directories below kept ones and reports failures", async () => {
    await seed({ "backup/one/deep/x": "1234", "backup/one/keep": "1", "cli/debug/a.jsonl": "12" });
    const cleaner = createFsStorageCleaner();
    const result = await cleaner.deleteFiles(
      root,
      [
        { relativePath: "backup/one/deep/x", bytes: 4, mtimeMs: 0 },
        { relativePath: "cli/debug/a.jsonl", bytes: 2, mtimeMs: 0 },
        { relativePath: "cli/debug/missing.jsonl", bytes: 9, mtimeMs: 0 },
        { relativePath: "../outside", bytes: 1, mtimeMs: 0 },
      ],
      { keepDirectories: ["backup", "cli/debug"] },
    );
    // 删除是有界并发的，failures 顺序不保证
    expect({
      ...result,
      failures: [...result.failures].sort((a, b) => a.path.localeCompare(b.path)),
    }).toEqual({
      deletedCount: 2,
      freedBytes: 6,
      failures: [
        { path: "../outside", code: "EOUTSIDE" },
        { path: "cli/debug/missing.jsonl", code: "ENOENT" },
      ],
    });
    expect(existsSync(join(root, "backup/one/deep"))).toBe(false);
    expect(existsSync(join(root, "backup/one/keep"))).toBe(true);
    expect(existsSync(join(root, "cli/debug"))).toBe(true);
    expect(existsSync(join(root, "cli/debug/a.jsonl"))).toBe(false);
  });
});

describe("runStorageScan", () => {
  it("classifies real files per root and reports progress plus a final result", async () => {
    await seed({
      "cli/debug/model-io-a.jsonl": "12345",
      "v2/logs/2026-09-01.log": "123",
      "junk/x": "1",
    });
    const custom = await mkdtemp(join(tmpdir(), "zcode-storage-custom-"));
    await mkdir(join(custom, "v2/logs"), { recursive: true });
    await writeFile(join(custom, "v2/logs/a.log"), "1234");
    await utimes(join(custom, "v2/logs/a.log"), new Date(), new Date());
    const progress: number[] = [];
    try {
      const result = await runStorageScan({
        progressIntervalMs: 0,
        roots: [
          { id: "home", path: root, hasCustomDataBaseDir: true },
          { id: "dataBaseDir", path: custom, hasCustomDataBaseDir: true },
        ],
        signal: new AbortController().signal,
        onProgress: (p) => progress.push(p.roots.length),
      });
      expect(progress.length).toBeGreaterThan(1);
      expect(progress.at(-1)).toBe(2);
      const [home, dataBaseDir] = result.roots;
      expect(home!.bytes).toBe(9);
      expect(home!.volume).not.toBeNull();
      const byId = (usage: typeof home, id: string) => usage!.categories.find((c) => c.id === id)!;
      expect(byId(home, "modelTrajectory")).toMatchObject({ bytes: 5, fileCount: 1 });
      // home 根启用了自定义数据路径：v2 旧副本归「其他」
      expect(byId(home, "logs").bytes).toBe(0);
      expect(byId(home, "other")).toMatchObject({ bytes: 4, fileCount: 2 });
      expect(byId(dataBaseDir, "logs")).toMatchObject({ bytes: 4, fileCount: 1 });
      expect(result.errors).toEqual([]);
    } finally {
      await rm(custom, { recursive: true, force: true });
    }
  });
});
