// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";

describe("useConversationWorkspaceActions", () => {
  it("任务区的新建复用唯一创建入口，不按当前 workspace 复用 cwd", async () => {
    const createTask = vi.fn(async () => {});
    const prepareSession = vi.fn(async () => ({
      workspacePath: "/managed/new",
      projectId: null,
      additionalDirectories: [],
    }));
    const addTab = vi.fn();
    const { result } = renderHook(() =>
      useConversationWorkspaceActions({
        services: { projectService: { prepareSession } } as never,
        addTab,
        createTask,
        setWorkspaceActionError: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.handleCreateConversationTask();
    });
    expect(createTask).toHaveBeenCalledWith("task section new task");
    expect(prepareSession).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.handleEnsureConversationWorkspace();
    });
    expect(addTab).toHaveBeenCalledWith("/managed/new", { workspacePurpose: "conversation" });
  });
});
