import { describe, expect, it } from "vitest";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
} from "@zcode/shared/workspaceFileSearch";
import {
  buildHostFileSearchCandidates,
  searchHostFileCandidates,
} from "../src/file/workspaceFileSearch.js";

describe("Host 分批文件搜索", () => {
  it("跨批次保持原 fuzzy 排序和默认顺序，并让出 Host 事件循环", async () => {
    const entries: WorkspaceFileEntry[] = Array.from({ length: 9000 }, (_, index) => {
      const name = index === 3000 ? "tab\tnewline\n中文.ts" : `file-${index % 31}-${index}.ts`;
      const relativePath = `src/${index % 7}/${name}`;
      return {
        name,
        relativePath,
        path: `/repo/${relativePath}`,
        type: index % 8 ? "file" : "directory",
      };
    });
    const candidates = await buildHostFileSearchCandidates(
      packWorkspaceFileEntries(entries),
      "/repo",
    );
    expect(candidates).toEqual(mapWorkspaceFileEntriesToSearchCandidates(entries));
    for (const query of ["", "file", "f-2", "src/5", "中文", "no-match-999999"]) {
      for (const limit of [1, 10, 1000]) {
        expect(
          (await searchHostFileCandidates(candidates, query, limit)).map(
            (entry) => entry.relativePath,
          ),
        ).toEqual(
          filterWorkspaceFileSearchCandidates(candidates, query, { limit }).map(
            (entry) => entry.relativePath,
          ),
        );
      }
    }
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    await searchHostFileCandidates(candidates, "file", 1000);
    expect(yielded).toBe(true);
  });
});
