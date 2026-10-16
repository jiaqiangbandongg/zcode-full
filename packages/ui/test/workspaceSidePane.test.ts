import { describe, expect, it } from "vitest";
import {
  activateBrowserSidePane,
  activateDeveloperToolsSidePane,
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  BROWSER_USE_OPERATION_INDICATOR_DURATION_MS,
  closeAllSidePaneTabs,
  closeCodeViewerSidePane,
  closeOtherSidePaneTabs,
  closeSidePaneTab,
  getActiveSelectionSideChatTab,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleForParent,
  isWorkspaceGlobalSidePaneTab,
  markBrowserUseSidePaneTabOperation,
  normalizeWorkspaceSidePaneState,
  openSelectionSideChatPane,
  openPlanDetailSidePane,
  openSubagentDirectorySidePane,
  openSubagentSessionSidePane,
  openWorkflowRunSidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowArtifactSidePane,
  openWorkflowWorkspaceSidePane,
  openBrowserSidePane,
  openBrowserPermissionsSidePane,
  openBrowserUseSidePane,
  openOrActivateBrowserSidePaneByUrl,
  findBrowserSidePaneTabByUrl,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  openTerminalSidePane,
  reorderSidePaneTab,
  resolveActiveTabForOwner,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  selectSidePaneTabsForParent,
  syncSubagentSessionSidePaneTabs,
  shouldMountSidePaneContent,
  applyBrowserTabResidencyEvent,
  restoreBrowserTabShells,
  stampSidePaneTabsOwnership,
  toggleBrowserSidePane,
  toggleGitSidePane,
  updateBrowserSidePaneTab,
  type WorkspaceSidePaneTab,
} from "../src/lib/workspaceSidePane.js";

