import { describe, expect, it } from "vitest";
import { resolveMarkdownTableVirtualScrollMax } from "@/components/ai-elements/markdown-table.js";

describe("resolveMarkdownTableVirtualScrollMax", () => {
  it("keeps the fractional layout width as the stable overflow authority", () => {
    const tableWidth = 491.5703125;
    const layoutTrackWidth = 490.3125;

    const scrollMax = resolveMarkdownTableVirtualScrollMax({
      tableWidth,
      trackWidth: layoutTrackWidth,
    });

    expect(scrollMax).toBeCloseTo(1.2578125, 8);
    expect(scrollMax).toBeGreaterThan(1);
  });

  it("does not report overflow at or below the existing one-pixel threshold", () => {
    expect(
      resolveMarkdownTableVirtualScrollMax({
        tableWidth: 491,
        trackWidth: 490,
      }),
    ).toBe(1);
    expect(
      resolveMarkdownTableVirtualScrollMax({
        tableWidth: 489.5,
        trackWidth: 490,
      }),
    ).toBe(0);
  });
});
