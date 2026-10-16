import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import {
  closeVisibleSidePaneTabs,
  getVisibleSidePaneTabs,
  openSubagentSessionSidePane,
  selectSidePaneTabsForParent,
} from "@/lib/workspaceSidePane.js";
import { openSubagentSessionFromSummary } from "@/v4/ConversationAgentToolCallRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const paneState = vi.hoisted(() => ({ props: null as unknown }));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      paneState.props = props;
      return React.createElement("div", { "data-testid": "mock-session-pane" });
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

describe("subagent side pane tabs", () => {
  afterEach(() => {
    paneState.props = null;
  });

  it("uses a stable test id for the child side-pane summary action", () => {
    expect(testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, "child-session")).toBe(
      "v4-subagent-open-side-pane-child-session",
    );
  });

  it("opens foreground, background, mobile and nested child sessions through the same callback", () => {
    const requests: unknown[] = [];
    const context = {
      sessionId: "parent-session",
      rootSessionId: "root-session",
      workspacePath: "/workspace",
      onOpenSubagentSession: (request: unknown) => requests.push(request),
    } as unknown as ConversationRowRenderContext;

    expect(
      openSubagentSessionFromSummary({
        childSessionId: "child-session",
        context,
        subagentType: "Explore",
        title: "Explore project structure",
      }),
    ).toBe(true);
    expect(requests).toEqual([
      {
        rootSessionId: "root-session",
        parentSessionId: "parent-session",
        childSessionId: "child-session",
        subagentType: "Explore",
        title: "Explore project structure",
      },
    ]);

    for (const allowedContext of [
      { ...context, compactForRemoteControl: true },
      { ...context, inSubagentDrilldown: true, sessionId: "nested-parent" },
    ]) {
      expect(
        openSubagentSessionFromSummary({
          backgrounded: true,
          childSessionId: "child-session",
          context: allowedContext,
          subagentType: "Explore",
          title: "Explore project structure",
        }),
      ).toBe(true);
    }
    for (const blockedContext of [
      { ...context, sessionId: null },
      { ...context, onOpenSubagentSession: undefined },
    ]) {
    expect(
      openSubagentSessionFromSummary({
        childSessionId: "child-session",
        context: blockedContext,
        subagentType: "Explore",
        title: "Explore project structure",
      }),
    ).toBe(false);
    }
    expect(
      openSubagentSessionFromSummary({
        childSessionId: undefined,
        context,
        subagentType: "Explore",
        title: "Explore project structure",
      }),
    ).toBe(false);
    expect(requests).toHaveLength(3);
  });

  it("opens more than four child tabs and reuses a child identity", () => {
    let state = null;
    for (let index = 1; index <= 6; index += 1) {
      state = openSubagentSessionSidePane(state, {
        workspaceKey: "/workspace",
        workspacePath: "/workspace",
        parentSessionId: "parent-a",
        childSessionId: `child-${index}`,
        subagentType: index % 2 === 0 ? "Explore" : "general-purpose",
        title: `Task title ${index}`,
      });
    }
    const reopened = openSubagentSessionSidePane(state, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-2",
      subagentType: "Explore",
      title: "Updated task title",
    });

    expect(reopened.tabs).toHaveLength(6);
    expect(reopened.activeTabId).toContain("child-2");
    expect(reopened.tabs.find((tab) => tab.id === reopened.activeTabId)).toMatchObject({
      title: "Updated task title",
    });
    const reopenedWithoutTitle = openSubagentSessionSidePane(reopened, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-2",
      subagentType: "Explore",
      title: "   ",
    });
    expect(
      reopenedWithoutTitle.tabs.find((tab) => tab.id === reopenedWithoutTitle.activeTabId),
    ).toMatchObject({ title: "Updated task title" });
  });

  it("shows shared tabs plus the active parent group and preserves hidden groups", () => {
    const shared = {
      activeTabId: "git",
      tabs: [{ id: "git", type: "git" as const }],
    };
    const withA = openSubagentSessionSidePane(shared, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      childSessionId: "child-a",
      subagentType: "Explore",
      title: "Explore parent A",
    });
    const withB = openSubagentSessionSidePane(withA, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-b",
      childSessionId: "child-b",
      subagentType: "general-purpose",
      title: "Explore parent B",
    });

    expect(getVisibleSidePaneTabs(withB, "parent-a").map((tab) => tab.id)).toEqual([
      "git",
      expect.stringContaining("child-a"),
    ]);
    const selectedA = selectSidePaneTabsForParent(withB, "parent-a");
    expect(selectedA?.activeTabId).toContain("child-a");

    const closedVisibleA = closeVisibleSidePaneTabs(selectedA, "parent-a");
    expect(closedVisibleA?.tabs).toHaveLength(1);
    expect(closedVisibleA?.tabs[0]).toMatchObject({
      type: "subagent-session",
      parentSessionId: "parent-b",
    });
    expect(closedVisibleA?.activeTabId).toBe("");
  });

  it("isolates same-path remote workspaces by workspace identity", () => {
    const first = openSubagentSessionSidePane(null, {
      workspaceKey: "remote:ssh:host-a:/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-a:/workspace",
      parentSessionId: "parent",
      childSessionId: "child",
      subagentType: "Explore",
      title: "Explore host A",
    });
    const second = openSubagentSessionSidePane(first, {
      workspaceKey: "remote:ssh:host-b:/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-b:/workspace",
      parentSessionId: "parent",
      childSessionId: "child",
      subagentType: "Explore",
      title: "Explore host B",
    });

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs[0]?.id).not.toBe(second.tabs[1]?.id);
    expect(second.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceKey: "remote:ssh:host-a:/workspace",
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:host-a:/workspace",
        }),
        expect.objectContaining({
          workspaceKey: "remote:ssh:host-b:/workspace",
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:host-b:/workspace",
        }),
      ]),
    );
  });

  it("keeps the child conversation read-only while enabling its workspace file rewind", () => {
    const state = openSubagentSessionSidePane(null, {
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "parent-session",
      rootSessionId: "root-session",
      childSessionId: "child-session",
      subagentType: "Explore",
      title: "Explore child",
    });
    const tab = state.tabs.find((candidate) => candidate.type === "subagent-session");

    renderToStaticMarkup(
      createElement(SubagentSessionSidePane, {
        tab: tab!,
        focused: true,
        onOpenSubagentSession: vi.fn(),
      }),
    );

    expect(paneState.props).toMatchObject({
      allowWorkspaceFileRewind: true,
      compactForRemoteControl: false,
      readOnly: true,
      sessionId: "child-session",
    });

    renderToStaticMarkup(
      createElement(SubagentSessionSidePane, {
        tab: tab!,
        focused: true,
        compactForRemoteControl: true,
        onOpenSubagentSession: vi.fn(),
      }),
    );

    expect(paneState.props).toMatchObject({
      compactForRemoteControl: true,
      readOnly: true,
      sessionId: "child-session",
    });
  });
});
