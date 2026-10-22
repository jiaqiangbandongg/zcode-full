import { describe, expect, it } from "vitest";
import { resolveSidePaneTabsOverflow } from "../src/app-shell/sidePaneLayout.js";

describe("side pane tab strip layout", () => {
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
