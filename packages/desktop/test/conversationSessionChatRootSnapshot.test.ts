import { afterEach, describe, expect, it, vi } from "vitest";

import { readV4ChatRootSnapshotInBrowser } from "./e2e/helpers/conversation-session-chat-root-snapshot-script.js";
import { readTaskStoreSnapshotInBrowser } from "./e2e/helpers/conversation-session-store-snapshot-script.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installV4SnapshotBrowser(options: {
  activeWorkspaceIdentity?: string | null;
  activeWorkspacePath: string;
  paneSessionId?: string;
  stopVisible?: boolean;
  workspaces: Record<
    string,
    {
      draftRuntime?: { status?: string | null };
      modelSwitchPending?: boolean;
      taskRuntimeByTaskId?: Record<
        string,
        { activeInputId?: string | null; status?: string | null }
      >;
    }
  >;
}) {
  const paneSessionId = options.paneSessionId ?? "draft";
  // Bug 根因：snapshot helper 增加 pane 内 Stop 查询后，旧测试桩仍只实现
  // getAttribute，导致用例在读取 workspace 前崩溃。这里补齐被测代码依赖的
  // HTMLElement 最小契约，并用 stopVisible 显式模拟 control projection。
  const pane = {
    getAttribute: (name: string) => (name === "data-session-id" ? paneSessionId : null),
    querySelector: (selector: string) =>
      options.stopVisible && selector === '[data-testid="v4-stop"]' ? {} : null,
  };
  vi.stubGlobal("document", {
    querySelector: () => pane,
    querySelectorAll: () => ({ length: 0 }),
  });
  vi.stubGlobal("window", {
    __zcodeSessionStoreE2E: {
      getState: () => ({ workspaces: options.workspaces }),
    },
    __zcodeTabStoreE2E: {
      getState: () => ({
        activeWorkspaceIdentity: options.activeWorkspaceIdentity ?? null,
        activeWorkspacePath: options.activeWorkspacePath,
      }),
    },
  });
}

function installTaskStoreBrowser(workspace: Record<string, unknown>) {
  vi.stubGlobal("window", {
    localStorage: {},
    __zcodeSessionStoreE2E: {
      getState: () => ({ workspaces: { workspace } }),
    },
  });
}

describe("V4 ChatRootSnapshot workspace isolation", () => {
  it("reads draft runtime and model switch from the active local workspace", () => {
    installV4SnapshotBrowser({
      activeWorkspacePath: "C:/repo-b",
      workspaces: {
        "C:/repo-a": {
          draftRuntime: { status: "streaming" },
          modelSwitchPending: true,
        },
        "C:/repo-b": {
          draftRuntime: { status: "idle" },
          modelSwitchPending: false,
        },
      },
    });

    expect(readV4ChatRootSnapshotInBrowser("pane", "queue", "v4-stop")).toMatchObject({
      bridgeError: null,
      canStop: false,
      modelSwitchPending: false,
      runtimeStatus: "idle",
      workspaceKey: "C:/repo-b",
    });
  });

  it("prefers workspaceIdentity when two draft workspaces share one path", () => {
    const workspacePath = "/home/dev/project";
    const workspaceIdentityA = "ssh://host-a/home/dev/project";
    const workspaceIdentityB = "ssh://host-b/home/dev/project";
    installV4SnapshotBrowser({
      activeWorkspaceIdentity: `  ${workspaceIdentityB}  `,
      activeWorkspacePath: workspacePath,
      workspaces: {
        [workspaceIdentityA]: {
          draftRuntime: { status: "idle" },
          modelSwitchPending: false,
        },
        [workspaceIdentityB]: {
          draftRuntime: { status: "streaming" },
          modelSwitchPending: true,
        },
      },
    });

    expect(readV4ChatRootSnapshotInBrowser("pane", "queue", "v4-stop")).toMatchObject({
      bridgeError: null,
      canStop: false,
      modelSwitchPending: true,
      runtimeStatus: "streaming",
      workspaceKey: workspaceIdentityB,
    });
  });

  it("uses the pane Stop control while the task runtime store is stale", () => {
    installV4SnapshotBrowser({
      activeWorkspacePath: "/repo",
      paneSessionId: "task-running",
      stopVisible: true,
      workspaces: {
        "/repo": {
          taskRuntimeByTaskId: {
            "task-running": {
              activeInputId: "input-running",
              status: "completed",
            },
          },
        },
      },
    });

    expect(readV4ChatRootSnapshotInBrowser("pane", "queue", "v4-stop")).toMatchObject({
      activeInputId: "input-running",
      canStop: true,
      runtimeStatus: "streaming",
      taskId: "task-running",
    });
  });
});

describe("V4 ChatRootSnapshot task Goal and stop semantics", () => {
  it("reads an active Goal from optimistic task metadata", () => {
    installTaskStoreBrowser({
      activeTaskId: "task-active",
      optimisticTaskListByTaskId: {
        "task-active": {
          taskId: "task-active",
          target: {
            objective: "修复 active goal",
            status: "active",
            targetID: "goal-active",
          },
        },
      },
    });

    expect(readTaskStoreSnapshotInBrowser("task-active", "workspace").snapshot.taskMeta).toMatchObject(
      {
        targetId: "goal-active",
        targetObjective: "修复 active goal",
        targetStatus: "active",
      },
    );
  });

  it("reads a completed Goal from task-list cache fallback", () => {
    installTaskStoreBrowser({
      activeTaskId: "task-completed",
      taskListCache: [
        {
          taskId: "task-completed",
          target: {
            objective: "修复 completed goal",
            status: "complete",
            targetID: "goal-completed",
          },
        },
      ],
    });

    expect(
      readTaskStoreSnapshotInBrowser("task-completed", "workspace").snapshot.taskMeta,
    ).toMatchObject({
      targetId: "goal-completed",
      targetObjective: "修复 completed goal",
      targetStatus: "complete",
    });
  });

  it("reads stopRequested from the selected workspace task bucket", () => {
    installTaskStoreBrowser({
      activeTaskId: "task-stopping",
      taskStopRequestedByTaskId: { "task-stopping": true },
    });

    expect(
      readTaskStoreSnapshotInBrowser("task-stopping", "workspace").snapshot.stopRequested,
    ).toBe(true);
  });
});
