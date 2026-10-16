import { describe, expect, it } from "vitest";
import {
  buildTaskChangeSummary,
  buildPerTurnChangeSummaries,
} from "../src/session/taskChangeSummary.js";

describe("buildTaskChangeSummary", () => {
  it("按任务最终结果聚合同一文件的多轮改动", () => {
    const summary = buildTaskChangeSummary([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\n",
            afterContent: "line1\nline2\nline3\n",
            writeCount: 1,
          },
        ],
      },
      {
        turnIndex: 1,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\nline3\n",
            afterContent: "line0\nline1\nline2\nline3\n",
            writeCount: 2,
          },
          {
            path: "/repo/src/b.ts",
            beforeContent: null,
            afterContent: "new file\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    expect(summary).toEqual({
      fileCount: 2,
      added: 3,
      removed: 0,
      files: [
        {
          path: "/repo/src/a.ts",
          added: 2,
          removed: 0,
          writeCount: 3,
          lastTurnIndex: 1,
        },
        {
          path: "/repo/src/b.ts",
          added: 1,
          removed: 0,
          writeCount: 1,
          lastTurnIndex: 1,
        },
      ],
    });
  });

  it("文件最终回到原内容时仍保留触达记录", () => {
    const summary = buildTaskChangeSummary([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "same\n",
            afterContent: "changed\n",
            writeCount: 1,
          },
        ],
      },
      {
        turnIndex: 1,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "changed\n",
            afterContent: "same\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    expect(summary).toEqual({
      fileCount: 1,
      added: 0,
      removed: 0,
      files: [
        {
          path: "/repo/src/a.ts",
          added: 0,
          removed: 0,
          writeCount: 2,
          lastTurnIndex: 1,
        },
      ],
    });
  });
});

describe("buildPerTurnChangeSummaries", () => {
  it("returns per-turn summaries independently", () => {
    const summaries = buildPerTurnChangeSummaries([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\n",
            afterContent: "line1\nline2\nline3\n",
            writeCount: 1,
          },
        ],
      },
      {
        turnIndex: 1,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\nline3\n",
            afterContent: "line0\nline1\nline2\nline3\n",
            writeCount: 1,
          },
          {
            path: "/repo/src/b.ts",
            beforeContent: null,
            afterContent: "new file\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    expect(summaries.size).toBe(2);

    const turn0 = summaries.get(0)!;
    expect(turn0.fileCount).toBe(1);
    expect(turn0.added).toBe(1);
    expect(turn0.removed).toBe(0);
    expect(turn0.files).toHaveLength(1);
    expect(turn0.files[0]!.path).toBe("/repo/src/a.ts");

    const turn1 = summaries.get(1)!;
    expect(turn1.fileCount).toBe(2);
    expect(turn1.added).toBe(2);
    expect(turn1.removed).toBe(0);
  });

  it("deduplicates same file changed multiple times within one turn", () => {
    const summaries = buildPerTurnChangeSummaries([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\n",
            afterContent: "line1\nline2\n",
            writeCount: 1,
          },
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\n",
            afterContent: "line1\nline2\nline3\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    const turn0 = summaries.get(0)!;
    // Should be 1 file, not 2
    expect(turn0.fileCount).toBe(1);
    expect(turn0.files).toHaveLength(1);
    // Diff should be from original before to final after
    expect(turn0.files[0]!.path).toBe("/repo/src/a.ts");
    expect(turn0.files[0]!.added).toBe(2); // line2 + line3
    expect(turn0.files[0]!.removed).toBe(0);
    expect(turn0.files[0]!.writeCount).toBe(2);
  });

  it("returns empty map for undefined/empty input", () => {
    expect(buildPerTurnChangeSummaries(undefined).size).toBe(0);
    expect(buildPerTurnChangeSummaries([]).size).toBe(0);
  });

  it("skips turns with no actual line changes but still tracks them", () => {
    const summaries = buildPerTurnChangeSummaries([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "same\n",
            afterContent: "same\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    const turn0 = summaries.get(0)!;
    expect(turn0.fileCount).toBe(1);
    expect(turn0.added).toBe(0);
    expect(turn0.removed).toBe(0);
  });
});
