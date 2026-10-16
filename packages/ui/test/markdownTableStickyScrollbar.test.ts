import { readFileSync } from "node:fs";
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

describe("markdown table sticky scrollbar lifecycle", () => {
  it("keeps the scrollbar mounted across visibility changes and observes V4 composer dock changes", () => {
    const source = readFileSync(
      "packages/ui/src/components/ai-elements/markdown-table.tsx",
      "utf8",
    );

    expect(source).toContain('className="my-0 flex min-w-0 flex-col gap-2"');
    expect(source).toContain(
      'data-markdown-table-virtual-scroll-visible={virtualScrollbarVisible ? "true" : "false"}',
    );
    expect(source).toContain(
      'data-markdown-table-virtual-scroll-sticky={',
    );
    expect(source).toContain('data-markdown-table-frame=""');
    expect(source).not.toContain("{virtualScrollbarVisible ? (");
    expect(source).toContain(
      "}, [virtualScrollbarSticky, virtualScrollbarVisible]);",
    );
    expect(source).toContain("resizeObserver?.observe(observedDock)");
    expect(source).toContain("new MutationObserver(syncDockObservation)");
    expect(source).toContain("readMarkdownTableBackToBottomClearance(root)");
  });
});
