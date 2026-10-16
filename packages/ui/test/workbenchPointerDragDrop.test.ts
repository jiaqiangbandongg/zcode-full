// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelWorkbenchPointerDrag,
  finishWorkbenchPointerDrag,
  registerWorkbenchPointerDropTarget,
  updateWorkbenchPointerDrag,
} from "@/v4/workbenchPointerDragDrop.js";

afterEach(() => {
  cancelWorkbenchPointerDrag();
  document.body.replaceChildren();
});

describe("workbench pointer drag/drop bridge", () => {
  it("previews and drops a grouped task at the matching pane edge", () => {
    const element = document.createElement("div");
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      bottom: 220,
      height: 200,
      left: 20,
      right: 420,
      top: 20,
      width: 400,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    });
    const onPreview = vi.fn();
    const onDrop = vi.fn();
    const payload = {
      kind: "zcode/session" as const,
      workspacePath: "/repo",
      workspaceIdentity: "ssh:host:/repo",
      remoteSessionId: "remote-1",
      sessionId: "task-1",
    };
    const unregister = registerWorkbenchPointerDropTarget(element, {
      canDrop: () => true,
      onDrop,
      onPreview,
    });

    expect(updateWorkbenchPointerDrag(payload, 30, 120)).toBe(true);
    expect(onPreview).toHaveBeenLastCalledWith("left");
    expect(finishWorkbenchPointerDrag(payload, 30, 120)).toBe(true);
    expect(onDrop).toHaveBeenCalledWith("left", payload);
    expect(onPreview).toHaveBeenLastCalledWith(null);

    unregister();
  });

  it("keeps the pane inactive in its center and after cancellation", () => {
    const element = document.createElement("div");
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      bottom: 220,
      height: 200,
      left: 20,
      right: 420,
      top: 20,
      width: 400,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    });
    const onPreview = vi.fn();
    const unregister = registerWorkbenchPointerDropTarget(element, {
      onDrop: vi.fn(),
      onPreview,
    });
    const payload = {
      kind: "zcode/session" as const,
      workspacePath: "/repo",
      sessionId: "task-1",
    };

    expect(updateWorkbenchPointerDrag(payload, 30, 120)).toBe(true);
    expect(updateWorkbenchPointerDrag(payload, 220, 120)).toBe(false);
    cancelWorkbenchPointerDrag();
    expect(onPreview).toHaveBeenLastCalledWith(null);

    unregister();
  });
});
