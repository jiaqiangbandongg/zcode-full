import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ModelTrajectoryPane scroll container", () => {
  it("uses native vertical scrolling without the Radix ScrollArea table wrapper", () => {
    const source = readFileSync("packages/ui/src/ModelTrajectoryPane.tsx", "utf8");
    const timelineSource = readFileSync("packages/ui/src/ModelTrajectoryTimeline.tsx", "utf8");

    // 侧栏改为独立外框后，旧边框字符串断言会误报；这里只验证轨迹自身的原生滚动与虚拟列表。

    expect(source).not.toContain("import { ScrollArea }");
    expect(source).not.toContain("<ScrollArea");
    expect(timelineSource).toContain("useVirtualizer");
    expect(timelineSource).toContain('data-trajectory-virtual-row=""');
    expect(timelineSource).toContain("measureElement");
    expect(timelineSource).toContain("getScrollElement");
    expect(timelineSource).toContain("overscan: 3");
    expect(source).toContain('data-trajectory-search-trigger=""');
    expect(source).toContain("ModelTrajectorySearchBar");
    expect(timelineSource).toContain("scrollToIndex");
    expect(timelineSource).toContain("isTrajectorySearchTargetMounted");
    expect(timelineSource).toContain("shouldAdjustScrollPositionOnItemSizeChange");
    expect(timelineSource).not.toContain("`${item.key}:${item.start}`");
    expect(source).toContain("TrajectorySearchRevealContext.Provider");
    expect(source).toContain('className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"');
    expect(source).not.toContain('className="px-3 py-2"');
    expect(source).not.toContain('className="border-t border-border"');
    expect(source).toContain('data-trajectory-header-divider=""');
    expect(source).toContain('className="flex shrink-0 flex-col px-3 py-2"');
    expect(source).not.toContain("defaultOpen={index === records.length - 1}");
  });
});
