import { describe, expect, it } from "vitest";
import {
  columnName,
  formatAnchor,
  formatLocator,
  parseAnchor,
  parseCell,
  parseLocator,
  splitAnchor,
} from "#office/domain/anchor.ts";

describe("anchors", () => {
  it("round-trips every locator form", () => {
    const cases: [Parameters<typeof parseLocator>[0], string][] = [
      ["docx", "p:14"],
      ["docx", "p:3-9"],
      ["docx", "t:2"],
      ["docx", "t:2/r3c1"],
      ["pptx", "slide:3"],
      ["pptx", "slide:2-4"],
      ["pptx", "slide:3/shape:7"],
      ["pdf", "page:5"],
      ["pdf", "page:2-4"],
      ["xlsx", "Revenue"],
      ["xlsx", "Revenue!B2"],
      ["xlsx", "Revenue!B2:F9"],
      ["xlsx", "'Q3 data'!A1:C2"],
      ["xlsx", "'It''s'!A1"],
    ];
    for (const [kind, text] of cases) expect(formatLocator(parseLocator(kind, text))).toBe(text);
  });

  it("normalises ranges and accepts repeated prefixes", () => {
    expect(formatLocator(parseLocator("xlsx", "Sheet1!C5:A1"))).toBe("Sheet1!A1:C5");
    expect(formatLocator(parseLocator("pdf", "page:2-page:4"))).toBe("page:2-4");
    expect(formatLocator(parseLocator("docx", "P:7"))).toBe("p:7");
    expect(formatLocator(parseLocator("xlsx", "Sheet1!$B$2"))).toBe("Sheet1!B2");
  });

  it("rejects malformed locators with a hint", () => {
    expect(() => parseLocator("pdf", "page:0")).toThrow(/page:N/);
    expect(() => parseLocator("pdf", "page:4-2")).toThrow();
    expect(() => parseLocator("docx", "slide:1")).toThrow(/p:N/);
    expect(() => parseLocator("pptx", "slide:x")).toThrow();
    expect(() => parseLocator("xlsx", "Sheet!ZZZZ1")).toThrow();
    expect(() => parseLocator("xlsx", "'open!A1")).toThrow();
  });

  it("splits anchors at the document extension", () => {
    expect(splitAnchor("docs/q3 #1.docx#p:4")).toEqual({ path: "docs/q3 #1.docx", at: "p:4" });
    expect(splitAnchor("model.xlsx#Sheet#2!A1")).toEqual({ path: "model.xlsx", at: "Sheet#2!A1" });
    expect(splitAnchor("deck.PPTX")).toEqual({ path: "deck.PPTX", at: null });
    expect(() => splitAnchor("notes.txt#1")).toThrow(/not a document anchor/);
    expect(parseAnchor("a/b.pdf#page:3").locator).toEqual({ kind: "pdf", from: 3, to: 3 });
    expect(formatAnchor("a.pdf", null)).toBe("a.pdf");
  });

  it("converts columns", () => {
    expect(columnName(1)).toBe("A");
    expect(columnName(26)).toBe("Z");
    expect(columnName(27)).toBe("AA");
    expect(columnName(16384)).toBe("XFD");
    expect(parseCell("xfd1048576")).toEqual({ row: 1048576, col: 16384 });
    expect(parseCell("XFE1")).toBeNull();
  });
});
