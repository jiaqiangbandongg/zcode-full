import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredLogFiles,
  shouldDeleteExpiredLogFile,
} from "../src/main/logRetention.js";

const TEST_NOW = new Date(2026, 3, 14, 12, 0, 0);

describe("main log retention", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zcode-log-retention-"));
    tempDirs.push(dir);
    return dir;
  }

  it("应保留当天在内最近 14 个自然日的日志", () => {
    expect(shouldDeleteExpiredLogFile("2026-04-01.log", TEST_NOW)).toBe(false);
    expect(shouldDeleteExpiredLogFile("2026-03-31.log", TEST_NOW)).toBe(true);
  });

  it("启动清理时只删除过期日志文件，不影响其他文件", async () => {
    const logDir = await createTempDir();

    await Promise.all([
      writeFile(join(logDir, "2026-03-30.log"), "expired-a"),
      writeFile(join(logDir, "2026-03-31.log"), "expired-b"),
      writeFile(join(logDir, "2026-04-01.log"), "kept-boundary"),
      writeFile(join(logDir, "2026-04-14.log"), "kept-latest"),
      writeFile(join(logDir, "not-a-log.txt"), "keep-other-file"),
    ]);

    const result = cleanupExpiredLogFiles(logDir, { now: TEST_NOW });
    const remainingFiles = (await readdir(logDir)).sort();

    expect(result.deletedFiles.sort()).toEqual([
      "2026-03-30.log",
      "2026-03-31.log",
    ]);
    expect(result.failedFiles).toEqual([]);
    expect(remainingFiles).toEqual([
      "2026-04-01.log",
      "2026-04-14.log",
      "not-a-log.txt",
    ]);
  });
});
