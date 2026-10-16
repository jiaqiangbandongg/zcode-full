import { describe, expect, it, vi } from "vitest";
import { runWorkspaceVisibleCommand } from "@/lib/workspaceVisibleCommand.js";

describe("runWorkspaceVisibleCommand", () => {
  it("returns to workspace before running a workspace command hidden behind settings", () => {
    const calls: string[] = [];

    runWorkspaceVisibleCommand({
      isWorkspaceVisible: false,
      onReturnToWorkspace: () => calls.push("return"),
      run: () => calls.push("command"),
    });

    expect(calls).toEqual(["return", "command"]);
  });

  it("runs directly when workspace is already visible", () => {
    const onReturnToWorkspace = vi.fn();
    const run = vi.fn();

    runWorkspaceVisibleCommand({
      isWorkspaceVisible: true,
      onReturnToWorkspace,
      run,
    });

    expect(onReturnToWorkspace).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
