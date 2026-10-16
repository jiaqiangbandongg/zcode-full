import type { WorkspaceFileEntry } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import { createSyncWorkspaceFileSearchFilterBackend } from "@/workspace-file-search/workspaceFileSearchFilterBackend.js";

function entry(partial: Partial<WorkspaceFileEntry> & { relativePath: string }): WorkspaceFileEntry {
  return {
    name: partial.relativePath.split("/").pop() ?? partial.relativePath,
    path: partial.path ?? `x:/ws/${partial.relativePath}`,
    relativePath: partial.relativePath,
    type: partial.type ?? "file",
  };
}

describe("workspace file search filter backend", () => {
  it("round-trips entries through the columnar packing format", () => {
    const entries = [
      entry({ relativePath: "src/index.ts" }),
      entry({ relativePath: "docs", type: "directory" }),
      entry({ relativePath: "packages/ui/src/weird name.md" }),
    ];
    expect(unpackWorkspaceFileEntries(packWorkspaceFileEntries(entries), "x:/ws")).toEqual(entries);
  });

  it("escapes tab, newline and backslash in file names", () => {
    // Unix 文件名可含 \t、\n、\\，列式格式必须无损往返。
    const entries = [
      entry({ relativePath: "a\tb.ts", name: "a\tb.ts" }),
      entry({ relativePath: "c\nd.md", name: "c\nd.md" }),
      entry({ relativePath: "e\\f.txt", name: "e\\f.txt" }),
      entry({ relativePath: "mix\t\\n\nend.js", name: "mix\t\\n\nend.js" }),
    ];
    expect(unpackWorkspaceFileEntries(packWorkspaceFileEntries(entries), "x:/ws")).toEqual(entries);
  });

  it("handles empty entry lists", () => {
    expect(packWorkspaceFileEntries([])).toBe("");
    expect(unpackWorkspaceFileEntries("", "x:/ws")).toEqual([]);
  });

  it("filters and maps back to entries via the sync backend", async () => {
    const backend = createSyncWorkspaceFileSearchFilterBackend();
    backend.setPacked(
      packWorkspaceFileEntries([
        entry({ relativePath: "src/target.ts" }),
        entry({ relativePath: "docs/other.md" }),
        entry({ relativePath: "src", type: "directory" }),
      ]),
      "x:/ws",
    );

    await expect(
      backend.filter("target", { requireQuery: false, limit: 10 }),
    ).resolves.toEqual([entry({ relativePath: "src/target.ts" })]);

    // 空 query + requireQuery:false 走默认排序（文件先于目录）。
    const emptyQuery = await backend.filter("", { requireQuery: false, limit: 10 });
    expect(emptyQuery?.map((item) => item.relativePath)).toEqual([
      "src/target.ts",
      "docs/other.md",
      "src",
    ]);

    backend.dispose();
    await expect(backend.filter("target", {})).resolves.toEqual([]);
  });
});
