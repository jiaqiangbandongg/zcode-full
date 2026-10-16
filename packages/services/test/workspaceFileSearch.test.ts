import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileService } from "../src/file/fileService.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
} from "@zcode/shared/workspaceFileSearch";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const roots: string[] = [];
async function workspace() {
  const rootPath = await mkdtemp(join(tmpdir(), "mention-host-search-"));
  roots.push(rootPath);
  await writeFile(join(rootPath, ".zcodeignore"), "node_modules/\n");
  await mkdir(join(rootPath, "src"));
  await Promise.all(
    ["Main.ts", "main.test.ts", "README.md", "中文.txt"].map((name) =>
      writeFile(join(rootPath, "src", name), "fixture"),
    ),
  );
  return rootPath;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Host 文件候选查询", () => {
  it("显式刷新完成后旧扫描不能覆盖新缓存", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    const { readdir } = await vi.importActual<typeof fsPromises>("node:fs/promises");
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(fsPromises.readdir).mockImplementationOnce(async (...args) => {
      const entries = await readdir(...args);
      entered();
      await paused;
      return entries;
    });
    const old = service.searchWorkspaceFiles({ rootPath, query: "race-987654" });
    await started;
    try {
      await writeFile(join(rootPath, "race-987654.ts"), "new");
      expect(
        await service.searchWorkspaceFiles({ rootPath, query: "race-987654", refresh: true }),
      ).toHaveLength(1);
    } finally {
      release();
    }
    expect(await old).toEqual([]);
    expect(await service.searchWorkspaceFiles({ rootPath, query: "race-987654" })).toHaveLength(1);
  });

  it("缓存按 LRU 有界，过期索引重新扫描", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    for (const identity of ["a", "b", "c", "d", "e"]) {
      await service.searchWorkspaceFiles({ rootPath, workspaceIdentity: identity, query: "" });
    }
    await writeFile(join(rootPath, "lru-987654.ts"), "new");
    expect(
      await service.searchWorkspaceFiles({ rootPath, workspaceIdentity: "a", query: "lru-987654" }),
    ).toHaveLength(1);
    expect(
      await service.searchWorkspaceFiles({ rootPath, workspaceIdentity: "e", query: "lru-987654" }),
    ).toEqual([]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    expect(
      await service.searchWorkspaceFiles({ rootPath, workspaceIdentity: "e", query: "lru-987654" }),
    ).toHaveLength(1);
  });

  it("调用方过大的 limit 仍最多返回 1000 条", async () => {
    const rootPath = await workspace();
    await Promise.all(
      Array.from({ length: 1005 }, (_, index) => writeFile(join(rootPath, `cap-${index}.ts`), "")),
    );
    expect(
      await createFileService().searchWorkspaceFiles({ rootPath, query: "", limit: 100_000 }),
    ).toHaveLength(1000);
  });

  it("复用原索引规则和 fuzzy 排序，只返回限定候选", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    const length = await service.listWorkspaceFilesLength({ rootPath });
    const packed = await service.listWorkspaceFilesRange({ rootPath, offset: 0, length });
    const candidates = mapWorkspaceFileEntriesToSearchCandidates(
      unpackWorkspaceFileEntries(packed, rootPath),
    );
    for (const query of ["", "main", "MAIN", "src/", "中文", "not-present"]) {
      const actual = await service.searchWorkspaceFiles({ rootPath, query, limit: 2 });
      expect(actual.map((entry) => entry.relativePath)).toEqual(
        filterWorkspaceFileSearchCandidates(candidates, query, { limit: 2 }).map(
          (entry) => entry.relativePath,
        ),
      );
      expect(actual.length).toBeLessThanOrEqual(2);
      expect(actual.every((entry) => Object.keys(entry).length === 4)).toBe(true);
    }
  });

  it("普通查询复用索引，显式补扫可以发现刚创建的文件", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    expect(await service.searchWorkspaceFiles({ rootPath, query: "new-987654321" })).toEqual([]);
    await writeFile(join(rootPath, "new-987654321.ts"), "new");
    expect(await service.searchWorkspaceFiles({ rootPath, query: "new-987654321" })).toEqual([]);
    expect(
      await service.searchWorkspaceFiles({ rootPath, query: "new-987654321", refresh: true }),
    ).toEqual([
      {
        name: "new-987654321.ts",
        relativePath: "new-987654321.ts",
        path: join(rootPath, "new-987654321.ts"),
        type: "file",
      },
    ]);
  });

  it("不同 identity / service 的同路径查询不复用旧索引", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    await service.searchWorkspaceFiles({ rootPath, workspaceIdentity: "host-a", query: "" });
    await writeFile(join(rootPath, "new-identity.ts"), "new");
    expect(
      await service.searchWorkspaceFiles({
        rootPath,
        workspaceIdentity: "host-a",
        query: "new-identity",
      }),
    ).toEqual([]);
    expect(
      await service.searchWorkspaceFiles({
        rootPath,
        workspaceIdentity: "host-b",
        query: "new-identity",
      }),
    ).toHaveLength(1);
    expect(
      await createFileService().searchWorkspaceFiles({
        rootPath,
        workspaceIdentity: "host-a",
        query: "new-identity",
      }),
    ).toHaveLength(1);
  });

  it("修改忽略规则后下一次查询立即生效", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    expect(await service.searchWorkspaceFiles({ rootPath, query: "Main.ts" })).toHaveLength(2);
    await service.writeWorkspaceFileSearchIgnore({ rootPath, content: "src/\n" });
    expect(await service.searchWorkspaceFiles({ rootPath, query: "Main.ts" })).toEqual([]);
  });

  it("零上限返回空，非法上限被拒绝，缺失目录保持空列表语义", async () => {
    const rootPath = await workspace();
    const service = createFileService();
    expect(await service.searchWorkspaceFiles({ rootPath, query: "", limit: 0 })).toEqual([]);
    await expect(
      service.searchWorkspaceFiles({ rootPath, query: "", limit: Number.NaN }),
    ).rejects.toThrow();
    expect(
      await service.searchWorkspaceFiles({ rootPath: join(rootPath, "missing"), query: "" }),
    ).toEqual([]);
  });
});
