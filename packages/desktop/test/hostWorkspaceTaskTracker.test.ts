import { describe, expect, it, vi } from "vitest";
import { createHostWorkspaceTaskTracker } from "../src/host/hostWorkspaceTaskTracker.js";

describe("createHostWorkspaceTaskTracker", () => {
  it("reports workspace running task transitions independently", () => {
    const report = vi.fn();
    const tracker = createHostWorkspaceTaskTracker(report);
    const workspaceA = {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:a",
    };
    const workspaceB = { workspacePath: "/work/b" };

    expect(tracker.begin("task-a-1", workspaceA)).toBe(true);
    expect(tracker.begin("task-a-2", workspaceA)).toBe(true);
    expect(tracker.begin("task-b", workspaceB)).toBe(true);
    expect(tracker.begin("task-a-1", workspaceA)).toBe(false);

    expect(report.mock.calls).toEqual([
      [{ ...workspaceA, runningTaskCount: 1 }],
      [{ ...workspaceA, runningTaskCount: 2 }],
      [{ ...workspaceB, runningTaskCount: 1 }],
    ]);
    expect(tracker.getRunningTaskCount(workspaceA)).toBe(2);
    expect(tracker.getRunningTaskCount(workspaceB)).toBe(1);
    expect(tracker.getTotalRunningTaskCount()).toBe(3);

    // sendPrompt Promise 此时只返回 ACK；未收到 session ready 前不能减少 active run。
    expect(tracker.getRunningTaskCount(workspaceA)).toBe(2);

    tracker.finish("task-a-1", workspaceA);
    tracker.finish("task-a-1", workspaceA);
    tracker.finish("task-b", workspaceB);
    tracker.finish("task-a-2", workspaceA);

    expect(report.mock.calls.slice(3)).toEqual([
      [{ ...workspaceA, runningTaskCount: 1 }],
      [{ ...workspaceB, runningTaskCount: 0 }],
      [{ ...workspaceA, runningTaskCount: 0 }],
    ]);
    expect(tracker.getRunningTaskCount(workspaceA)).toBe(0);
    expect(tracker.getRunningTaskCount(workspaceB)).toBe(0);
    expect(tracker.getTotalRunningTaskCount()).toBe(0);
  });

  it("clears only the released workspace and reports its ready state", () => {
    const report = vi.fn();
    const tracker = createHostWorkspaceTaskTracker(report);
    const workspaceA = {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:a",
    };
    const workspaceB = {
      workspacePath: "/work/b",
      workspaceIdentity: "remote:wsl:b",
    };

    tracker.begin("task-a", workspaceA);
    tracker.begin("task-b", workspaceB);
    tracker.clearWorkspace(workspaceA);

    expect(tracker.getRunningTaskCount(workspaceA)).toBe(0);
    expect(tracker.getRunningTaskCount(workspaceB)).toBe(1);
    expect(tracker.getTotalRunningTaskCount()).toBe(1);
    expect(report).toHaveBeenLastCalledWith({ ...workspaceA, runningTaskCount: 0 });
  });
});
