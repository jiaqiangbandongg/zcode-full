import { describe, expect, it, vi } from "vitest";
import { createHostRemoteWorkspaceProxyState } from "../src/host/hostRemoteWorkspaceProxyState.js";

describe("createHostRemoteWorkspaceProxyState", () => {
  it("disposes workspace-owned proxy state and allows the workspace to subscribe again", () => {
    const state = createHostRemoteWorkspaceProxyState();
    const workspaceA = {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:a",
    };
    const workspaceB = {
      workspacePath: "/work/b",
      workspaceIdentity: "remote:wsl:b",
    };
    const workspaceADispose = vi.fn();
    const workspaceBDispose = vi.fn();
    const readyADispose = vi.fn();

    state.rememberTaskMeta({ taskId: "task-a", traceId: "trace-a", ...workspaceA });
    state.rememberTaskMeta({ taskId: "task-b", traceId: "trace-b", ...workspaceB });
    expect(
      state.ensureWorkspaceSubscription(workspaceA, () => ({ dispose: workspaceADispose })),
    ).toBe(true);
    expect(
      state.ensureWorkspaceSubscription(workspaceA, () => ({ dispose: vi.fn() })),
    ).toBe(false);
    state.ensureWorkspaceSubscription(workspaceB, () => ({ dispose: workspaceBDispose }));
    state.trackTaskReady(
      "task-a",
      workspaceA,
      () => ({ dispose: readyADispose }),
      vi.fn(),
    );

    state.clearWorkspace(workspaceA);

    expect(state.getTaskMeta("task-a")).toBeUndefined();
    expect(state.getTaskMeta("task-b")?.taskId).toBe("task-b");
    expect(workspaceADispose).toHaveBeenCalledOnce();
    expect(readyADispose).toHaveBeenCalledOnce();
    expect(workspaceBDispose).not.toHaveBeenCalled();
    expect(
      state.ensureWorkspaceSubscription(workspaceA, () => ({ dispose: vi.fn() })),
    ).toBe(true);
  });

  it("disposes a ready subscription when ready fires synchronously during registration", () => {
    const state = createHostRemoteWorkspaceProxyState();
    const context = {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:a",
    };
    const dispose = vi.fn();
    const onReady = vi.fn();

    state.trackTaskReady(
      "task-a",
      context,
      (listener) => {
        listener();
        return { dispose };
      },
      onReady,
    );

    expect(onReady).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    state.clearWorkspace(context);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
