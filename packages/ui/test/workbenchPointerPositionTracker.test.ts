// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createWorkbenchPointerPositionTracker } from "@/v4/workbenchPointerPositionTracker.js";

describe("workbench pointer position tracker", () => {
  it("keeps the latest real viewport pointer position independent of layout delta", () => {
    const tracker = createWorkbenchPointerPositionTracker(
      document,
      new MouseEvent("pointerdown", { clientX: 40, clientY: 60 }),
    );
    expect(tracker?.getPosition()).toEqual({ x: 40, y: 60 });

    // 模拟 grouped 容器自动滚动后，指针仍停留在同一个 viewport 坐标。
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 40, clientY: 60 }),
    );
    document.documentElement.scrollTop = 240;
    document.dispatchEvent(new Event("scroll"));
    expect(tracker?.getPosition()).toEqual({ x: 40, y: 60 });

    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 420, clientY: 180 }),
    );
    expect(tracker?.getPosition()).toEqual({ x: 420, y: 180 });

    tracker?.dispose();
  });

  it("stops observing pointer movement after disposal", () => {
    const tracker = createWorkbenchPointerPositionTracker(
      document,
      new MouseEvent("pointerdown", { clientX: 10, clientY: 20 }),
    );
    tracker?.dispose();

    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 80, clientY: 90 }),
    );
    expect(tracker?.getPosition()).toEqual({ x: 10, y: 20 });
  });

  it("records the release position when the activating move is the only move", () => {
    const tracker = createWorkbenchPointerPositionTracker(
      document,
      new MouseEvent("pointerdown", { clientX: 10, clientY: 20 }),
    );

    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 420, clientY: 180 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 430, clientY: 190 }),
    );
    expect(tracker?.getPosition()).toEqual({ x: 430, y: 190 });

    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 80, clientY: 90 }),
    );
    expect(tracker?.getPosition()).toEqual({ x: 430, y: 190 });
  });
});
