// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  collectClosedRemoteWorkspaceKeys,
  collectClosedRemoteWorkspaceSessionIds,
  useRemoteWorkspaceTabLifecycle,
} from "@/root/useRemoteWorkspaceTabLifecycle.js";

function createWorkspaceTab(
  id: string,
  workspacePath: string,
  options?: Partial<WorkspaceTabState>,
): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    workspacePath,
    label: workspacePath,
    ...options,
  };
}

describe("collectClosedRemoteWorkspaceKeys", () => {
  it("includes disconnected remote workspace identity when the workspace is no longer open", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-1", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ];
    const nextTabs: WorkspaceTabState[] = [];

    expect(collectClosedRemoteWorkspaceKeys(previousTabs, nextTabs)).toEqual([
      "remote:docker:demo:/workspace/demo",
    ]);
  });

  it("does not include workspace identity when the same tab still exists", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-1", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ];
    const nextTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-1", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ];

    expect(collectClosedRemoteWorkspaceKeys(previousTabs, nextTabs)).toEqual([]);
  });

  it("does not include workspace identity when the same remote survives under a new tab id", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-old", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ];
    const nextTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-new", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ];

    expect(collectClosedRemoteWorkspaceKeys(previousTabs, nextTabs)).toEqual([]);
  });

  it("falls back to workspacePath for legacy remote tabs without identity", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-legacy", "/workspace/demo", {
        remoteTarget: { kind: "docker", container: "demo" },
      }),
    ];

    expect(collectClosedRemoteWorkspaceKeys(previousTabs, [])).toEqual(["/workspace/demo"]);
  });
});

describe("collectClosedRemoteWorkspaceSessionIds", () => {
  it("returns the remembered session for a tab that was disconnected before removal", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-1", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ];

    expect(
      collectClosedRemoteWorkspaceSessionIds(
        previousTabs,
        [],
        new Map([["remote:docker:demo:/workspace/demo", "session-closed"]]),
      ),
    ).toEqual(["session-closed"]);
  });

  it("returns the remembered session by workspacePath for a legacy remote tab", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-legacy", "/workspace/demo", {
        remoteTarget: { kind: "docker", container: "demo" },
      }),
    ];

    expect(
      collectClosedRemoteWorkspaceSessionIds(
        previousTabs,
        [],
        new Map([["/workspace/demo", "session-legacy"]]),
      ),
    ).toEqual(["session-legacy"]);
  });

  it("does not duplicate a session that is still present on the removed tab", () => {
    const previousTabs: WorkspaceTabState[] = [
      createWorkspaceTab("remote-1", "/workspace/demo", {
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
        remoteSessionId: "session-live",
      }),
    ];

    expect(
      collectClosedRemoteWorkspaceSessionIds(
        previousTabs,
        [],
        new Map([["remote:docker:demo:/workspace/demo", "session-live"]]),
      ),
    ).toEqual([]);
  });
});

describe("useRemoteWorkspaceTabLifecycle", () => {
  it("释放先断连后关闭的 remote session", async () => {
    const disposeRemoteSession = vi.fn(async () => undefined);
    const onRemoteWorkspaceTabsClosed = vi.fn();
    const connectedTab = createWorkspaceTab("remote-1", "/workspace/demo", {
      workspaceIdentity: "remote:docker:demo:/workspace/demo",
      remoteSessionId: "session-closed",
    });
    const disconnectedTab = { ...connectedTab, remoteSessionId: undefined };
    const platform = { disposeRemoteSession } as never;

    const { rerender } = renderHook(
      ({ tabs }: { tabs: WorkspaceTabState[] }) =>
        useRemoteWorkspaceTabLifecycle({
          tabs,
          activeWorkspaceTab: null,
          platform,
          onRemoteWorkspaceTabsClosed,
        }),
      { initialProps: { tabs: [connectedTab] } },
    );

    rerender({ tabs: [disconnectedTab] });
    rerender({ tabs: [] });

    await waitFor(() => {
      expect(disposeRemoteSession).toHaveBeenCalledWith("session-closed");
    });
    expect(onRemoteWorkspaceTabsClosed).toHaveBeenCalledWith([
      "remote:docker:demo:/workspace/demo",
    ]);
  });
});
