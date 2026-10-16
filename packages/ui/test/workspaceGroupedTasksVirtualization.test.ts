import type { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it, vi } from "vitest";
import {
  GROUPED_TASK_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeGroupedTasks,
} from "@/workspace-grouped-tasks/virtualized-group-task-list.js";
import {
  GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeGroupedTopLevelNodes,
} from "@/workspace-grouped-tasks/virtualized-top-level-list.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/workspace-grouped-tasks/virtualized-scroll.js";

describe("workspace grouped task virtualization", () => {
  it("only virtualizes large groups", () => {
    expect(shouldVirtualizeGroupedTasks(GROUPED_TASK_VIRTUALIZATION_THRESHOLD)).toBe(false);
    expect(shouldVirtualizeGroupedTasks(GROUPED_TASK_VIRTUALIZATION_THRESHOLD + 1)).toBe(true);
  });

  it("only virtualizes large top-level grouped task views", () => {
    expect(shouldVirtualizeGroupedTopLevelNodes(GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD)).toBe(
      false,
    );
    expect(shouldVirtualizeGroupedTopLevelNodes(GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD + 1))
      .toBe(true);
  });

  it("treats overflow auto containers as scroll targets before content overflows", () => {
    expect(isPotentialVerticalScrollContainer("auto")).toBe(true);
    expect(isPotentialVerticalScrollContainer("scroll")).toBe(true);
    expect(isPotentialVerticalScrollContainer("overlay")).toBe(true);
    expect(isPotentialVerticalScrollContainer("hidden")).toBe(false);
    expect(isPotentialVerticalScrollContainer("visible")).toBe(false);
  });

  it("ignores stale initial zero scroll sync after a virtual list remounts mid-scroll", () => {
    const scrollTo = vi.fn();
    const scrollElement = {
      scrollTop: 65052,
      scrollTo,
    } as unknown as HTMLDivElement;
    const virtualizer = {
      scrollElement,
      scrollOffset: 0,
      options: { horizontal: false },
    } as unknown as Virtualizer<HTMLDivElement, Element>;

    scrollGroupedTaskVirtualizerToOffset(0, {}, virtualizer);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps normal virtualizer scroll requests", () => {
    const scrollTo = vi.fn();
    const scrollElement = {
      scrollTop: 65052,
      scrollTo,
    } as unknown as HTMLDivElement;
    const virtualizer = {
      scrollElement,
      scrollOffset: 65052,
      options: { horizontal: false },
    } as unknown as Virtualizer<HTMLDivElement, Element>;

    scrollGroupedTaskVirtualizerToOffset(120, { adjustments: 5 }, virtualizer);

    expect(scrollTo).toHaveBeenCalledWith({ top: 125, behavior: undefined });
  });
});
