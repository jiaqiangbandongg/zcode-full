import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorkspaceTabState } from "../src/store/tabStore.js";
import {
  resolveTaskFileTreeTarget,
  resolveTaskFileTreeTargetFromTabs,
} from "../src/lib/taskFileTreeTarget.js";

function task(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    workspacePath: "/work/repo",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ZCodeTaskMeta;
}

function tab(overrides: Partial<WorkspaceTabState> = {}): WorkspaceTabState {
  return {
    id: "tab-1",
    workspacePath: "/work/repo",
    label: "Repository",
    ...overrides,
  } as WorkspaceTabState;
}

describe("resolveTaskFileTreeTarget", () => {
  it("opens a local task workspace using the task path", () => {
    expect(resolveTaskFileTreeTarget(task(), tab())).toEqual({
      workspacePath: "/work/repo",
      workspaceName: "Repository",
    });
  });

  it("keeps remote identity and session together", () => {
    expect(
      resolveTaskFileTreeTarget(
        task({ workspaceIdentity: "ssh://host/work/repo" }),
        tab({
          workspaceIdentity: "ssh://host/work/repo",
          remoteSessionId: "remote-1",
        }),
      ),
    ).toEqual({
      workspacePath: "/work/repo",
      workspaceName: "Repository",
      workspaceIdentity: "ssh://host/work/repo",
      workspaceRemoteSessionId: "remote-1",
    });
  });

  it("blocks a remote task until its remote session is ready", () => {
    expect(
      resolveTaskFileTreeTarget(
        task({ workspaceIdentity: "ssh://host/work/repo" }),
        tab({ workspaceIdentity: "ssh://host/work/repo" }),
      ),
    ).toBeNull();
  });

  it("rejects a same-path remote tab with a different workspace identity", () => {
    expect(
      resolveTaskFileTreeTarget(
        task({ workspaceIdentity: "ssh://host-a/work/repo" }),
        tab({
          workspaceIdentity: "ssh://host-b/work/repo",
          remoteSessionId: "remote-b",
        }),
      ),
    ).toBeNull();
  });

  it("rejects a same-path remote tab for a local task without identity", () => {
    expect(
      resolveTaskFileTreeTarget(
        task(),
        tab({
          remoteTarget: {
            kind: "ssh",
            host: "example.com",
            username: "developer",
          },
          remoteSessionId: "remote-1",
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [tab(), tab({ remoteTarget: { kind: "ssh", host: "example.com" } })],
    [tab({ remoteTarget: { kind: "ssh", host: "example.com" } }), tab()],
  ])("selects the local tab from same-path candidates regardless of order", (...tabs) => {
    expect(resolveTaskFileTreeTargetFromTabs(task(), tabs)).toEqual({
      workspacePath: "/work/repo",
      workspaceName: "Repository",
    });
  });

  it.each([
    [[]],
    [[tab({ workspacePath: "/other/repo", label: "Other repository" })]],
  ])("falls back to the task path when no local tab matches", (tabs) => {
    expect(resolveTaskFileTreeTargetFromTabs(task(), tabs)).toEqual({
      workspacePath: "/work/repo",
      workspaceName: "repo",
    });
  });
});
