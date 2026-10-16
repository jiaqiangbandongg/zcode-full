import { describe, expect, it } from "vitest";
import { getFileChangeFindState } from "@/GitPane/fileChangeFindSearch.js";
import { getGitPaneDiffFindContent } from "@/GitPane/helpers.js";

const contentA = [
  " const first = needle;",
  "-const oldValue = nope;",
  "+const newValue = Needle;",
].join("\n");

const contentB = [
  " const value = needle;",
].join("\n");

describe("fileChangeFindSearch", () => {
  it("collects matches across diff contents in file order", () => {
    const state = getFileChangeFindState(
      [
        { path: "/workspace/src/App.tsx", content: contentA },
        { path: "/workspace/src/Other.ts", content: contentB },
      ],
      "needle",
      0,
    );

    expect(state.total).toBe(3);
    expect(state.matches.map((match) => [match.path, match.matchIndexInFile])).toEqual([
      ["/workspace/src/App.tsx", 0],
      ["/workspace/src/App.tsx", 1],
      ["/workspace/src/Other.ts", 0],
    ]);
  });

  it("resolves the preferred global match to an active file match", () => {
    const state = getFileChangeFindState(
      [
        { path: "/workspace/src/App.tsx", content: contentA },
        { path: "/workspace/src/Other.ts", content: contentB },
      ],
      "needle",
      2,
    );

    expect(state.currentIndex).toBe(2);
    expect(state.activeMatch).toEqual({
      path: "/workspace/src/Other.ts",
      globalIndex: 2,
      matchIndexInFile: 0,
    });
  });

  it("returns an empty state before a diff is available", () => {
    const state = getFileChangeFindState([{ path: "/workspace/src/App.tsx", content: null }], "needle", 0);

    expect(state.total).toBe(0);
    expect(state.currentIndex).toBe(-1);
    expect(state.activeMatch).toBeNull();
  });

  it("searches only visible Git patch contents when the complete content pair is unavailable", () => {
    const path = "/workspace/src/App.tsx";
    const content = getGitPaneDiffFindContent({
      path,
      availability: "patch",
      patch: [
        "diff --git a/src/App.tsx b/src/App.tsx",
        "index 1111111..2222222 100644",
        "--- a/src/App.tsx",
        "+++ b/src/App.tsx",
        "@@ -1 +1,2 @@",
        " const app = true;",
        "+const needle = true;",
      ].join("\n"),
      beforeContent: null,
      afterContent: null,
      summary: null,
    });

    expect(content).toBe("const app = true;\nconst needle = true;");
    expect(getFileChangeFindState([{ path, content }], "needle", 0)).toMatchObject({
      total: 1,
      currentIndex: 0,
      activeMatch: {
        path,
        globalIndex: 0,
        matchIndexInFile: 0,
      },
    });
    expect(getFileChangeFindState([{ path, content }], "App.tsx", 0).total).toBe(0);
    expect(getFileChangeFindState([{ path, content }], "index", 0).total).toBe(0);
    expect(getFileChangeFindState([{ path, content }], "@@", 0).total).toBe(0);
  });
});
