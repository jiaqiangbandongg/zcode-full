import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { V4_PRIMARY_PANE_ID } from "@/v4/paneLayoutStore.js";
import {
  resolvePaneActiveSelectionSideChatSessionId,
  WorkbenchLeafPane,
  type WorkbenchShellBinding,
} from "@/v4/WorkbenchPane.js";

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: { onDropTargetControllerChange?: unknown }) =>
      React.createElement("div", {
        "data-testid": "mock-session-pane",
        "data-draft-drop-target": Boolean(props.onDropTargetControllerChange),
      }),
  };
});

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-provider" }, children),
  };
});

function renderWorkbenchPane({
  focused,
  showFocusIndicator,
  sessionId = "sess-primary",
}: {
  focused: boolean;
  showFocusIndicator: boolean;
  sessionId?: string | null;
}): string {
  const shell = {
    workspacePath: "/repo",
    sessionId,
    onPrimaryDraftDropTargetControllerChange: vi.fn(),
  } as unknown as WorkbenchShellBinding;

  return renderToStaticMarkup(
    createElement(WorkbenchLeafPane, {
      paneId: V4_PRIMARY_PANE_ID,
      rect: { left: "0%", top: "0%", width: "100%", height: "100%" },
      focused,
      showFocusIndicator,
      canSplit: true,
      shellWorkspaceKey: "/repo",
      binding: null,
      shell,
      onFocusRequest: vi.fn(),
      onSplit: vi.fn(),
      onClosePane: vi.fn(),
      onConfirmRestoredSession: vi.fn(),
      onBindSession: vi.fn(),
    }),
  );
}

describe("WorkbenchLeafPane inactive visual state", () => {
  it("publishes the header drop target only while the primary pane is a draft", () => {
    const draft = renderWorkbenchPane({
      focused: true,
      showFocusIndicator: false,
      sessionId: null,
    });
    const session = renderWorkbenchPane({
      focused: true,
      showFocusIndicator: false,
      sessionId: "A",
    });
    expect(draft).toContain('data-draft-drop-target="true"');
    expect(session).toContain('data-draft-drop-target="false"');
  });

  it("dims only non-focused panes when the workbench has multiple panes", () => {
    const inactiveMarkup = renderWorkbenchPane({
      focused: false,
      showFocusIndicator: true,
    });
    const activeMarkup = renderWorkbenchPane({
      focused: true,
      showFocusIndicator: true,
    });
    const singlePaneMarkup = renderWorkbenchPane({
      focused: false,
      showFocusIndicator: false,
    });

    expect(inactiveMarkup).toContain('data-v4-pane-inactive-overlay="true"');
    expect(inactiveMarkup).toContain("pointer-events-none");
    expect(inactiveMarkup).toContain("z-30");
    expect(activeMarkup).not.toContain('data-v4-pane-inactive-overlay="true"');
    expect(singlePaneMarkup).not.toContain('data-v4-pane-inactive-overlay="true"');
  });
});

describe("resolvePaneActiveSelectionSideChatSessionId", () => {
  it("routes the active auxiliary child to a split pane that owns the shell active task", () => {
    expect(
      resolvePaneActiveSelectionSideChatSessionId("sess-split", "sess-split", "sess-side"),
    ).toBe("sess-side");
  });

  it("does not leak the active auxiliary child to another pane", () => {
    expect(
      resolvePaneActiveSelectionSideChatSessionId("sess-primary", "sess-split", "sess-side"),
    ).toBeNull();
  });
});
