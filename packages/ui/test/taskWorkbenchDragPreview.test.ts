// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("task workbench drag preview", () => {
  it("keeps the task item content and only adds the grouped surface styles", () => {
    const source = document.createElement("li");
    source.className = "task-row rounded-md";
    source.innerHTML =
      '<span>Long project task title</span><button aria-label="Open task actions">...</button>';
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
      bottom: 72,
      height: 32,
      left: 20,
      right: 260,
      top: 40,
      width: 240,
      x: 20,
      y: 40,
      toJSON: () => ({}),
    });
    const setDragImage = vi.fn();

    const cleanup = createTaskWorkbenchDragPreview({
      clientX: 80,
      clientY: 52,
      dataTransfer: { setDragImage },
      source,
    });

    const preview = document.querySelector<HTMLElement>(
      '[data-task-workbench-drag-preview="true"]',
    );
    expect(preview?.innerHTML).toBe(source.innerHTML);
    expect(preview?.className).toContain("task-row");
    expect(preview?.className).toContain("border");
    expect(preview?.className).toContain("border-border");
    expect(preview?.className).toContain("bg-background");
    expect(preview?.className).toContain("shadow-lg");
    expect(preview?.className).not.toContain("cursor-grabbing");
    expect(preview?.style.width).toBe("240px");
    expect(setDragImage).toHaveBeenCalledWith(preview, 60, 12);

    cleanup();
    expect(preview?.isConnected).toBe(false);
  });
});
