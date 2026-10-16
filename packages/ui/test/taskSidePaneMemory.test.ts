import { describe, expect, it, beforeEach } from "vitest";
import {
  TASK_SIDE_PANE_MEMORY_MAX_ENTRIES,
  buildTaskSidePaneMemoryKey,
  clearTaskSidePaneMemoryStateForTest,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "../src/lib/taskSidePaneMemory.js";

describe("taskSidePaneMemory", () => {
  beforeEach(() => {
    clearTaskSidePaneMemoryStateForTest();
  });

  it("builds task key from workspace identity before workspace path", () => {
    expect(
      buildTaskSidePaneMemoryKey({
        workspacePath: "/same/path",
        workspaceIdentity: "ssh://host-a/same/path",
        taskId: "task-a",
      }),
    ).toBe("ssh://host-a/same/path");
  });

  it("keeps the same key when switching tasks in the same workspace", () => {
    expect(
      buildTaskSidePaneMemoryKey({
        workspacePath: "/workspace",
        taskId: null,
      }),
    ).toBe("/workspace");
    expect(
      buildTaskSidePaneMemoryKey({
        workspacePath: "/workspace",
        taskId: "task-a",
      }),
    ).toBe("/workspace");
    expect(
      buildTaskSidePaneMemoryKey({
        workspacePath: "/workspace",
        taskId: "task-b",
      }),
    ).toBe("/workspace");
  });

  it("keeps a new side pane collapsed until the user toggles it", () => {
    expect(readTaskSidePaneMemoryState("/new-workspace")).toMatchObject({
      sidePaneState: null,
      isSidePaneCollapsed: true,
    });
  });

  it("merges saved side pane patches", () => {
    const key = buildTaskSidePaneMemoryKey({
      workspacePath: "/workspace",
      taskId: "task-a",
    });

    saveTaskSidePaneMemoryState(key, {
      sidePaneState: {
        activeTabId: "git",
        tabs: [{ id: "git", type: "git" }],
      },
      isSidePaneCollapsed: false,
      browserUrls: {},
      browserUrl: null,
    });
    saveTaskSidePaneMemoryState(key, {
      activeGitSourceId: "last-turn",
      browserUrls: {
        "browser:a": "https://example.com/a",
        "browser:b": "https://example.com/b",
      },
    });

    expect(readTaskSidePaneMemoryState(key)).toEqual({
      sidePaneState: {
        activeTabId: "git",
        tabs: [{ id: "git", type: "git" }],
      },
      isSidePaneCollapsed: false,
      sidePaneCollapsedByOwner: {},
      activeGitSourceId: "last-turn",
      browserUrls: {
        "browser:a": "https://example.com/a",
        "browser:b": "https://example.com/b",
      },
      browserUrl: null,
      pluginUiAutoOpenKeys: new Set(),
    });
  });

  it("keeps side pane collapsed preference per conversation in one workspace", () => {
    const key = buildTaskSidePaneMemoryKey({
      workspacePath: "/workspace",
      taskId: "task-a",
    });

    saveTaskSidePaneCollapsedPreference(key, "task-a", true);
    saveTaskSidePaneCollapsedPreference(key, "task-b", false);

    const state = readTaskSidePaneMemoryState(key);
    expect(getSidePaneCollapsedPreference(state, "task-a")).toBe(true);
    expect(getSidePaneCollapsedPreference(state, "task-b")).toBe(false);
    expect(getSidePaneCollapsedPreference(state, "task-c")).toBeUndefined();
  });

  it("does not restore hidden treemapping side pane tabs", () => {
    const key = buildTaskSidePaneMemoryKey({
      workspacePath: "/workspace",
      taskId: "task-a",
    });

    saveTaskSidePaneMemoryState(key, {
      sidePaneState: {
        activeTabId: "treemapping",
        tabs: [
          { id: "treemapping", type: "treemapping" },
          { id: "browser:a", type: "browser", initialUrl: null },
        ],
      },
    });

    expect(readTaskSidePaneMemoryState(key).sidePaneState).toEqual({
      activeTabId: "browser:a",
      tabs: [{ id: "browser:a", type: "browser", initialUrl: null }],
    });
  });

  it("restores workflow artifact tabs across a task switch", () => {
    // 产物 tab（docs/dynamic-workflow/authoring.md「How the user sees them」）走的是这份 workspace 级内存，
    // 而 normalizeWorkspaceSidePaneState 是一条**白名单式过滤**（treemapping 被剔掉）。
    // 新 tab 类型漏进那条过滤的表现是「切一次任务产物面板就没了」，且不会报任何错。
    //
    // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 交付给用户的产出，不是脚本的顶层返回值。
    const key = buildTaskSidePaneMemoryKey({ workspacePath: "/workspace", taskId: "task-a" });
    const artifactTab = {
      id: "workflow-artifact:%2Fworkspace:parent-a:dwfrun-1:book",
      type: "workflow-artifact" as const,
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
    };

    saveTaskSidePaneMemoryState(key, {
      sidePaneState: { activeTabId: artifactTab.id, tabs: [artifactTab] },
    });

    expect(readTaskSidePaneMemoryState(key).sidePaneState).toEqual({
      activeTabId: artifactTab.id,
      tabs: [artifactTab],
    });
  });

  it("evicts the least recently used workspace states at the cache limit", () => {
    for (let index = 0; index < TASK_SIDE_PANE_MEMORY_MAX_ENTRIES; index += 1) {
      saveTaskSidePaneMemoryState(`/workspace-${index}`, {
        activeGitSourceId: "last-turn",
      });
    }

    expect(readTaskSidePaneMemoryState("/workspace-0").activeGitSourceId).toBe("last-turn");

    saveTaskSidePaneMemoryState("/workspace-new", {
      activeGitSourceId: "staged",
    });

    expect(readTaskSidePaneMemoryState("/workspace-0").activeGitSourceId).toBe("last-turn");
    expect(readTaskSidePaneMemoryState("/workspace-1").activeGitSourceId).toBe("unstaged");
    expect(readTaskSidePaneMemoryState("/workspace-new").activeGitSourceId).toBe("staged");
  });
});
