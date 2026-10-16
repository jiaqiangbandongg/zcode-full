import { describe, expect, it } from "vitest";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
} from "@/workspace-file-search/workspaceFileSearch.js";

function entry(relativePath: string, type: WorkspaceFileEntry["type"] = "file") {
  const name = relativePath.split("/").pop() ?? relativePath;
  return {
    name,
    path: `/workspace/${relativePath}`,
    relativePath,
    type,
  } satisfies WorkspaceFileEntry;
}

describe("workspace file search", () => {
  it("matches by file name, relative path and fuzzy class-name query", () => {
    const candidates = mapWorkspaceFileEntriesToSearchCandidates([
      entry("src/main/java/com/example/user/UserProfileService.java"),
      entry("src/main/java/com/example/user/UserProfileController.java"),
      entry("docs/profile-service.md"),
    ]);

    expect(
      filterWorkspaceFileSearchCandidates(candidates, "UserProfileService").map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual(["src/main/java/com/example/user/UserProfileService.java"]);
    expect(
      filterWorkspaceFileSearchCandidates(candidates, "com/example/user").map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual([
      "src/main/java/com/example/user/UserProfileService.java",
      "src/main/java/com/example/user/UserProfileController.java",
    ]);
    expect(
      filterWorkspaceFileSearchCandidates(candidates, "upsrv").map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual(["src/main/java/com/example/user/UserProfileService.java"]);
  });

  it("keeps file-before-directory empty-query priority compatible with @ files", () => {
    const candidates = mapWorkspaceFileEntriesToSearchCandidates([
      entry("src", "directory"),
      entry("README.md"),
      entry("docs", "directory"),
      entry("package.json"),
    ]);

    expect(
      filterWorkspaceFileSearchCandidates(candidates, "").map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual(["README.md", "package.json", "src", "docs"]);
  });

  it("keeps the best limited matches without sorting every candidate", () => {
    const candidates = mapWorkspaceFileEntriesToSearchCandidates([
      entry("docs/unrelated-0.md"),
      entry("src/target-service.ts"),
      entry("src/target-controller.ts"),
      entry("docs/unrelated-1.md"),
    ]);

    expect(
      filterWorkspaceFileSearchCandidates(candidates, "target", { limit: 2 }).map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual(["src/target-service.ts", "src/target-controller.ts"]);
  });

  it("evicts the worst scored matches when matches exceed the limit", () => {
    // 覆盖"命中数超过 limit 需要淘汰已插入元素"：前缀匹配（低分）必须把
    // 先插入的子串匹配（高分）挤出 top-K，且结果保持 score 升序稳定。
    const candidates = mapWorkspaceFileEntriesToSearchCandidates([
      entry("docs/xtarget-old.md"),
      entry("docs/my-target-notes.md"),
      entry("src/target-best.ts"),
      entry("src/target-mid.ts"),
      entry("src/target.ts"),
    ]);

    expect(
      filterWorkspaceFileSearchCandidates(candidates, "target", { limit: 2 }).map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual(["src/target.ts", "src/target-mid.ts"]);
  });

  it("matches full sort ordering at scale without relying on insertion scan", () => {
    // 大规模候选等价性：top-K 维护必须与"全量排序后截断"的参考实现产出完全一致。
    // 用确定性伪随机生成大量含公共子串的候选，确保命中数远超 limit、充分覆盖淘汰路径。
    const entries: WorkspaceFileEntry[] = [];
    let seed = 0x2f6e2b1;
    const nextSeed = () => {
      seed = (Math.imul(seed, 48271) + 11) >>> 0;
      return seed;
    };
    for (let i = 0; i < 20000; i += 1) {
      const bucket = nextSeed() % 40;
      const stamp = nextSeed().toString(36);
      entries.push(
        entry(`pkg-${bucket}/mod-${bucket}/target-${stamp}-${i}.ts`, i % 500 === 0 ? "directory" : "file"),
      );
    }
    const candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
    const limit = 50;

    // 参考实现：与 compareScoredWorkspaceFileSearchCandidates 相同的
    // score 升序 → 原始 index 升序，全量排序后截断（旧语义）。
    const reference: Array<{ relativePath: string; score: number; index: number }> = [];
    for (const [index, candidate] of candidates.entries()) {
      const text = candidate.name.toLowerCase();
      const query = "target";
      let score: number;
      if (text.startsWith(query)) {
        score = text.length - query.length;
      } else {
        const at = text.indexOf(query);
        if (at === -1) continue;
        score = 100 + at;
      }
      reference.push({ relativePath: candidate.relativePath, score, index });
    }
    const referencePaths = reference
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .slice(0, limit)
      .map((item) => item.relativePath);

    expect(
      filterWorkspaceFileSearchCandidates(candidates, "target", { limit }).map(
        (candidate) => candidate.relativePath,
      ),
    ).toEqual(referencePaths);
  });
});
