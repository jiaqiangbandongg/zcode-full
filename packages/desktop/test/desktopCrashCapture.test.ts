import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveCrashDumps,
  resolveProcessGoneLogLevel,
  resolveCrashReporterSourceDirs,
  type CrashCapturePaths,
} from "../src/main/desktopCrashCapture.js";
import { buildCrashDumpFixture, CODE_SPACE_OOM_ANNOTATIONS } from "./crashDumpFixture.js";

describe("desktopCrashCapture", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("受控进程退出使用 info，未分类的异常退出使用 warn", () => {
    expect(resolveProcessGoneLogLevel("clean-exit")).toBe("info");
    expect(resolveProcessGoneLogLevel("killed")).toBe("info");
    expect(resolveProcessGoneLogLevel("crashed")).toBe("warn");
    expect(resolveProcessGoneLogLevel("oom")).toBe("warn");
  });

  async function createPaths(platform: NodeJS.Platform): Promise<CrashCapturePaths> {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-crash-capture-"));
    tempDirs.push(rootDir);
    const paths: CrashCapturePaths = {
      rootDir,
      stagingDir: join(rootDir, "live"),
      archiveDir: join(rootDir, "archive"),
    };

    await mkdir(paths.archiveDir, { recursive: true });
    for (const dir of resolveCrashReporterSourceDirs(paths.stagingDir, platform)) {
      await mkdir(dir, { recursive: true });
    }

    return paths;
  }

  it("应归档已稳定的 crash dump，并忽略非 dmp 文件", async () => {
    const paths = await createPaths("linux");
    const completedDir = resolveCrashReporterSourceDirs(paths.stagingDir, "linux")[0];
    const dumpPath = join(completedDir, "renderer-1.dmp");
    const ignoredPath = join(completedDir, "note.txt");

    await writeFile(dumpPath, "dump-a");
    await writeFile(ignoredPath, "ignore");
    const oldDate = new Date(Date.now() - 5_000);
    await utimes(dumpPath, oldDate, oldDate);

    const result = archiveCrashDumps(paths, { platform: "linux" });

    expect(result.archivedFiles).toEqual([dumpPath]);
    expect(result.skippedFiles).toEqual([]);
    await expect(readFile(join(paths.archiveDir, "renderer-1.dmp"), "utf-8")).resolves.toBe(
      "dump-a",
    );
  });

  it("归档时解析 crashpad 注解，把 V8 OOM 摘要写进 .dmp.json 并返回给调用方", async () => {
    const paths = await createPaths("linux");
    const completedDir = resolveCrashReporterSourceDirs(paths.stagingDir, "linux")[0];
    const oomDumpPath = join(completedDir, "renderer-oom.dmp");
    const nativeDumpPath = join(completedDir, "gpu-native.dmp");

    await writeFile(oomDumpPath, buildCrashDumpFixture(CODE_SPACE_OOM_ANNOTATIONS));
    await writeFile(nativeDumpPath, buildCrashDumpFixture({ process_type: "gpu-process" }));
    const oldDate = new Date(Date.now() - 5_000);
    await utimes(oomDumpPath, oldDate, oldDate);
    await utimes(nativeDumpPath, oldDate, oldDate);

    const result = archiveCrashDumps(paths, { platform: "linux" });

    expect(result.archivedDumps.map((record) => record.dumpPath).sort()).toEqual(
      [nativeDumpPath, oomDumpPath].sort(),
    );
    const oomRecord = result.archivedDumps.find((record) => record.dumpPath === oomDumpPath);
    expect(oomRecord?.v8OomSummary).toMatchObject({
      processType: "renderer",
      oomKind: "code_space_exhausted",
      codeCageFreeBytes: 0,
    });
    const nativeRecord = result.archivedDumps.find((record) => record.dumpPath === nativeDumpPath);
    expect(nativeRecord?.v8OomSummary).toBeNull();

    const oomMetadata = JSON.parse(
      await readFile(join(paths.archiveDir, "renderer-oom.dmp.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(oomMetadata.originalPath).toBe(oomDumpPath);
    expect(oomMetadata.annotations).toEqual(CODE_SPACE_OOM_ANNOTATIONS);
    expect(oomMetadata.v8OomSummary).toMatchObject({ oomKind: "code_space_exhausted" });

    const nativeMetadata = JSON.parse(
      await readFile(join(paths.archiveDir, "gpu-native.dmp.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(nativeMetadata.annotations).toEqual({ process_type: "gpu-process" });
    expect(nativeMetadata).not.toHaveProperty("v8OomSummary");
  });

  it("应跳过仍在写入窗口内的 crash dump", async () => {
    const paths = await createPaths("darwin");
    const pendingDir = resolveCrashReporterSourceDirs(paths.stagingDir, "darwin")[1];
    const dumpPath = join(pendingDir, "renderer-2.dmp");

    await writeFile(dumpPath, "dump-b");

    const result = archiveCrashDumps(paths, {
      platform: "darwin",
      now: new Date(),
    });

    expect(result.archivedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([dumpPath]);
  });

  it("默认最多保留最近 5 个归档", async () => {
    const paths = await createPaths("linux");
    const dumpPaths = Array.from({ length: 6 }, (_, index) =>
      join(paths.archiveDir, `renderer-${index}.dmp`),
    );

    await Promise.all(dumpPaths.map((path) => writeFile(path, "dump")));
    await Promise.all(
      dumpPaths.map((path, index) => {
        const modifiedAt = new Date(`2026-08-0${index + 1}T00:00:00.000Z`);
        return utimes(path, modifiedAt, modifiedAt);
      }),
    );

    archiveCrashDumps(paths, { platform: "linux" });

    expect((await readdir(paths.archiveDir)).sort()).toEqual([
      "renderer-1.dmp",
      "renderer-2.dmp",
      "renderer-3.dmp",
      "renderer-4.dmp",
      "renderer-5.dmp",
    ]);
  });

  it("恢复残留 dump 时应按原始 crash 时间保留较新的归档", async () => {
    const paths = await createPaths("linux");
    const completedDir = resolveCrashReporterSourceDirs(paths.stagingDir, "linux")[0];
    const olderSourceDumpPath = join(completedDir, "older-source.dmp");
    const newerArchivedDumpPath = join(paths.archiveDir, "newer-archive.dmp");
    const now = new Date();
    const olderCrashAt = new Date(now.getTime() - 60_000);
    const newerCrashAt = new Date(now.getTime() - 30_000);

    await Promise.all([
      writeFile(olderSourceDumpPath, "older-source"),
      writeFile(newerArchivedDumpPath, "newer-archive"),
    ]);
    await Promise.all([
      utimes(olderSourceDumpPath, olderCrashAt, olderCrashAt),
      utimes(newerArchivedDumpPath, newerCrashAt, newerCrashAt),
    ]);

    archiveCrashDumps(paths, {
      platform: "linux",
      now,
      retention: { maxFiles: 1, maxTotalBytes: 100 },
    });

    expect(await readdir(paths.archiveDir)).toEqual(["newer-archive.dmp"]);
  });

  it("归档数量超限时删除最旧 dump 及其元数据，并保留 live 与其他文件", async () => {
    const paths = await createPaths("linux");
    const completedDir = resolveCrashReporterSourceDirs(paths.stagingDir, "linux")[0];
    const sourceDumpPath = join(completedDir, "latest.dmp");
    const oldestDumpPath = join(paths.archiveDir, "oldest.dmp");
    const newerDumpPath = join(paths.archiveDir, "newer.dmp");
    const oldestMetadataPath = `${oldestDumpPath}.json`;
    const unrelatedPath = join(paths.archiveDir, "keep.txt");
    const now = new Date("2026-08-03T12:00:00.000Z");

    await Promise.all([
      writeFile(sourceDumpPath, "latest"),
      writeFile(oldestDumpPath, "oldest"),
      writeFile(newerDumpPath, "newer"),
      writeFile(oldestMetadataPath, "{}"),
      writeFile(unrelatedPath, "keep"),
    ]);
    await Promise.all([
      utimes(sourceDumpPath, new Date(now.getTime() - 5_000), new Date(now.getTime() - 5_000)),
      utimes(
        oldestDumpPath,
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-07-01T00:00:00.000Z"),
      ),
      utimes(
        newerDumpPath,
        new Date("2026-07-02T00:00:00.000Z"),
        new Date("2026-07-02T00:00:00.000Z"),
      ),
    ]);

    archiveCrashDumps(paths, {
      platform: "linux",
      now,
      retention: { maxFiles: 2, maxTotalBytes: 100 },
    });

    expect((await readdir(paths.archiveDir)).sort()).toEqual([
      "keep.txt",
      "latest.dmp",
      "latest.dmp.json",
      "newer.dmp",
    ]);
    await expect(access(sourceDumpPath)).resolves.toBeUndefined();
  });

  it("归档总大小超限时仍保留最新 dump，并删除更旧文件", async () => {
    const paths = await createPaths("linux");
    const latestDumpPath = join(paths.archiveDir, "latest-large.dmp");
    const olderDumpPath = join(paths.archiveDir, "older.dmp");

    await Promise.all([
      writeFile(latestDumpPath, "latest-large"),
      writeFile(`${latestDumpPath}.json`, "{}"),
      writeFile(olderDumpPath, "older"),
      writeFile(`${olderDumpPath}.json`, "{}"),
    ]);
    await Promise.all([
      utimes(
        latestDumpPath,
        new Date("2026-08-03T00:00:00.000Z"),
        new Date("2026-08-03T00:00:00.000Z"),
      ),
      utimes(
        olderDumpPath,
        new Date("2026-08-02T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ]);

    archiveCrashDumps(paths, {
      platform: "linux",
      retention: { maxFiles: 5, maxTotalBytes: 10 },
    });

    expect((await readdir(paths.archiveDir)).sort()).toEqual([
      "latest-large.dmp",
      "latest-large.dmp.json",
    ]);
  });

  it("清理只处理普通 dmp 文件，不被同后缀目录阻断", async () => {
    const paths = await createPaths("win32");
    const dumpDirectory = join(paths.archiveDir, "not-a-file.dmp");
    const latestDumpPath = join(paths.archiveDir, "latest.dmp");

    await Promise.all([mkdir(dumpDirectory), writeFile(latestDumpPath, "latest")]);

    expect(() =>
      archiveCrashDumps(paths, {
        platform: "win32",
        retention: { maxFiles: 1, maxTotalBytes: 100 },
      }),
    ).not.toThrow();
    await expect(access(dumpDirectory)).resolves.toBeUndefined();
    await expect(access(latestDumpPath)).resolves.toBeUndefined();
  });

  it("旧 dump 元数据删除失败后应在后续清理重试，并保留其他 JSON 文件", async () => {
    const paths = await createPaths("linux");
    const latestDumpPath = join(paths.archiveDir, "latest.dmp");
    const oldDumpPath = join(paths.archiveDir, "old.dmp");
    const invalidMetadataPath = `${oldDumpPath}.json`;
    const unrelatedJsonPath = join(paths.archiveDir, "keep.json");

    await Promise.all([
      writeFile(latestDumpPath, "latest"),
      writeFile(oldDumpPath, "old"),
      mkdir(invalidMetadataPath),
      writeFile(unrelatedJsonPath, "{}"),
    ]);
    await Promise.all([
      utimes(
        latestDumpPath,
        new Date("2026-08-03T00:00:00.000Z"),
        new Date("2026-08-03T00:00:00.000Z"),
      ),
      utimes(
        oldDumpPath,
        new Date("2026-08-02T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ]);

    const result = archiveCrashDumps(paths, {
      platform: "linux",
      retention: { maxFiles: 1, maxTotalBytes: 100 },
    });

    expect(result.failedArchiveFiles).toEqual([invalidMetadataPath]);
    await expect(access(oldDumpPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(invalidMetadataPath)).resolves.toBeUndefined();

    await rm(invalidMetadataPath, { recursive: true });
    await writeFile(invalidMetadataPath, '{"originalPath":"/Users/example/live/old.dmp"}');

    const retryResult = archiveCrashDumps(paths, {
      platform: "linux",
      retention: { maxFiles: 1, maxTotalBytes: 100 },
    });

    expect(retryResult.deletedArchiveFiles).toEqual([invalidMetadataPath]);
    await expect(access(invalidMetadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelatedJsonPath)).resolves.toBeUndefined();
  });
});