describe("workspaceSidePane", () => {
  const viewerSource = {
    type: "file" as const,
    title: "demo.ts",
    path: "/workspace/demo.ts",
  };

  function withoutOpenedAt<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => withoutOpenedAt(item)) as T;
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "openedAt")
          .map(([key, item]) => [key, withoutOpenedAt(item)]),
      ) as T;
    }

    return value;
  }

  it("折叠或切换对话时仍为 Browser/browser-use 后台挂载内容", () => {
    expect(shouldMountSidePaneContent(false, [])).toBe(false);
    expect(shouldMountSidePaneContent(false, [{ id: "browser:human", type: "browser" }])).toBe(
      true,
    );
    expect(
      shouldMountSidePaneContent(false, [
        {
          id: "browser-use:tab-1",
          type: "browser-use",
          sessionId: "sess-1",
          tabId: "tab-1",
        },
      ]),
    ).toBe(true);
    expect(shouldMountSidePaneContent(true, [])).toBe(true);
  });

  it("BTL06: suspend 只卸载 guest，保留 logical tab shell；restore 保持 stable tabId", () => {
    const opened = stampSidePaneTabsOwnership(
      openBrowserSidePane(null, { tabId: "browser:stable" }),
      {
        ownerTaskId: "session-a",
        workspaceKey: "workspace-a",
      },
    );
    const suspended = applyBrowserTabResidencyEvent(opened, {
      tabId: "browser:stable",
      generation: 3,
      residency: "suspended",
    });

    expect(suspended).toMatchObject({
      activeTabId: "browser:stable",
      tabs: [
        {
          id: "browser:stable",
          residency: "suspended",
          residencyGeneration: 3,
        },
      ],
    });
    expect(
      applyBrowserTabResidencyEvent(suspended, {
        tabId: "browser:stable",
        generation: 4,
        residency: "restoring",
      }),
    ).toMatchObject({
      tabs: [
        {
          id: "browser:stable",
          residency: "restoring",
          residencyGeneration: 4,
        },
      ],
    });
  });

  it("拒绝迟到 generation，跨重启 shell 默认以 suspended 恢复且不覆盖其它 scope", () => {
    const current = applyBrowserTabResidencyEvent(
      stampSidePaneTabsOwnership(openBrowserSidePane(null, { tabId: "browser:stable" }), {
        ownerTaskId: "session-a",
        workspaceKey: "workspace-a",
      }),
      {
        tabId: "browser:stable",
        generation: 7,
        residency: "restoring",
      },
    );
    expect(
      applyBrowserTabResidencyEvent(current, {
        tabId: "browser:stable",
        generation: 6,
        residency: "suspended",
      }),
    ).toBe(current);

    const restored = restoreBrowserTabShells(current, [
      {
        tabId: "browser:restored",
        workspaceKey: "workspace-a",
        sessionId: "session-a",
        browserId: "browser-restored-real",
        browserGeneration: 9,
        origin: "user",
        restoreUrl: "https://example.com/restored",
        title: "Restored",
        faviconUrl: null,
        openedAt: 2,
        lastSelectedAt: null,
      },
    ]);
    expect(restored.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "browser:restored",
          ownerTaskId: "session-a",
          residency: "suspended",
          initialUrl: "https://example.com/restored",
        }),
      ]),
    );
  });

  it("BTL17/18: restore terminal live 收敛状态，并保留冷恢复的真实 browser identity", () => {
    const restored = restoreBrowserTabShells(null, [
      {
        tabId: "browser:agent-restored",
        workspaceKey: "workspace-a",
        sessionId: "session-a",
        browserId: "browser-real",
        browserGeneration: 7,
        origin: "agent",
        restoreUrl: "https://example.com/restored",
        title: "Restored",
        faviconUrl: null,
        openedAt: 2,
        lastSelectedAt: 10,
      },
    ]);
    const restoring = applyBrowserTabResidencyEvent(restored, {
      tabId: "browser:agent-restored",
      workspaceKey: "workspace-a",
      sessionId: "session-a",
      browserId: "browser-real",
      browserGeneration: 7,
      generation: 3,
      residency: "restoring",
    });
    const live = applyBrowserTabResidencyEvent(restoring, {
      tabId: "browser:agent-restored",
      workspaceKey: "workspace-a",
      sessionId: "session-a",
      browserId: "browser-real",
      browserGeneration: 7,
      generation: 3,
      residency: "live-background",
    });

    expect(live?.tabs[0]).toMatchObject({
      browserId: "browser-real",
      browserGeneration: 7,
      residency: "live-background",
      residencyGeneration: 3,
    });
  });

  it("BTL22: 冷恢复保持 openedAt 顺序，但激活当前 scope 最后选中的 tab", () => {
    const restored = restoreBrowserTabShells(
      null,
      [
        {
          tabId: "browser:first",
          workspaceKey: "workspace-a",
          sessionId: "session-a",
          browserId: "unclaimed-iab",
          browserGeneration: 0,
          origin: "user",
          restoreUrl: "https://example.com/first",
          title: "First",
          faviconUrl: null,
          openedAt: 1,
          lastSelectedAt: 100,
        },
        {
          tabId: "browser:last-selected",
          workspaceKey: "workspace-a",
          sessionId: "session-a",
          browserId: "unclaimed-iab",
          browserGeneration: 0,
          origin: "user",
          restoreUrl: "https://example.com/last",
          title: "Last",
          faviconUrl: null,
          openedAt: 2,
          lastSelectedAt: 500,
        },
      ],
      {
        workspaceKey: "workspace-a",
        sessionId: "session-a",
      },
    );

    expect(restored.tabs.map((tab) => tab.id)).toEqual(["browser:first", "browser:last-selected"]);
    expect(restored.activeTabId).toBe("browser:last-selected");
  });

  it("BTL22: 草稿态 unscoped 持久值恢复为 null owner，保持当前草稿可见", () => {
    const restored = restoreBrowserTabShells(
      null,
      [
        {
          tabId: "browser:draft",
          workspaceKey: "workspace-a",
          sessionId: "unscoped",
          browserId: "unclaimed-iab",
          browserGeneration: 0,
          origin: "user",
          restoreUrl: "https://example.com/draft",
          title: "Draft",
          faviconUrl: null,
          openedAt: 1,
          lastSelectedAt: 100,
        },
      ],
      {
        workspaceKey: "workspace-a",
        sessionId: "unscoped",
      },
    );

    expect(restored.tabs[0]).toMatchObject({ ownerTaskId: null });
    expect(
      getVisibleSidePaneTabs(restored.tabs, {
        workspaceKey: "workspace-a",
        ownerTaskId: null,
      }),
    ).toHaveLength(1);
  });

  it("opens browser pane from closed state", () => {
    const next = toggleBrowserSidePane(null);

    expect(next).not.toBeNull();
    if (!next) {
      throw new Error("Expected browser side pane state");
    }
    expect(next.activeTabId).toMatch(/^browser:/);
    expect(withoutOpenedAt(next.tabs)).toEqual([
      {
        id: next.activeTabId,
        type: "browser",
        faviconUrl: null,
        initialUrl: null,
        title: null,
      },
    ]);
  });

  it("filters hidden treemapping tabs and keeps a visible active tab", () => {
    expect(
      withoutOpenedAt(
        normalizeWorkspaceSidePaneState({
          activeTabId: "treemapping",
          tabs: [
            { id: "git", type: "git" },
            { id: "treemapping", type: "treemapping" },
          ],
        }),
      ),
    ).toEqual({
      activeTabId: "git",
      tabs: [{ id: "git", type: "git" }],
    });
  });

  it("backfills missing selection side chat ordinals without disturbing existing ones", () => {
    // 多开引入 ordinal 之前的旧内存/HMR 状态没有该字段；normalize 边界必须按 parent
    // 分组回填最小可用编号，且不改动已有编号（review SG-01）。
    // 刻意省略 ordinal 模拟旧结构，用 unknown 中转绕过新类型必填约束。
    const legacyTab = {
      id: "selection-side-chat:ws:parent-a:child-legacy",
      type: "selection-side-chat",
      workspaceKey: "ws",
      workspacePath: "/ws",
      parentSessionId: "parent-a",
      childSessionId: "child-legacy",
    } as unknown as WorkspaceSidePaneTab & { type: "selection-side-chat" };
    const modernTab = {
      ...legacyTab,
      id: "selection-side-chat:ws:parent-a:child-modern",
      childSessionId: "child-modern",
      ordinal: 1,
    };
    const otherParentLegacyTab = {
      ...legacyTab,
      id: "selection-side-chat:ws:parent-b:child-other",
      parentSessionId: "parent-b",
      childSessionId: "child-other",
    };

    const normalized = normalizeWorkspaceSidePaneState({
      activeTabId: modernTab.id,
      tabs: [legacyTab, modernTab, otherParentLegacyTab],
    });

    const ordinals = new Map(
      (normalized?.tabs ?? []).flatMap((tab) =>
        tab.type === "selection-side-chat" ? [[tab.childSessionId, tab.ordinal]] : [],
      ),
    );
    expect(ordinals.get("child-modern")).toBe(1);
    expect(ordinals.get("child-legacy")).toBe(2);
    expect(ordinals.get("child-other")).toBe(1);
    expect(normalized?.activeTabId).toBe(modernTab.id);
  });

  it("preserves an intentionally empty active tab while only hidden parent tabs remain", () => {
    const state = openSubagentSessionSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      rootSessionId: "parent-a",
      parentSessionId: "parent-a",
      childSessionId: "child-a",
      subagentType: "Explore",
      title: "Explore project structure",
    });
    expect(normalizeWorkspaceSidePaneState({ ...state, activeTabId: "" })?.activeTabId).toBe("");
  });

  it("groups child detail tabs by root session and reuses a child across nesting levels", () => {
    const first = openSubagentSessionSidePane(null, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
      childSessionId: "child-a",
      subagentType: "Explore",
      title: "Inspect files",
    });
    const second = openSubagentSessionSidePane(first, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      rootSessionId: "root-a",
      parentSessionId: "nested-parent",
      childSessionId: "child-a",
      subagentType: "Explore",
      title: "Inspect files again",
    });

    expect(second.tabs).toHaveLength(1);
    expect(second.tabs[0]).toMatchObject({
      id: "subagent-session:ssh%3A%2F%2Fhost%2Fworkspace:root-a:child-a",
      rootSessionId: "root-a",
      parentSessionId: "nested-parent",
      childSessionId: "child-a",
      title: "Inspect files again",
    });
  });

  it("opens one reusable subagent directory per workspace and root parent", () => {
    const first = openSubagentDirectorySidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
    });
    const second = openSubagentDirectorySidePane(first, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
    });

    expect(second.tabs).toHaveLength(1);
    expect(second).toMatchObject({
      activeTabId: "subagent-directory:%2Fworkspace:root-a:parent-a",
      tabs: [
        {
          type: "subagent-directory",
          rootSessionId: "root-a",
          parentSessionId: "parent-a",
        },
      ],
    });
  });

  it("drops invalid child tabs without closing the directory and falls back to it", () => {
    const directory = openSubagentDirectorySidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
    });
    const withValid = openSubagentSessionSidePane(directory, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
      childSessionId: "child-valid",
      subagentType: "Explore",
      title: "Valid",
    });
    const withInvalid = openSubagentSessionSidePane(withValid, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
      childSessionId: "child-old-branch",
      subagentType: "Explore",
      title: "Old branch",
    });

    const next = syncSubagentSessionSidePaneTabs(withInvalid, {
      rootSessionId: "root-a",
      parentSessionId: "parent-a",
      validChildSessionIds: ["child-valid"],
    });

    expect(next?.tabs.map((tab) => tab.id)).toEqual([
      "subagent-directory:%2Fworkspace:root-a:parent-a",
      "subagent-session:%2Fworkspace:root-a:child-valid",
    ]);
    expect(next?.activeTabId).toBe("subagent-directory:%2Fworkspace:root-a:parent-a");
  });

  it("按 childSessionId 多开 selection side chat tab，并为同父实例分配序号", () => {
    const first = openSelectionSideChatPane(null, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-a",
    });
    const second = openSelectionSideChatPane(first, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-b",
    });
    const reopenedFirst = openSelectionSideChatPane(second, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-a",
    });

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs).toMatchObject([
      {
        id: "selection-side-chat:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:child-a",
        type: "selection-side-chat",
        parentSessionId: "parent-a",
        childSessionId: "child-a",
        ordinal: 1,
      },
      {
        id: "selection-side-chat:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:child-b",
        type: "selection-side-chat",
        parentSessionId: "parent-a",
        childSessionId: "child-b",
        ordinal: 2,
      },
    ]);
    expect(reopenedFirst.tabs).toHaveLength(2);
    expect(reopenedFirst.activeTabId).toBe(
      "selection-side-chat:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:child-a",
    );
    expect(reopenedFirst.tabs[0]).toMatchObject({
      childSessionId: "child-a",
      ordinal: 1,
    });
  });

  it("只把当前 active 且属于同 workspace + parent 的辅助 tab 解析为划词目标", () => {
    const first = openSelectionSideChatPane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-a",
    });
    const second = openSelectionSideChatPane(first, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-b",
    });
    expect(
      getActiveSelectionSideChatTab(second, {
        workspaceKey: "/workspace",
        parentSessionId: "parent-a",
      }),
    ).toMatchObject({ childSessionId: "child-b" });

    const browserActive = openBrowserSidePane(second, {
      tabId: "browser:active",
    });
    expect(
      getActiveSelectionSideChatTab(browserActive, {
        workspaceKey: "/workspace",
        parentSessionId: "parent-a",
      }),
    ).toBeNull();
    expect(
      getActiveSelectionSideChatTab(second, {
        workspaceKey: "/other",
        parentSessionId: "parent-a",
      }),
    ).toBeNull();
  });

  it("按 workspace identity + parent + toolCall 复用并隔离计划详情 tab", () => {
    const first = openPlanDetailSidePane(null, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-plan-a",
      markdown: "# 计划 A",
    });
    const refreshed = openPlanDetailSidePane(first, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-plan-a",
      markdown: "# 计划 A\n\n已更新",
    });
    const second = openPlanDetailSidePane(refreshed, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-plan-b",
      markdown: "# 计划 B",
    });

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs[0]).toMatchObject({
      type: "plan-detail",
      toolCallId: "tool-plan-a",
      markdown: "# 计划 A\n\n已更新",
    });
    expect(second.tabs[1]).toMatchObject({
      type: "plan-detail",
      toolCallId: "tool-plan-b",
    });
    expect(getVisibleSidePaneTabs(second, "parent-a")).toHaveLength(2);
    expect(getVisibleSidePaneTabs(second, "parent-b")).toHaveLength(0);
  });

  it("run 详情 tab 的落点（追记「五枚药丸与一扇门」）：随请求落、再开不带就删键、openedAt 刷新", () => {
    const base = {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-a",
    };
    const first = openWorkflowRunSidePane(null, {
      ...base,
      workflowName: "Fan-out review",
      phaseId: "phase#a",
    });
    expect(first.tabs).toHaveLength(1);
    expect(first.tabs[0]).toMatchObject({
      type: "workflow-run",
      focusPhaseId: "phase#a",
      workflowName: "Fan-out review",
    });
    const openedAt = (first.tabs[0] as { openedAt?: number }).openedAt!;
    // 从另一站再点：同一个 tab，落点换成那一站，openedAt 刷新（同一站再点也据此再落）。
    const relanded = openWorkflowRunSidePane(first, { ...base, phaseId: "phase#b" });
    expect(relanded.tabs).toHaveLength(1);
    expect(relanded.tabs[0]).toMatchObject({
      focusPhaseId: "phase#b",
      workflowName: "Fan-out review",
    });
    expect((relanded.tabs[0] as { openedAt?: number }).openedAt).toBeGreaterThanOrEqual(openedAt);
    // 不带站的请求（表头的 ⤢）：落点删掉，不是沿用上一次的。
    const unlanded = openWorkflowRunSidePane(relanded, base);
    expect(unlanded.tabs).toHaveLength(1);
    expect(unlanded.tabs[0]).not.toHaveProperty("focusPhaseId");
  });

  it("按 workspace identity + parent + run 复用并隔离 workflow run 详情 tab", () => {
    const first = openWorkflowRunSidePane(null, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-a",
      runId: "dwfrun-a",
      workflowName: "三路评审",
    });
    // 同一个 run 再次点击必须落回同一个 tab（结构化 id 幂等），而不是并排开第二份。
    const reclicked = openWorkflowRunSidePane(first, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-a",
      runId: "dwfrun-a",
      workflowName: "三路评审（改名）",
    });
    const secondRun = openWorkflowRunSidePane(reclicked, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-b",
      runId: "dwfrun-b",
    });

    expect(reclicked.tabs).toHaveLength(1);
    expect(reclicked.activeTabId).toBe(
      "workflow-run:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:dwfrun-a",
    );
    // 再次点击用卡片当前展示名刷新兜底标题；权威运行态仍来自父会话投影。
    expect(reclicked.tabs[0]).toMatchObject({
      type: "workflow-run",
      runId: "dwfrun-a",
      toolCallId: "tool-wf-a",
      workflowName: "三路评审（改名）",
      remoteSessionId: "remote-1",
    });

    expect(secondRun.tabs).toHaveLength(2);
    expect(secondRun.tabs[1]).toMatchObject({
      id: "workflow-run:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:dwfrun-b",
      type: "workflow-run",
      runId: "dwfrun-b",
    });
    // 可见性按 owning conversation 收窄，照 plan-detail。
    expect(getVisibleSidePaneTabs(secondRun, "parent-a")).toHaveLength(2);
    expect(getVisibleSidePaneTabs(secondRun, "parent-b")).toHaveLength(0);
  });

  it("同一个 runId 在不同 workspace / 不同 parent 下互不复用", () => {
    const inWorkspaceA = openWorkflowRunSidePane(null, {
      workspaceKey: "/workspace-a",
      workspacePath: "/workspace-a",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf",
      runId: "dwfrun-1",
    });
    const inWorkspaceB = openWorkflowRunSidePane(inWorkspaceA, {
      workspaceKey: "/workspace-b",
      workspacePath: "/workspace-b",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf",
      runId: "dwfrun-1",
    });
    const inOtherParent = openWorkflowRunSidePane(inWorkspaceB, {
      workspaceKey: "/workspace-a",
      workspacePath: "/workspace-a",
      parentSessionId: "parent-b",
      toolCallId: "tool-wf",
      runId: "dwfrun-1",
    });

    expect(inOtherParent.tabs).toHaveLength(3);
    expect(new Set(inOtherParent.tabs.map((tab) => tab.id)).size).toBe(3);
  });

  it("workflow run tab 不是 workspace 全局 tab，且 8-run 淘汰不回收它", () => {
    const state = openWorkflowRunSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf",
      runId: "dwfrun-1",
    });
    const tab = state.tabs[0]!;
    expect(isWorkspaceGlobalSidePaneTab(tab)).toBe(false);
    expect(isSidePaneTabVisibleForParent(tab, "parent-a")).toBe(true);
    expect(isSidePaneTabVisibleForParent(tab, "parent-b")).toBe(false);

    // GC 语义（照 plan-detail：无 GC）。事件日志读的是 journal，不是 workflowRuns 投影，
    // 所以被 8-run 上限淘汰的 run 仍有完整可读的事件日志——那恰恰是用户会留着这个 tab
    // 的场景。子会话那套 sync 回收只作用于 subagent-session，绝不能连带清掉它。
    expect(
      syncSubagentSessionSidePaneTabs(state, {
        rootSessionId: "parent-a",
        parentSessionId: "parent-a",
        validChildSessionIds: [],
      }),
    ).toBe(state);
  });

  it("切回对话时优先激活 workflow run tab（与 plan-detail 同档）", () => {
    const withBrowser = openBrowserSidePane(null, { tabId: "browser:1" });
    const withRun = openWorkflowRunSidePane(withBrowser, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf",
      runId: "dwfrun-1",
    });
    // 先把 active 挪到一个当前 parent 下不可见的位置，逼 select 走 findLast 分支。
    const selected = selectSidePaneTabsForParent(
      { ...withRun, activeTabId: "missing" },
      "parent-a",
    );
    expect(selected?.activeTabId).toBe("workflow-run:%2Fworkspace:parent-a:dwfrun-1");
  });

  // ── actor transcript tab（docs/dynamic-workflow/presentation.md「Subagent transcripts」）──
  it("按 workspace + parent + run + 槽位复用 actor transcript tab，重复点击幂等", () => {
    const first = openWorkflowActorSessionSidePane(null, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      runId: "dwfrun-a",
      actorSessionId: "dwf-dwfrun-a-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
      actorName: "reviewer",
    });
    const reclicked = openWorkflowActorSessionSidePane(first, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      runId: "dwfrun-a",
      actorSessionId: "dwf-dwfrun-a-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
      actorName: "reviewer",
    });
    // 同一车道的第二个实例是**另一个** tab：实例身份是 (runId, siteId, ordinal)，不是车道。
    const sibling = openWorkflowActorSessionSidePane(reclicked, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      runId: "dwfrun-a",
      actorSessionId: "dwf-dwfrun-a-actor_1@2",
      siteId: "actor#1",
      ordinal: 2,
      actorName: "reviewer",
    });

    expect(reclicked.tabs).toHaveLength(1);
    expect(reclicked.activeTabId).toBe(
      "workflow-actor-session:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:dwfrun-a:actor%231%401",
    );
    expect(reclicked.tabs[0]).toMatchObject({
      type: "workflow-actor-session",
      parentSessionId: "parent-a",
      runId: "dwfrun-a",
      actorSessionId: "dwf-dwfrun-a-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
      actorName: "reviewer",
      remoteSessionId: "remote-1",
    });
    expect(sibling.tabs).toHaveLength(2);
    expect(sibling.activeTabId).toContain("actor%231%402");
  });

  it("槽位 tab：先从未启动的药丸开（无会话 id），后从已启动的药丸再开是同一个 tab 并补上会话 id", () => {
    // docs/dynamic-workflow/presentation.md「The pill」。
    const base = {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-a",
      siteId: "actor#1",
      ordinal: 1,
      actorName: "reviewer",
    };
    const slot = openWorkflowActorSessionSidePane(null, base);
    expect(slot.tabs).toHaveLength(1);
    expect(slot.tabs[0]).not.toHaveProperty("actorSessionId");
    expect(slot.tabs[0]).toMatchObject({ runId: "dwfrun-a", siteId: "actor#1", ordinal: 1 });

    const started = openWorkflowActorSessionSidePane(slot, {
      ...base,
      actorSessionId: "dwf-dwfrun-a-actor_1@1",
    });
    expect(started.tabs).toHaveLength(1);
    expect(started.tabs[0]!.id).toBe(slot.tabs[0]!.id);
    expect(started.tabs[0]).toMatchObject({ actorSessionId: "dwf-dwfrun-a-actor_1@1" });

    // 再来一次不带会话的请求也不会把已知的会话 id 抹掉。
    const again = openWorkflowActorSessionSidePane(started, base);
    expect(again.tabs).toHaveLength(1);
    expect(again.tabs[0]).toMatchObject({ actorSessionId: "dwf-dwfrun-a-actor_1@1" });
    // 另一条 run 里的同一槽位是另一个 tab。
    const otherRun = openWorkflowActorSessionSidePane(again, { ...base, runId: "dwfrun-b" });
    expect(otherRun.tabs).toHaveLength(2);
  });

  it("actor transcript tab 按所属对话收窄可见性，且不是 workspace 全局 tab", () => {
    const state = openWorkflowActorSessionSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
    });
    const tab = state.tabs[0]!;

    expect(isWorkspaceGlobalSidePaneTab(tab)).toBe(false);
    expect(isSidePaneTabVisibleForParent(tab, "parent-a")).toBe(true);
    expect(isSidePaneTabVisibleForParent(tab, "parent-b")).toBe(false);
    expect(getVisibleSidePaneTabs(state, "parent-a")).toHaveLength(1);
    expect(getVisibleSidePaneTabs(state, "parent-b")).toHaveLength(0);
    expect(
      resolveActiveTabForOwner(state, { ownerTaskId: "parent-a", workspaceKey: "/workspace" }),
    ).toBe(tab.id);
    expect(
      resolveActiveTabForOwner(state, { ownerTaskId: "parent-b", workspaceKey: "/workspace" }),
    ).toBeNull();
  });

  it("子会话那套回收绝不吃 actor transcript tab", () => {
    // 这是这个 tab 用**独立类型**而不是给 subagent-session 加个变体标记的理由：
    // syncSubagentSessionSidePaneTabs 会删掉 childSessionId 不在有效集里的 subagent tab，
    // 而 actor 会话永远不在那个集合里（它不是 subagent 的子会话）——复用类型等于每次
    // 子会话投影一更新就把这个 tab 关掉。
    const state = openWorkflowActorSessionSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
    });

    expect(
      syncSubagentSessionSidePaneTabs(state, {
        rootSessionId: "parent-a",
        parentSessionId: "parent-a",
        validChildSessionIds: [],
      }),
    ).toBe(state);
    // 连 actor 会话 id 被当成「有效子会话」误传进来也不改变结论：类型不匹配，扫不到。
    expect(
      syncSubagentSessionSidePaneTabs(state, {
        rootSessionId: "parent-a",
        parentSessionId: "parent-a",
        validChildSessionIds: ["dwf-dwfrun-1-actor_1@1"],
      }),
    ).toBe(state);
  });

  it("切回对话时 actor transcript tab 与 workflow run 同档参与优先激活", () => {
    const withBrowser = openBrowserSidePane(null, { tabId: "browser:1" });
    const withActor = openWorkflowActorSessionSidePane(withBrowser, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
    });
    const selected = selectSidePaneTabsForParent(
      { ...withActor, activeTabId: "missing" },
      "parent-a",
    );
    expect(selected?.activeTabId).toContain("workflow-actor-session:");
  });

  // ── 产物 tab（docs/dynamic-workflow/authoring.md「How the user sees them」）──
  // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 交付给用户的产出，不是引擎内部那个
  // 「脚本顶层返回值」的同名词。
  it("身份是 (workspace, 父会话, run, 产物 id)——**不含版本**，同一产物再点只聚焦同一个 tab", () => {
    const first = openWorkflowArtifactSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      version: 1,
      title: "审计报告",
    });
    // 同一个产物发了新版之后再点一次（chip 从不带版本号）。
    const reclicked = openWorkflowArtifactSidePane(first, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
    });

    expect(first.tabs).toHaveLength(1);
    expect(reclicked.tabs).toHaveLength(1);
    expect(reclicked.activeTabId).toBe("workflow-artifact:%2Fworkspace:parent-a:dwfrun-1:book");
    // **回到最新版**：合并时旧 tab 上停着的 version 必须被丢掉，否则再点一次仍停在 v1。
    expect(reclicked.tabs[0]).toMatchObject({
      type: "workflow-artifact",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
    });
    expect("version" in reclicked.tabs[0]!).toBe(false);

    // 另一个产物是另一个 tab。
    const sibling = openWorkflowArtifactSidePane(reclicked, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "perf",
    });
    expect(sibling.tabs).toHaveLength(2);
  });

  it("显式带版本时那一版才是落点", () => {
    const first = openWorkflowArtifactSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
    });
    const pinned = openWorkflowArtifactSidePane(first, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      version: 2,
    });
    expect(pinned.tabs).toHaveLength(1);
    expect(pinned.tabs[0]).toMatchObject({ version: 2 });
  });

  it("产物 tab 按所属对话收窄可见性，且不是 workspace 全局 tab", () => {
    const state = openWorkflowArtifactSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
    });
    const tab = state.tabs[0]!;

    expect(isWorkspaceGlobalSidePaneTab(tab)).toBe(false);
    expect(isSidePaneTabVisibleForParent(tab, "parent-a")).toBe(true);
    expect(isSidePaneTabVisibleForParent(tab, "parent-b")).toBe(false);
    expect(getVisibleSidePaneTabs(state, "parent-a")).toHaveLength(1);
    expect(getVisibleSidePaneTabs(state, "parent-b")).toHaveLength(0);
  });

  it("子会话那套回收绝不吃产物 tab（产物的字节发布即钉住，run 被淘汰也还看得见）", () => {
    const state = openWorkflowArtifactSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
    });
    expect(
      syncSubagentSessionSidePaneTabs(state, {
        rootSessionId: "parent-a",
        parentSessionId: "parent-a",
        validChildSessionIds: [],
      }),
    ).toBe(state);
  });

  it("切回对话时产物 tab 与 workflow run 同档参与优先激活", () => {
    const withBrowser = openBrowserSidePane(null, { tabId: "browser:1" });
    const withArtifact = openWorkflowArtifactSidePane(withBrowser, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
    });
    const selected = selectSidePaneTabsForParent(
      { ...withArtifact, activeTabId: "missing" },
      "parent-a",
    );
    expect(selected?.activeTabId).toContain("workflow-artifact:");
  });

  it("远程 workspace 的产物 tab 按 workspaceIdentity 建 key，并留住 remoteSessionId", () => {
    const state = openWorkflowArtifactSidePane(null, {
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
    });
    expect(state.activeTabId).toBe(
      "workflow-artifact:ssh%3A%2F%2Fhost%2Fworkspace:parent-a:dwfrun-1:book",
    );
    expect(state.tabs[0]).toMatchObject({
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
    });
  });

  // ── 脚本 transcript tab（docs/dynamic-workflow/transcript-and-notifications.md「Opening the tab」）──
  it("身份是 (workspace, 父会话, run)——一个 run 一份脚本 transcript；再点只聚焦并重新落点", () => {
    const first = openWorkflowWorkspaceSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-a",
      workflowName: "Fan-out review",
      phaseId: "phase#a",
    });
    expect(first.tabs).toHaveLength(1);
    expect(first.activeTabId).toBe("workflow-workspace:%2Fworkspace:parent-a:dwfrun-a");
    expect(first.tabs[0]).toMatchObject({
      type: "workflow-workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-a",
      workflowName: "Fan-out review",
      focusPhaseId: "phase#a",
    });

    // 从另一站再点：同一个 tab，落点换成那一站。
    const relanded = openWorkflowWorkspaceSidePane(first, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-a",
      phaseId: "phase#b",
    });
    expect(relanded.tabs).toHaveLength(1);
    expect(relanded.tabs[0]).toMatchObject({
      focusPhaseId: "phase#b",
      workflowName: "Fan-out review",
    });

    // 不带站的请求（例如从 tab 总览重开）：落点**删掉**，不是沿用上一次的。
    const unlanded = openWorkflowWorkspaceSidePane(relanded, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-a",
    });
    expect(unlanded.tabs).toHaveLength(1);
    expect(unlanded.tabs[0]).not.toHaveProperty("focusPhaseId");

    // 另一条 run 是另一个 tab。
    const otherRun = openWorkflowWorkspaceSidePane(unlanded, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-2",
      runId: "dwfrun-b",
    });
    expect(otherRun.tabs).toHaveLength(2);
  });

  it("脚本 transcript tab 按所属对话收窄可见性，且不是 workspace 全局 tab", () => {
    const state = openWorkflowWorkspaceSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-1",
    });
    const tab = state.tabs[0]!;
    expect(isWorkspaceGlobalSidePaneTab(tab)).toBe(false);
    expect(isSidePaneTabVisibleForParent(tab, "parent-a")).toBe(true);
    expect(isSidePaneTabVisibleForParent(tab, "parent-b")).toBe(false);
    expect(getVisibleSidePaneTabs(state, "parent-a")).toHaveLength(1);
    expect(getVisibleSidePaneTabs(state, "parent-b")).toHaveLength(0);
  });

  it("子会话那套回收绝不吃脚本 transcript tab；切回对话时它与 workflow run 同档参与优先激活", () => {
    const withBrowser = openBrowserSidePane(null, { tabId: "browser:1" });
    const state = openWorkflowWorkspaceSidePane(withBrowser, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-1",
    });
    expect(
      syncSubagentSessionSidePaneTabs(state, {
        rootSessionId: "parent-a",
        parentSessionId: "parent-a",
        validChildSessionIds: [],
      }),
    ).toBe(state);
    const selected = selectSidePaneTabsForParent({ ...state, activeTabId: "missing" }, "parent-a");
    expect(selected?.activeTabId).toContain("workflow-workspace:");
  });

  it("reuses the developer tools tab", () => {
    const first = activateDeveloperToolsSidePane(null);
    const second = activateDeveloperToolsSidePane(first);

    expect(withoutOpenedAt(second)).toEqual({
      activeTabId: "developer-tools",
      tabs: [
        {
          id: "developer-tools",
          type: "developer-tools",
        },
      ],
    });
  });

  it("keeps browser and code viewer side by side and activates browser", () => {
    const current = openCodeViewerSidePane(null, viewerSource);

    const next = toggleBrowserSidePane(current);

    expect(next).not.toBeNull();
    if (!next) {
      throw new Error("Expected browser side pane state");
    }
    expect(next.activeTabId).toMatch(/^browser:/);
    expect(withoutOpenedAt(next)).toEqual({
      activeTabId: next.activeTabId,
      tabs: [
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer",
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
        {
          id: next.activeTabId,
          type: "browser",
          faviconUrl: null,
          initialUrl: null,
          title: null,
        },
      ],
    });
  });

  it("closes browser pane when toggled again and keeps other tabs", () => {
    const current = activateBrowserSidePane(openCodeViewerSidePane(null, viewerSource), {
      tabId: "browser:a",
    });

    expect(withoutOpenedAt(toggleBrowserSidePane(current))).toEqual({
      activeTabId: "code-viewer:file:/workspace/demo.ts",
      tabs: [
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer",
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
      ],
    });
  });

  it("only closes code viewer pane for code viewer state", () => {
    const viewerState = openCodeViewerSidePane(null, viewerSource);

    expect(closeCodeViewerSidePane(viewerState)).toBeNull();
    expect(
      withoutOpenedAt(
        closeCodeViewerSidePane({
          activeTabId: "browser:a",
          tabs: [{ id: "browser:a", type: "browser" }],
        }),
      ),
    ).toEqual({
      activeTabId: "browser:a",
      tabs: [{ id: "browser:a", type: "browser" }],
    });
  });

  it("can open multiple browser tabs", () => {
    const first = openBrowserSidePane(null, {
      tabId: "browser:a",
      initialUrl: "https://example.com/a",
    });
    const second = openBrowserSidePane(first, {
      tabId: "browser:b",
      initialUrl: "https://example.com/b",
    });

    expect(withoutOpenedAt(second)).toEqual({
      activeTabId: "browser:b",
      tabs: [
        {
          id: "browser:a",
          type: "browser",
          faviconUrl: null,
          initialUrl: "https://example.com/a",
          title: null,
        },
        {
          id: "browser:b",
          type: "browser",
          faviconUrl: null,
          initialUrl: "https://example.com/b",
          title: null,
        },
      ],
    });
  });

  it("保留模型 popup 标记，供视图跳过 human viewport 偏好", () => {
    const state = openBrowserSidePane(null, {
      tabId: "browser:agent-popup",
      initialUrl: "https://example.com/next",
      agentOpened: true,
    });

    expect(state.tabs[0]).toMatchObject({
      id: "browser:agent-popup",
      type: "browser",
      agentOpened: true,
    });
  });

  it("can open multiple terminal tabs with workspace titles", () => {
    const first = openTerminalSidePane(null, { title: "z-code" });
    const second = openTerminalSidePane(first, { title: "z-code 2" });

    expect(withoutOpenedAt(second)).toEqual({
      activeTabId: second.activeTabId,
      tabs: [
        {
          id: first.activeTabId,
          type: "terminal",
          title: "z-code",
        },
        {
          id: second.activeTabId,
          type: "terminal",
          title: "z-code 2",
        },
      ],
    });
    expect(first.activeTabId).toMatch(/^terminal:/);
    expect(second.activeTabId).toMatch(/^terminal:/);
    expect(second.activeTabId).not.toBe(first.activeTabId);
  });

  it("updates metadata for the targeted browser tab", () => {
    const current = openBrowserSidePane(openBrowserSidePane(null, { tabId: "browser:a" }), {
      tabId: "browser:b",
    });

    expect(
      withoutOpenedAt(
        updateBrowserSidePaneTab(current, "browser:b", {
          faviconUrl: "https://example.com/favicon.ico",
          title: "Example",
        }),
      ),
    ).toEqual({
      activeTabId: "browser:b",
      tabs: [
        {
          id: "browser:a",
          type: "browser",
          faviconUrl: null,
          initialUrl: null,
          title: null,
        },
        {
          id: "browser:b",
          type: "browser",
          faviconUrl: "https://example.com/favicon.ico",
          initialUrl: null,
          title: "Example",
        },
      ],
    });
  });

  it("activates an existing browser tab when toggled from another tab", () => {
    const current = openCodeViewerSidePane(
      openBrowserSidePane(null, { tabId: "browser:a" }),
      viewerSource,
    );

    expect(withoutOpenedAt(toggleBrowserSidePane(current))).toEqual({
      activeTabId: "browser:a",
      tabs: [
        {
          id: "browser:a",
          type: "browser",
          faviconUrl: null,
          initialUrl: null,
          title: null,
        },
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer",
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
      ],
    });
  });

  it("reuses the same code viewer tab for the same file path", () => {
    const first = openCodeViewerSidePane(null, viewerSource);
    const second = openCodeViewerSidePane(first, {
      ...viewerSource,
      offset: 128,
    });

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: "code-viewer:file:/workspace/demo.ts",
      type: "code-viewer",
      source: {
        ...viewerSource,
        offset: 128,
      },
    });
  });

  it("批量打开多份 PPTX，并激活卡片顺序中的第一份", () => {
    const current = activateBrowserSidePane(null, { tabId: "browser:kept" });
    const sources = [
      {
        type: "file" as const,
        title: "first.pptx",
        path: "/workspace/first.pptx",
        workspacePath: "/workspace",
      },
      {
        type: "file" as const,
        title: "second.pptx",
        path: "/workspace/second.pptx",
        workspacePath: "/workspace",
      },
    ];

    const next = openCodeViewerSidePanes(current, sources, "session-a");

    expect(next.tabs).toHaveLength(3);
    expect(next.tabs[0]).toMatchObject({ id: "browser:kept", type: "browser" });
    expect(next.tabs.slice(1)).toMatchObject([
      {
        type: "code-viewer",
        source: sources[0],
        sourceKey: "/workspace:pptx:/workspace/first.pptx",
      },
      {
        type: "code-viewer",
        source: sources[1],
        sourceKey: "/workspace:pptx:/workspace/second.pptx",
      },
    ]);
    expect(next.activeTabId).toBe("code-viewer:/workspace:pptx:/workspace/first.pptx");
  });

  it("批量打开会按 workspace sourceKey 去重并复用现有 Tab", () => {
    const source = {
      type: "file" as const,
      title: "deck.pptx",
      path: "/workspace/deck.pptx",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-a:/workspace",
    };
    const first = stampSidePaneTabsOwnership(openCodeViewerSidePane(null, source), {
      ownerTaskId: "session-a",
      workspaceKey: "remote:ssh:host-a:/workspace",
      remoteSessionId: null,
    });
    const next = openCodeViewerSidePanes(
      first,
      [source, { ...source, title: "deck updated.pptx" }],
      "session-a",
    );

    expect(next.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(next)).toMatchObject({
      type: "code-viewer",
      ownerTaskId: "session-a",
      source: source,
      sourceKey: "remote:ssh:host-a:/workspace:pptx:/workspace/deck.pptx",
    });
  });

  it("reuses the same code-review tab for one file while refreshing the model review", () => {
    const source = {
      type: "code-review" as const,
      title: "demo.ts",
      path: "/workspace/demo.ts",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-a:/workspace",
      review: {
        requestId: "review-1",
        title: "First review",
        body: "First body",
        startLine: 2,
        endLine: 3,
      },
    };
    const first = openCodeViewerSidePane(null, source);
    const second = openCodeViewerSidePane(first, {
      ...source,
      review: {
        ...source.review,
        requestId: "review-2",
        title: "Second review",
        body: "Second body",
        startLine: 8,
        endLine: 8,
      },
    });

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: "code-viewer:remote:ssh:host-a:/workspace:code-review:/workspace/demo.ts",
      sourceKey: "remote:ssh:host-a:/workspace:code-review:/workspace/demo.ts",
      source: {
        type: "code-review",
        review: {
          requestId: "review-2",
          title: "Second review",
          body: "Second body",
          startLine: 8,
          endLine: 8,
        },
      },
    });
  });

  it("keeps ordinary file and code-review tabs separate for the same path", () => {
    const reviewSource = {
      type: "code-review" as const,
      title: "demo.ts",
      path: "/workspace/demo.ts",
      review: {
        requestId: "review-1",
        title: "Review",
        body: "Body",
      },
    };
    const first = openCodeViewerSidePane(null, viewerSource);
    const second = openCodeViewerSidePane(first, reviewSource);

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs.map((tab) => (tab.type === "code-viewer" ? tab.sourceKey : null))).toEqual([
      "file:/workspace/demo.ts",
      "code-review:/workspace/demo.ts",
    ]);
  });

  it("reuses the same code viewer tab for the same pdf path", () => {
    const pdfSource = {
      type: "pdf" as const,
      title: "report.pdf",
      path: "/workspace/report.pdf",
    };
    const first = openCodeViewerSidePane(null, pdfSource);
    const second = openCodeViewerSidePane(first, pdfSource);

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: "code-viewer:pdf:/workspace/report.pdf",
      type: "code-viewer",
      source: pdfSource,
    });
  });

  it("reuses the same PPTX tab while refreshing reference navigation intent", () => {
    const source = {
      type: "pptx" as const,
      title: "deck.pptx",
      path: "/workspace/deck.pptx",
      referenceNavigation: {
        requestId: "navigation-1",
        pageIndex: 0,
        expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
      },
    };
    const first = openCodeViewerSidePane(null, source);
    const second = openCodeViewerSidePane(first, {
      ...source,
      referenceNavigation: {
        ...source.referenceNavigation,
        requestId: "navigation-2",
        pageIndex: 2,
      },
    });

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: "code-viewer:pptx:/workspace/deck.pptx",
      source: {
        referenceNavigation: {
          requestId: "navigation-2",
          pageIndex: 2,
        },
      },
    });
  });

  it("reuses the file-tree PPTX tab when a presentation reference opens the same file", () => {
    const fileTreeSource = {
      type: "file" as const,
      title: "deck.pptx",
      path: "/workspace/deck.pptx",
      workspacePath: "/workspace",
    };
    const referenceSource = {
      type: "pptx" as const,
      title: "deck.pptx",
      path: "/workspace/deck.pptx",
      workspacePath: "/workspace",
      referenceNavigation: {
        requestId: "navigation-from-reference",
        pageIndex: 2,
        expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
      },
    };

    const first = openCodeViewerSidePane(null, fileTreeSource);
    const second = openCodeViewerSidePane(first, referenceSource);

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: "code-viewer:/workspace:pptx:/workspace/deck.pptx",
      sourceKey: "/workspace:pptx:/workspace/deck.pptx",
      source: referenceSource,
    });
  });

  it("reuses the reference-opened PPTX tab when the file tree opens the same file", () => {
    const referenceSource = {
      type: "pptx" as const,
      title: "deck.pptx",
      path: "/workspace/deck.pptx",
      workspacePath: "/workspace",
      referenceNavigation: {
        requestId: "navigation-from-reference",
        pageIndex: 2,
        expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
      },
    };
    const fileTreeSource = {
      type: "file" as const,
      title: "deck.pptx",
      path: "/workspace/deck.pptx",
      workspacePath: "/workspace",
    };

    const first = openCodeViewerSidePane(null, referenceSource);
    const second = openCodeViewerSidePane(first, fileTreeSource);

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: "code-viewer:/workspace:pptx:/workspace/deck.pptx",
      sourceKey: "/workspace:pptx:/workspace/deck.pptx",
      source: fileTreeSource,
    });
  });

  it("keeps same-path file previews isolated by workspace identity", () => {
    const first = openCodeViewerSidePane(null, {
      ...viewerSource,
      workspaceIdentity: "remote:ssh:host-a:/workspace",
    });
    const second = openCodeViewerSidePane(first, {
      ...viewerSource,
      workspaceIdentity: "remote:ssh:host-b:/workspace",
    });

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs.map((tab) => (tab.type === "code-viewer" ? tab.sourceKey : null))).toEqual([
      "remote:ssh:host-a:/workspace:file:/workspace/demo.ts",
      "remote:ssh:host-b:/workspace:file:/workspace/demo.ts",
    ]);
  });

  it("normalizes uri-encoded code viewer paths before creating tab keys", () => {
    const encodedSource = {
      type: "file" as const,
      title: "engine.ts",
      path: "/Users/dev/ZCodeProject/323/Auto%20Snake/src/game/engine.ts",
    };
    const decodedPath = "/Users/dev/ZCodeProject/323/Auto Snake/src/game/engine.ts";

    const first = openCodeViewerSidePane(null, encodedSource);
    const second = openCodeViewerSidePane(first, {
      ...encodedSource,
      path: decodedPath,
    });

    expect(second.tabs).toHaveLength(1);
    expect(getActiveSidePaneTab(second)).toMatchObject({
      id: `code-viewer:file:${decodedPath}`,
      type: "code-viewer",
      source: {
        ...encodedSource,
        path: decodedPath,
      },
      sourceKey: `file:${decodedPath}`,
    });
  });

  it("keeps different patch previews for the same file in separate tabs", () => {
    const firstPatch = {
      type: "patch" as const,
      title: "demo.ts",
      path: "/workspace/demo.ts",
      patch: "--- a/demo.ts\n+++ b/demo.ts\n@@\n-old\n+new",
    };
    const secondPatch = {
      ...firstPatch,
      patch: "--- a/demo.ts\n+++ b/demo.ts\n@@\n-old\n+newer",
    };

    const first = openCodeViewerSidePane(null, firstPatch);
    const second = openCodeViewerSidePane(first, secondPatch);
    const reopenedSecond = openCodeViewerSidePane(second, secondPatch);

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs.map((tab) => (tab.type === "code-viewer" ? tab.source : null))).toEqual([
      firstPatch,
      secondPatch,
    ]);
    expect(reopenedSecond.tabs).toHaveLength(2);
    expect(reopenedSecond.activeTabId).toBe(second.activeTabId);
  });

  it("keeps different MultiFileDiff previews for the same file in separate tabs", () => {
    const firstDiff = {
      type: "multi-file-diff" as const,
      title: "demo.ts",
      path: "/workspace/demo.ts",
      beforeContent: "const value = 1;\n",
      afterContent: "const value = 2;\n",
    };
    const secondDiff = {
      ...firstDiff,
      afterContent: "const value = 3;\n",
    };

    const first = openCodeViewerSidePane(null, firstDiff);
    const second = openCodeViewerSidePane(first, secondDiff);
    const reopenedSecond = openCodeViewerSidePane(second, secondDiff);

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs.map((tab) => (tab.type === "code-viewer" ? tab.source : null))).toEqual([
      firstDiff,
      secondDiff,
    ]);
    expect(reopenedSecond.tabs).toHaveLength(2);
    expect(reopenedSecond.activeTabId).toBe(second.activeTabId);
  });

  it("activates git without dropping existing tabs", () => {
    const current = activateBrowserSidePane(openCodeViewerSidePane(null, viewerSource), {
      tabId: "browser:a",
    });

    expect(withoutOpenedAt(toggleGitSidePane(current))).toEqual({
      activeTabId: "git",
      tabs: [
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer",
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
        {
          id: "browser:a",
          type: "browser",
          faviconUrl: null,
          initialUrl: null,
          title: null,
        },
        { id: "git", type: "git" },
      ],
    });
  });

  it("reorders tabs without changing active tab", () => {
    const current = activateBrowserSidePane(openCodeViewerSidePane(null, viewerSource), {
      tabId: "browser:a",
    });
    const withGit = toggleGitSidePane(current)!;

    expect(
      withoutOpenedAt(reorderSidePaneTab(withGit, "git", "code-viewer:file:/workspace/demo.ts")),
    ).toEqual({
      activeTabId: "git",
      tabs: [
        { id: "git", type: "git" },
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer",
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
        {
          id: "browser:a",
          type: "browser",
          faviconUrl: null,
          initialUrl: null,
          title: null,
        },
      ],
    });
  });

  it("keeps state unchanged when reordering unknown tabs", () => {
    const current = activateBrowserSidePane(openCodeViewerSidePane(null, viewerSource), {
      tabId: "browser:a",
    });

    expect(reorderSidePaneTab(current, "missing", "browser:a")).toBe(current);
    expect(reorderSidePaneTab(current, "browser:a", "missing")).toBe(current);
  });

  it("closes the active tab and falls back to the neighbor on the right", () => {
    const state = {
      activeTabId: "browser:a",
      tabs: [
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer" as const,
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
        { id: "browser:a", type: "browser" as const },
        { id: "git", type: "git" as const },
      ],
    };

    expect(withoutOpenedAt(closeSidePaneTab(state, "browser:a"))).toEqual({
      activeTabId: "git",
      tabs: [
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer",
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
        { id: "git", type: "git" },
      ],
    });
  });

  it("closes other tabs and activates the retained tab", () => {
    const state = {
      activeTabId: "browser:a",
      tabs: [
        {
          id: "code-viewer:file:/workspace/demo.ts",
          type: "code-viewer" as const,
          source: viewerSource,
          sourceKey: "file:/workspace/demo.ts",
        },
        { id: "browser:a", type: "browser" as const },
        { id: "git", type: "git" as const },
      ],
    };

    expect(withoutOpenedAt(closeOtherSidePaneTabs(state, "git"))).toEqual({
      activeTabId: "git",
      tabs: [{ id: "git", type: "git" }],
    });
  });

  it("closes every side pane tab", () => {
    expect(closeAllSidePaneTabs()).toBeNull();
  });

  it("restores a closed tab as the active tab", () => {
    const state = restoreSidePaneTab(null, {
      id: "browser:a",
      type: "browser",
      initialUrl: "https://example.com",
      openedAt: 123,
    });

    expect(withoutOpenedAt(state)).toEqual({
      activeTabId: "browser:a",
      tabs: [
        {
          id: "browser:a",
          type: "browser",
          initialUrl: "https://example.com",
        },
      ],
    });
  });

  describe("openBrowserUseSidePane", () => {
    it("按 tabId 建 browser-use tab，并写入 origin session/workspace 归属", () => {
      const state = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      expect(state.activeTabId).toBe("browser-use:tab-1");
      expect(state.tabs).toHaveLength(1);
      const tab = state.tabs[0];
      expect(tab.type).toBe("browser-use");
      expect(tab).toMatchObject({
        id: "browser-use:tab-1",
        ownerTaskId: "sess-1",
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
    });

    it("同一 tabId 重放 ready 时复用同一 tab（不重复开）", () => {
      const first = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      const second = openBrowserUseSidePane(first, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      expect(second.tabs).toHaveLength(1);
      expect(second.activeTabId).toBe("browser-use:tab-1");
    });

    it("不同 sessionId 各开一个 tab", () => {
      const first = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      const second = openBrowserUseSidePane(first, {
        workspaceKey: "/workspace",
        sessionId: "sess-2",
        tabId: "tab-2",
      });
      expect(second.tabs).toHaveLength(2);
      expect(second.activeTabId).toBe("browser-use:tab-2");
    });

    it("显式 activate=false 可后台追加，后续 activate=true 再激活", () => {
      const current = openBrowserSidePane(null, { tabId: "browser:human" });
      const background = openBrowserUseSidePane(current, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
        activate: false,
      });
      expect(background.activeTabId).toBe("browser:human");
      const visible = openBrowserUseSidePane(background, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
        activate: true,
      });
      expect(visible.activeTabId).toBe("browser-use:tab-1");
    });

    it("updateBrowserSidePaneTab 回填 browser-use tab 的真实标题/favicon", () => {
      const opened = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      const updated = updateBrowserSidePaneTab(opened, "browser-use:tab-1", {
        title: "Example Domain",
        faviconUrl: "https://example.com/favicon.ico",
      });
      const tab = updated?.tabs[0];
      expect(tab).toMatchObject({
        type: "browser-use",
        title: "Example Domain",
        faviconUrl: "https://example.com/favicon.ico",
      });
    });

    it("重开同一 browser-use tab 保留已回填的标题/favicon（握手期 guest 重建不清空）", () => {
      const opened = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      const withMeta = updateBrowserSidePaneTab(opened, "browser-use:tab-1", {
        title: "Example Domain",
        faviconUrl: "https://example.com/favicon.ico",
      });
      // 模拟 guest 销毁后再命令 → 再次广播 BrowserViewReady → 再次 open。
      const reopened = openBrowserUseSidePane(withMeta, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
      });
      expect(reopened.tabs).toHaveLength(1);
      expect(reopened.tabs[0]).toMatchObject({
        type: "browser-use",
        title: "Example Domain",
        faviconUrl: "https://example.com/favicon.ico",
      });
    });

    it("按 workspace/session/tab 标记 5 秒操作状态且不覆盖 favicon", () => {
      const opened = openBrowserUseSidePane(null, {
        workspaceKey: "remote:ssh:host:/workspace",
        sessionId: "sess-1",
        tabId: "tab-1",
        browserId: "iab-1",
        browserGeneration: 7,
      });
      const withMeta = updateBrowserSidePaneTab(opened, "browser-use:tab-1", {
        faviconUrl: "https://example.com/favicon.ico",
      });
      const operationUntil = 10_000 + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
      const marked = markBrowserUseSidePaneTabOperation(withMeta, {
        workspaceKey: "remote:ssh:host:/workspace",
        sessionId: "sess-1",
        browserId: "iab-1",
        browserGeneration: 7,
        tabId: "tab-1",
        operationUntil,
      });

      expect(marked?.tabs[0]).toMatchObject({
        faviconUrl: "https://example.com/favicon.ico",
        browserUseOperationUntil: operationUntil,
      });
      expect(
        markBrowserUseSidePaneTabOperation(marked, {
          workspaceKey: "/workspace",
          sessionId: "sess-1",
          browserId: "iab-1",
          browserGeneration: 7,
          tabId: "tab-1",
          operationUntil: operationUntil + 1,
        }),
      ).toBe(marked);
      expect(
        markBrowserUseSidePaneTabOperation(marked, {
          workspaceKey: "remote:ssh:host:/workspace",
          sessionId: "sess-1",
          browserId: "iab-1",
          browserGeneration: 8,
          tabId: "tab-1",
          operationUntil: operationUntil + 1,
        }),
      ).toBe(marked);
    });

    it("同一 tab 的后续操作刷新截止时间，只有布局命令推进 resize baseline 版本", () => {
      const opened = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        browserId: "iab-1",
        browserGeneration: 1,
        tabId: "tab-1",
      });
      const first = markBrowserUseSidePaneTabOperation(opened, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        browserId: "iab-1",
        browserGeneration: 1,
        tabId: "tab-1",
        operationUntil: 5_000,
        resetsResizeBaseline: true,
      });
      const second = markBrowserUseSidePaneTabOperation(first, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        browserId: "iab-1",
        browserGeneration: 1,
        tabId: "tab-1",
        operationUntil: 9_000,
      });
      const third = markBrowserUseSidePaneTabOperation(second, {
        workspaceKey: "/workspace",
        sessionId: "sess-1",
        browserId: "iab-1",
        browserGeneration: 1,
        tabId: "tab-1",
        operationUntil: 12_000,
        resetsResizeBaseline: true,
      });

      expect(second?.tabs[0]).toMatchObject({
        browserUseOperationUntil: 9_000,
        browserUseResizeBaselineVersion: 1,
      });
      expect(third?.tabs[0]).toMatchObject({
        browserUseOperationUntil: 12_000,
        browserUseResizeBaselineVersion: 2,
      });
    });

    it("A 的迟到 ready 在 B active 时后台归属 A，切回 A 后可恢复", () => {
      const current = openBrowserSidePane(null, { tabId: "browser:b" });
      const stampedCurrent = stampSidePaneTabsOwnership(current, {
        workspaceKey: "/workspace",
        ownerTaskId: "sess-b",
      });
      const result = applyBrowserUseSidePaneEvent(
        stampedCurrent,
        {
          workspaceKey: "/workspace",
          sessionId: "sess-a",
          tabId: "tab-a",
          browserId: "iab",
          browserGeneration: 1,
        },
        { workspaceKey: "/workspace", ownerTaskId: "sess-b" },
      );

      expect(result.shouldReveal).toBe(false);
      expect(result.state.activeTabId).toBe("browser:b");
      expect(result.state.tabs.at(-1)).toMatchObject({
        id: "browser-use:tab-a",
        ownerTaskId: "sess-a",
        workspaceKey: "/workspace",
        sessionId: "sess-a",
      });
      expect(
        resolveActiveTabForOwner(result.state, {
          workspaceKey: "/workspace",
          ownerTaskId: "sess-a",
        }),
      ).toBe("browser-use:tab-a");
    });

    it("A 的 browser-use tab 在切到无 tab 的 B 后保持挂载，切回 A 主动展开", () => {
      const stateA = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-a",
        tabId: "tab-a",
      });

      const stateB = resolveSidePaneScopeState(stateA, {
        workspaceKey: "/workspace",
        ownerTaskId: "sess-b",
      });
      expect(stateB.sidePaneState).toMatchObject({
        activeTabId: "",
        tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
      });
      expect(stateB.isSidePaneCollapsed).toBe(true);
      expect(shouldMountSidePaneContent(false, stateB.sidePaneState?.tabs ?? [])).toBe(true);

      const restoredA = resolveSidePaneScopeState(stateB.sidePaneState, {
        workspaceKey: "/workspace",
        ownerTaskId: "sess-a",
      });
      expect(restoredA.sidePaneState).toMatchObject({
        activeTabId: "browser-use:tab-a",
        tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
      });
      expect(restoredA.isSidePaneCollapsed).toBe(false);
    });

    it("A 主动收起后切到 B 再切回 A 仍保持收起", () => {
      const stateA = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-a",
        tabId: "tab-a",
      });

      const stateB = resolveSidePaneScopeState(
        stateA,
        { workspaceKey: "/workspace", ownerTaskId: "sess-b" },
        undefined,
        true,
      );
      const restoredA = resolveSidePaneScopeState(
        stateB.sidePaneState,
        { workspaceKey: "/workspace", ownerTaskId: "sess-a" },
        undefined,
        true,
      );

      expect(restoredA.sidePaneState).toMatchObject({
        activeTabId: "browser-use:tab-a",
        tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
      });
      expect(restoredA.isSidePaneCollapsed).toBe(true);
    });

    it("origin session 仍 active 时立即展开并激活", () => {
      const result = applyBrowserUseSidePaneEvent(
        null,
        { workspaceKey: "/workspace", sessionId: "sess-a", tabId: "tab-a" },
        { workspaceKey: "/workspace", ownerTaskId: "sess-a" },
      );

      expect(result.shouldReveal).toBe(true);
      expect(result.state.activeTabId).toBe("browser-use:tab-a");
    });

    it("BTL19: remote visibility 重放不会清空既有 remoteSessionId", () => {
      const ready = openBrowserUseSidePane(null, {
        workspaceKey: "ssh://host/repo",
        remoteSessionId: "remote-a",
        sessionId: "sess-a",
        tabId: "tab-a",
        browserId: "iab-a",
        browserGeneration: 2,
      });

      const result = applyBrowserUseSidePaneEvent(
        ready,
        {
          workspaceKey: "ssh://host/repo",
          remoteSessionId: "remote-a",
          sessionId: "sess-a",
          tabId: "tab-a",
          browserId: "iab-a",
          browserGeneration: 2,
        },
        {
          workspaceKey: "ssh://host/repo",
          remoteSessionId: "remote-a",
          ownerTaskId: "sess-a",
        },
      );
      const legacyReplay = applyBrowserUseSidePaneEvent(
        result.state,
        {
          workspaceKey: "ssh://host/repo",
          sessionId: "sess-a",
          tabId: "tab-a",
          browserId: "iab-a",
          browserGeneration: 2,
        },
        {
          workspaceKey: "ssh://host/repo",
          remoteSessionId: "remote-a",
          ownerTaskId: "sess-a",
        },
      );

      expect(result.state.tabs[0]).toMatchObject({ remoteSessionId: "remote-a" });
      expect(legacyReplay.state.tabs[0]).toMatchObject({ remoteSessionId: "remote-a" });
    });

    it("同一 session 多个 browser-use tab 时 show 事件激活指定 tab", () => {
      const first = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-a",
        tabId: "tab-a",
      });
      const withBackground = openBrowserUseSidePane(first, {
        workspaceKey: "/workspace",
        sessionId: "sess-a",
        tabId: "tab-b",
        activate: false,
      });

      const result = applyBrowserUseSidePaneEvent(
        withBackground,
        { workspaceKey: "/workspace", sessionId: "sess-a", tabId: "tab-b" },
        { workspaceKey: "/workspace", ownerTaskId: "sess-a" },
      );

      expect(result.shouldReveal).toBe(true);
      expect(result.state.activeTabId).toBe("browser-use:tab-b");
    });

    it("visibility 只激活已有 browser-use tab，不创建已关闭的 tab shell", () => {
      const first = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-a",
        tabId: "tab-a",
      });
      const withBackground = openBrowserUseSidePane(first, {
        workspaceKey: "/workspace",
        sessionId: "sess-a",
        tabId: "tab-b",
        activate: false,
      });
      const activeScope = { workspaceKey: "/workspace", ownerTaskId: "sess-a" };

      const activated = applyBrowserUseSidePaneVisibilityEvent(
        withBackground,
        { workspaceKey: "/workspace", sessionId: "sess-a", tabId: "tab-b" },
        activeScope,
      );
      expect(activated.shouldReveal).toBe(true);
      expect(activated.state.activeTabId).toBe("browser-use:tab-b");

      const closed = closeSidePaneTab(activated.state, "browser-use:tab-b");
      const delayedVisibility = applyBrowserUseSidePaneVisibilityEvent(
        closed,
        { workspaceKey: "/workspace", sessionId: "sess-a", tabId: "tab-b" },
        activeScope,
      );
      expect(delayedVisibility.shouldReveal).toBe(false);
      expect(delayedVisibility.state).toBe(closed);
      expect(delayedVisibility.state.tabs).toHaveLength(1);
      expect(delayedVisibility.state.tabs[0]?.tabId).toBe("tab-a");
    });

    it("后台 session 激活 tab 时不抢前台，切回可按 preferred tab 恢复", () => {
      const backgroundA = openBrowserUseSidePane(null, {
        workspaceKey: "/workspace",
        sessionId: "sess-x",
        tabId: "tab-x-a",
      });
      const backgroundB = openBrowserUseSidePane(backgroundA, {
        workspaceKey: "/workspace",
        sessionId: "sess-x",
        tabId: "tab-x-b",
        activate: false,
      });
      const foreground = openBrowserUseSidePane(backgroundB, {
        workspaceKey: "/workspace",
        sessionId: "sess-y",
        tabId: "tab-y",
      });

      const result = applyBrowserUseSidePaneEvent(
        foreground,
        { workspaceKey: "/workspace", sessionId: "sess-x", tabId: "tab-x-b" },
        { workspaceKey: "/workspace", ownerTaskId: "sess-y" },
      );

      expect(result.shouldReveal).toBe(false);
      expect(result.state.activeTabId).toBe("browser-use:tab-y");
      expect(
        resolveActiveTabForOwner(
          result.state,
          { workspaceKey: "/workspace", ownerTaskId: "sess-x" },
          "browser-use:tab-x-b",
        ),
      ).toBe("browser-use:tab-x-b");
    });

    it("其它 workspace 的 ready 也只后台挂载，不抢当前对话", () => {
      const current = openBrowserSidePane(null, { tabId: "browser:b" });
      const stampedCurrent = stampSidePaneTabsOwnership(current, {
        workspaceKey: "/workspace-b",
        ownerTaskId: "sess-a",
      });
      const result = applyBrowserUseSidePaneEvent(
        stampedCurrent,
        { workspaceKey: "/workspace-a", sessionId: "sess-a", tabId: "tab-a" },
        { workspaceKey: "/workspace-b", ownerTaskId: "sess-a" },
      );

      expect(result.shouldReveal).toBe(false);
      expect(result.state.activeTabId).toBe("browser:b");
      expect(result.state.tabs.at(-1)).toMatchObject({
        workspaceKey: "/workspace-a",
      });
    });
  });

  describe("按 (项目, 对话) 隔离", () => {
    // 便捷构造可见性作用域；workspaceKey 缺省 null（tab.workspaceKey==null 时对任意项目可见）。
    const scope = (ownerTaskId: string | null, workspaceKey: string | null = null) => ({
      workspaceKey,
      ownerTaskId,
    });

    it("stampSidePaneTabsOwnership 只给未打标(undefined)的新 tab 打归属(对话+项目)，已打标的不动", () => {
      const opened = openBrowserSidePane(null, { tabId: "browser:1" });
      expect(opened.tabs[0]!.ownerTaskId).toBeUndefined();
      const stamped = stampSidePaneTabsOwnership(opened, {
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      })!;
      expect(stamped.tabs[0]!.ownerTaskId).toBe("task-a");
      expect(stamped.tabs[0]!.workspaceKey).toBe("ws-1");
      // 再次 stamp 用别的归属，不应改动已打标的。
      const restamped = stampSidePaneTabsOwnership(stamped, {
        ownerTaskId: "task-b",
        workspaceKey: "ws-2",
      })!;
      expect(restamped.tabs[0]!.ownerTaskId).toBe("task-a");
      expect(restamped).toBe(stamped);
    });

    it("getVisibleSidePaneTabs 按对话过滤；undefined/null 归到草稿；workspace 工具对本项目所有对话可见", () => {
      const tabs = [
        { id: "a", type: "browser" as const, ownerTaskId: "task-a" },
        { id: "b", type: "browser" as const, ownerTaskId: "task-b" },
        { id: "d", type: "browser" as const, ownerTaskId: null },
        { id: "u", type: "browser" as const },
        { id: "git", type: "git" as const, ownerTaskId: "task-a" },
      ];
      expect(getVisibleSidePaneTabs(tabs, scope("task-a")).map((t) => t.id)).toEqual(["a", "git"]);
      expect(getVisibleSidePaneTabs(tabs, scope("task-b")).map((t) => t.id)).toEqual(["b", "git"]);
      expect(getVisibleSidePaneTabs(tabs, scope(null)).map((t) => t.id)).toEqual(["d", "u", "git"]);
    });

    it("getVisibleSidePaneTabs 按项目(workspaceKey)隔离：切项目只看本项目的 tab（含 workspace 工具）", () => {
      const tabs = [
        {
          id: "a1",
          type: "browser" as const,
          ownerTaskId: "task-a",
          workspaceKey: "ws-1",
        },
        {
          id: "b1",
          type: "browser" as const,
          ownerTaskId: "task-b",
          workspaceKey: "ws-2",
        },
        {
          id: "git1",
          type: "git" as const,
          ownerTaskId: "task-a",
          workspaceKey: "ws-1",
        },
        {
          id: "git2",
          type: "git" as const,
          ownerTaskId: "task-b",
          workspaceKey: "ws-2",
        },
      ];
      // 项目 ws-1、对话 task-a：只看 ws-1 的 tab（a1 + ws-1 的 git）。
      expect(getVisibleSidePaneTabs(tabs, scope("task-a", "ws-1")).map((t) => t.id)).toEqual([
        "a1",
        "git1",
      ]);
      // 项目 ws-2、对话 task-b：只看 ws-2 的 tab。
      expect(getVisibleSidePaneTabs(tabs, scope("task-b", "ws-2")).map((t) => t.id)).toEqual([
        "b1",
        "git2",
      ]);
    });

    it("resolveActiveTabForOwner：preferred 优先 → 当前 active → 该作用域最新 → 无则 null", () => {
      const state = {
        activeTabId: "a2",
        tabs: [
          { id: "a1", type: "browser" as const, ownerTaskId: "task-a" },
          { id: "a2", type: "browser" as const, ownerTaskId: "task-a" },
          { id: "b1", type: "browser" as const, ownerTaskId: "task-b" },
        ],
      };
      expect(resolveActiveTabForOwner(state, scope("task-a"), "a1")).toBe("a1");
      expect(resolveActiveTabForOwner(state, scope("task-a"), "b1")).toBe("a2");
      expect(resolveActiveTabForOwner(state, scope("task-b"))).toBe("b1");
      expect(resolveActiveTabForOwner(state, scope("task-c"))).toBeNull();
    });

    it("toggle/activate browser 只复用当前对话的 browser tab，不串用别的对话", () => {
      const stateA = stampSidePaneTabsOwnership(openBrowserSidePane(null, { tabId: "browser:a" }), {
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      })!;
      expect(getVisibleSidePaneTabs(stateA.tabs, scope("task-a", "ws-1")).map((t) => t.id)).toEqual(
        ["browser:a"],
      );

      // 在对话 B 点浏览器开关：不能复用 A 的 tab，应为 B 新建；A 的 tab 仍保留（不销毁）。
      const toggled = stampSidePaneTabsOwnership(toggleBrowserSidePane(stateA, "task-b"), {
        ownerTaskId: "task-b",
        workspaceKey: "ws-1",
      })!;
      expect(toggled.tabs).toHaveLength(2);
      const bVisible = getVisibleSidePaneTabs(toggled.tabs, scope("task-b", "ws-1"));
      expect(bVisible).toHaveLength(1);
      expect(bVisible[0]!.id).not.toBe("browser:a");
      expect(toggled.activeTabId).toBe(bVisible[0]!.id);
      expect(
        getVisibleSidePaneTabs(toggled.tabs, scope("task-a", "ws-1")).map((t) => t.id),
      ).toEqual(["browser:a"]);
    });
  });

  describe("openOrActivateBrowserSidePaneByUrl", () => {
    const REPORT_URL = "file:///repo/report.html";

    it("同一 workspace/owner 的同一 URL 只激活已有 tab，并保留它的字段", () => {
      const first = openOrActivateBrowserSidePaneByUrl(null, {
        initialUrl: REPORT_URL,
        tabId: "browser:first",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      const other = openBrowserSidePane(first, { tabId: "browser:other" });
      const second = openOrActivateBrowserSidePaneByUrl(other, {
        initialUrl: REPORT_URL,
        tabId: "browser:second",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });

      expect(second.tabs.filter((tab) => tab.id === "browser:first")).toHaveLength(1);
      expect(second.tabs.some((tab) => tab.id === "browser:second")).toBe(false);
      expect(second.activeTabId).toBe("browser:first");
      // 复用不改任何字段：initialUrl 就是键，要重新取字节由调用方另发导航请求。
      expect(second.tabs.find((tab) => tab.id === "browser:first")).toEqual(
        first.tabs.find((tab) => tab.id === "browser:first"),
      );
    });

    it("URL / owner / workspace 任一不同都另开一个 tab", () => {
      const base = openOrActivateBrowserSidePaneByUrl(null, {
        initialUrl: REPORT_URL,
        tabId: "browser:base",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });

      const otherUrl = openOrActivateBrowserSidePaneByUrl(base, {
        initialUrl: "file:///repo/other.html",
        tabId: "browser:url",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      expect(otherUrl.activeTabId).toBe("browser:url");

      const otherOwner = openOrActivateBrowserSidePaneByUrl(base, {
        initialUrl: REPORT_URL,
        tabId: "browser:owner",
        ownerTaskId: "task-b",
        workspaceKey: "ws-1",
      });
      expect(otherOwner.activeTabId).toBe("browser:owner");

      const otherWorkspace = openOrActivateBrowserSidePaneByUrl(base, {
        initialUrl: REPORT_URL,
        tabId: "browser:workspace",
        ownerTaskId: "task-a",
        workspaceKey: "ws-2",
      });
      expect(otherWorkspace.activeTabId).toBe("browser:workspace");
    });

    it("tabId 缺席时现生成（share handover 的老调用形状不变）", () => {
      const state = openOrActivateBrowserSidePaneByUrl(null, {
        initialUrl: "https://example.com/share/abc",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.id.startsWith("browser:")).toBe(true);
      expect(state.tabs[0]).toMatchObject({
        type: "browser",
        initialUrl: "https://example.com/share/abc",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
    });

    it("findBrowserSidePaneTabByUrl 与 open 落到同一个 tab（调用方据它发导航请求）", () => {
      // useAppPanels 的直开路径：建 tab 时不带 ownerTaskId，归属由 stamping 盖当前 owner，
      // 复查时用同一个 owner —— 两处必须认出同一个 tab，否则第二次点击会重复开。
      const opened = stampSidePaneTabsOwnership(
        openOrActivateBrowserSidePaneByUrl(null, {
          initialUrl: REPORT_URL,
          tabId: "browser:stamped",
          workspaceKey: "ws-1",
        }),
        { ownerTaskId: "task-a", workspaceKey: "ws-1" },
      )!;

      const found = findBrowserSidePaneTabByUrl(opened, {
        initialUrl: REPORT_URL,
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      expect(found?.id).toBe("browser:stamped");

      const again = openOrActivateBrowserSidePaneByUrl(opened, {
        initialUrl: REPORT_URL,
        tabId: "browser:new",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      expect(again.tabs).toHaveLength(1);
      expect(again.activeTabId).toBe("browser:stamped");
    });

    it("没有匹配 URL 时返回 undefined", () => {
      const state = openBrowserSidePane(null, { tabId: "browser:a" });
      expect(
        findBrowserSidePaneTabByUrl(state, { initialUrl: REPORT_URL, ownerTaskId: "task-a" }),
      ).toBeUndefined();
      expect(findBrowserSidePaneTabByUrl(null, { initialUrl: REPORT_URL })).toBeUndefined();
    });
  });

  describe("openBrowserPermissionsSidePane", () => {
    it("同站点 + 同工作区 + 同对话复用既有标签并激活，不新建", () => {
      const opened = openBrowserPermissionsSidePane(null, {
        origin: "https://example.com",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      expect(opened.tabs).toHaveLength(1);
      const tab = opened.tabs[0]!;
      expect(tab.type).toBe("browser-permissions");
      const again = openBrowserPermissionsSidePane(
        { ...opened, activeTabId: "" },
        { origin: "https://example.com", ownerTaskId: "task-a", workspaceKey: "ws-1" },
      );
      expect(again.tabs).toHaveLength(1);
      expect(again.activeTabId).toBe(tab.id);
    });

    it("不同站点、不同工作区或不同对话各自开新标签", () => {
      const opened = openBrowserPermissionsSidePane(null, {
        origin: "https://example.com",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      const otherOrigin = openBrowserPermissionsSidePane(opened, {
        origin: "https://other.com",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      const otherWorkspace = openBrowserPermissionsSidePane(otherOrigin, {
        origin: "https://example.com",
        ownerTaskId: "task-a",
        workspaceKey: "ws-2",
      });
      const otherOwner = openBrowserPermissionsSidePane(otherWorkspace, {
        origin: "https://example.com",
        ownerTaskId: "task-b",
        workspaceKey: "ws-1",
      });
      expect(otherOwner.tabs).toHaveLength(4);
    });

    it("按 owner 作用域过滤：归属 task-a 的设置标签对 task-b 不可见", () => {
      const opened = openBrowserPermissionsSidePane(null, {
        origin: "https://example.com",
        ownerTaskId: "task-a",
        workspaceKey: "ws-1",
      });
      expect(
        resolveActiveTabForOwner(opened, { workspaceKey: "ws-1", ownerTaskId: "task-a" }),
      ).toBe(opened.tabs[0]!.id);
      expect(
        resolveActiveTabForOwner(opened, { workspaceKey: "ws-1", ownerTaskId: "task-b" }),
      ).toBeNull();
    });
  });
});
