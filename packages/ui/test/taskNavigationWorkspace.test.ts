import { describe, expect, it, vi } from "vitest";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

describe("ensureTaskNavigationWorkspace", () => {
  it("复用已打开的精确 workspace tab", () => {
    const activateTabByPath = vi.fn(() => true);
    const addLocalWorkspaceTab = vi.fn();

    expect(
      ensureTaskNavigationWorkspace({
        workspacePath: "/workspace/project",
        activateTabByPath,
        addLocalWorkspaceTab,
      }),
    ).toEqual({ accepted: true, openedLocalTab: false });
    expect(addLocalWorkspaceTab).not.toHaveBeenCalled();
  });

  it("运行历史属于已关闭的本地项目时补开 workspace tab", () => {
    const activateTabByPath = vi.fn(() => false);
    const addLocalWorkspaceTab = vi.fn();

    expect(
      ensureTaskNavigationWorkspace({
        workspacePath: "/workspace/closed-project",
        activateTabByPath,
        addLocalWorkspaceTab,
      }),
    ).toEqual({ accepted: true, openedLocalTab: true });
    expect(addLocalWorkspaceTab).toHaveBeenCalledWith("/workspace/closed-project");
  });

  it("缺少当前窗口 attachment 的远程 workspace 不按 path 补开", () => {
    const activateTabByPath = vi.fn(() => false);
    const addLocalWorkspaceTab = vi.fn();

    expect(
      ensureTaskNavigationWorkspace({
        workspacePath: "/home/project",
        workspaceIdentity: "ssh://host/home/project",
        activateTabByPath,
        addLocalWorkspaceTab,
      }),
    ).toEqual({ accepted: false, reason: "remote_attachment_missing" });
    expect(activateTabByPath).toHaveBeenCalledWith("/home/project", {
      workspaceIdentity: "ssh://host/home/project",
    });
    expect(addLocalWorkspaceTab).not.toHaveBeenCalled();
  });
});
