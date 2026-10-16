import { describe, expect, it } from "vitest";
import type { ZCodeTaskChangeSummary } from "@zcode/shared";
import { formatGroupedTaskHoverChangeParts } from "@/workspace-grouped-tasks/task-row-tooltip.js";

function createChangeSummary(
  added: number,
  removed: number,
): ZCodeTaskChangeSummary {
  return {
    fileCount: 1,
    added,
    removed,
    files: [
      {
        path: "/workspace/file.ts",
        added,
        removed,
        writeCount: 1,
        lastTurnIndex: 1,
      },
    ],
  };
}

describe("grouped task row tooltip", () => {
  it("formats non-zero change stats for the hover tooltip", () => {
    expect(formatGroupedTaskHoverChangeParts(createChangeSummary(5, 2))).toEqual([
      "+5",
      "-2",
    ]);
  });

  it("omits zero change stats", () => {
    expect(formatGroupedTaskHoverChangeParts(createChangeSummary(0, 3))).toEqual([
      "-3",
    ]);
    expect(formatGroupedTaskHoverChangeParts(createChangeSummary(0, 0))).toEqual(
      [],
    );
  });
});
