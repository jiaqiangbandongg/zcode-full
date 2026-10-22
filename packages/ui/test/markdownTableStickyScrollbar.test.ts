import { describe, expect, it } from "vitest";
import {
  resolveMarkdownTableStickyScrollbarMode,
  resolveMarkdownTableStickyScrollbarOffset,
} from "@/components/ai-elements/markdown-table.js";

describe("resolveMarkdownTableStickyScrollbarMode", () => {
  it("enables sticky markdown table scrollbars for tall content", () => {
    expect(
      resolveMarkdownTableStickyScrollbarMode({
        stickyScrollbarDisabled: false,
        viewportHeight: 800,
        dockHeight: 200,
        tableHeight: 500,
      }),
    ).toBe(true);
  });

  it("disables sticky markdown table scrollbars for opted-out subagent content", () => {
    expect(
      resolveMarkdownTableStickyScrollbarMode({
        stickyScrollbarDisabled: true,
        viewportHeight: 256,
        dockHeight: 200,
        tableHeight: 220,
      }),
    ).toBe(false);
  });
});

describe("resolveMarkdownTableStickyScrollbarOffset", () => {
  it("pins a long table scrollbar to the visible timeline bottom", () => {
    expect(
      resolveMarkdownTableStickyScrollbarOffset({
        frameTop: -87,
        frameBottom: 1211,
        scrollbarHeight: 26,
        viewportBottom: 921,
      }),
    ).toBe(-290);
  });

  it("keeps the scrollbar inside the current table boundaries", () => {
    expect(
      resolveMarkdownTableStickyScrollbarOffset({
        frameTop: 950,
        frameBottom: 2248,
        scrollbarHeight: 26,
        viewportBottom: 921,
      }),
    ).toBe(-1272);
    expect(
      resolveMarkdownTableStickyScrollbarOffset({
        frameTop: -1400,
        frameBottom: -102,
        scrollbarHeight: 26,
        viewportBottom: 921,
      }),
    ).toBe(0);
  });
});
