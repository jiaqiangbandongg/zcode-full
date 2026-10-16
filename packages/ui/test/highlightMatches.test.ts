import { describe, expect, it } from "vitest";
import { findTextMatchRanges } from "@/quickpick/HighlightedMatchText.js";

describe("findTextMatchRanges", () => {
  it("matches case-insensitive query parts", () => {
    expect(findTextMatchRanges("src/App.tsx", "SRC tsx")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it("merges overlapping ranges from multiple query parts", () => {
    expect(findTextMatchRanges("foobar", "foo foob")).toEqual([{ start: 0, end: 4 }]);
  });

  it("ignores empty and duplicate query parts", () => {
    expect(findTextMatchRanges("banana", "  an   an  ")).toEqual([{ start: 1, end: 5 }]);
  });

  it("returns no ranges when query is blank", () => {
    expect(findTextMatchRanges("App.tsx", "  ")).toEqual([]);
  });
});
