import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSidePaneTabsOverflow } from "../src/app-shell/sidePaneLayout.js";

const source = readFileSync(
  new URL("../src/app-shell/AnimatedSidePanePanel.tsx", import.meta.url),
  "utf8",
);

describe("side pane tab strip layout", () => {
  it("lets tabs share the viewport before overflowing at their minimum width", () => {
    expect(source).toContain("ref={tabsScrollContentRef}");
    expect(source).toContain('data-side-pane-tabs-content=""');
    expect(source).toContain('className="flex w-full gap-1 py-2.5"');
    expect(source).not.toContain(
      '<div ref={tabsScrollContentRef} className="flex w-max py-2.5 gap-2">',
    );
  });

  it("keeps the add-tab menu beside tabs until scrolling begins", () => {
    expect(source).toContain("!isTabsOverflowing ? addTabMenu : null");
    expect(source).toContain("isTabsOverflowing ? addTabMenu : null");
  });

  it.each([
    { tabCount: 3, insideViewportWidth: 220, outsideViewportWidth: 188 },
    { tabCount: 4, insideViewportWidth: 284, outsideViewportWidth: 252 },
    { tabCount: 5, insideViewportWidth: 348, outsideViewportWidth: 316 },
  ])(
    "keeps the overflow decision stable when the add button moves for $tabCount tabs",
    ({ tabCount, insideViewportWidth, outsideViewportWidth }) => {
      expect(
        resolveSidePaneTabsOverflow({
          addButtonInside: true,
          addButtonWidth: 32,
          tabCount,
          viewportWidth: insideViewportWidth,
        }),
      ).toBe(true);
      expect(
        resolveSidePaneTabsOverflow({
          addButtonInside: false,
          addButtonWidth: 32,
          tabCount,
          viewportWidth: outsideViewportWidth,
        }),
      ).toBe(true);
      expect(
        resolveSidePaneTabsOverflow({
          addButtonInside: true,
          addButtonWidth: 32,
          tabCount,
          viewportWidth: insideViewportWidth + 10,
        }),
      ).toBe(false);
      expect(
        resolveSidePaneTabsOverflow({
          addButtonInside: false,
          addButtonWidth: 32,
          tabCount,
          viewportWidth: outsideViewportWidth + 10,
        }),
      ).toBe(false);
    },
  );
});
