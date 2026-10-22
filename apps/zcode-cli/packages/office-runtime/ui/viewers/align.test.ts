import { describe, expect, it } from "vitest";
import { alignBlocks } from "#ui/viewers/align.ts";

const blocks = [
  { at: "p:1", text: "Title" },
  { at: "p:2", text: "First paragraph that spans two pages." },
  { at: "t:1", text: "a b c d" },
  { at: "p:3", text: "" },
  { at: "p:4", text: "Last" },
];

describe("alignBlocks", () => {
  it("maps elements in order, including split paragraphs and empty ones", () => {
    const elements = [
      { text: "Title", table: false },
      { text: "First paragraph that", table: false },
      { text: " spans two pages.", table: false },
      { text: "a b c d", table: true },
      { text: "", table: false },
      { text: "Last", table: false },
    ];
    expect(alignBlocks(elements, blocks)).toEqual(["p:1", "p:2", "p:2", "t:1", "p:3", "p:4"]);
  });

  it("skips unknown elements and resynchronises", () => {
    const elements = [
      { text: "Title", table: false },
      { text: "Rendered only by the viewer", table: false },
      { text: "First paragraph that spans two pages.", table: false },
      { text: "Last", table: false },
    ];
    expect(alignBlocks(elements, blocks)).toEqual(["p:1", null, "p:2", "p:4"]);
  });
});
