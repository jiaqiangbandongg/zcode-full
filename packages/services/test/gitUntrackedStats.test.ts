import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUntrackedStats } from "#src/git/repo/gitCliHelpers.js";
import type { GitStatusEntry } from "#src/git/repo/gitCliTypes.js";

const io = vi.hoisted(() => ({
  readFile: vi.fn(),
  open: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  io.readFile.mockImplementation(actual.readFile);
  io.open.mockImplementation(actual.open);
  return { ...actual, readFile: io.readFile, open: io.open };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const dirs: string[] = [];
const LIMIT = 1024 * 1024;
const CHUNK = 64 * 1024;

function entry(path: string): GitStatusEntry {
  return {
    path,
    originalPath: null,
    kind: "added",
    x: "?",
    y: "?",
    isUntracked: true,
    isConflicted: false,
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-untracked-stats-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  io.open.mockReset().mockImplementation(actualFs.open);
  io.readFile.mockClear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("未跟踪文件统计读取预算", () => {
  it("保留空文件、CRLF、末尾换行和跨块文本的精确行数", async () => {
    const dir = await fixture();
    const cases = [
      ["empty", "", 0],
      ["lf", "\n", 1],
      ["crlf", "中文\r\n第二行\r\n", 2],
      ["tail", "a\nb", 2],
      ["blank", "a\n\n", 2],
      ["boundary", "a".repeat(CHUNK - 1) + "\n末行", 2],
      ["limit", "a".repeat(LIMIT - 1) + "\n", 1],
    ] as const;
    for (const [path, text] of cases) await writeFile(join(dir, path), text);
    const stats = await buildUntrackedStats(
      dir,
      cases.map(([path]) => entry(path)),
    );
    for (const [path, , added] of cases) expect(stats.get(path)).toEqual({ added, removed: 0 });
  });

  it("跳过超限文本、二进制、目录和已删除文件，同时保留条目", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "large-text"), "a".repeat(LIMIT + 1));
    const binary = await open(join(dir, "large-binary"), "w");
    await binary.truncate(32 * LIMIT);
    await binary.close();
    await mkdir(join(dir, "directory"));
    io.readFile.mockClear();
    io.open.mockClear();
    const stats = await buildUntrackedStats(
      dir,
      ["large-text", "large-binary", "directory", "missing"].map(entry),
    );
    expect([...stats.values()]).toEqual(
      Array.from({ length: 4 }, () => ({ added: 0, removed: 0 })),
    );
    expect(io.readFile).not.toHaveBeenCalled();
    expect(io.open).not.toHaveBeenCalled();
  });

  it("首块发现二进制就停止读取并关闭句柄", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "binary"), Buffer.alloc(LIMIT));
    let bytesRead = 0;
    let closed = 0;
    io.open.mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed++;
        await close();
      });
      return handle;
    });
    expect((await buildUntrackedStats(dir, [entry("binary")])).get("binary")?.added).toBe(0);
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThanOrEqual(CHUNK);
    expect(closed).toBe(1);
  });

  it("最多同时打开四个文件，读取异常也释放句柄", async () => {
    const dir = await fixture();
    const entries = Array.from({ length: 12 }, (_, i) => entry(`file-${i}`));
    for (const file of entries) await writeFile(join(dir, file.path), "line\n");
    let active = 0;
    let peak = 0;
    io.open.mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      peak = Math.max(peak, ++active);
      if (String(args[0]).endsWith("file-0"))
        vi.spyOn(handle, "read").mockRejectedValue(new Error("read failed"));
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        try {
          await close();
        } finally {
          active--;
        }
      });
      return handle;
    });
    const stats = await buildUntrackedStats(dir, entries);
    expect(stats.get("file-0")?.added).toBe(0);
    expect(stats.get("file-11")?.added).toBe(1);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
  });

  it("文件在检查后增长仍只读预算加一个字节，不返回部分行数", async () => {
    const dir = await fixture();
    const path = join(dir, "growing");
    await writeFile(path, "small\n");
    let bytesRead = 0;
    let closed = false;
    io.open.mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        if (bytesRead === 0) await writeFile(path, "x\n".repeat(LIMIT));
        const result = await read(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed = true;
        await close();
      });
      return handle;
    });
    expect((await buildUntrackedStats(dir, [entry("growing")])).get("growing")?.added).toBe(0);
    expect(bytesRead).toBe(LIMIT + 1);
    expect(closed).toBe(true);
  });
});
