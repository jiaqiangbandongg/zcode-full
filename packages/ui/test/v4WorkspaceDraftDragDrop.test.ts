import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  leafPaneIds,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { WorkbenchLeafPaneProps } from "@/v4/WorkbenchPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";

const leafPaneCapture = vi.hoisted(() => ({
  props: [] as WorkbenchLeafPaneProps[],
}));

vi.mock("@/v4/WorkbenchPane.js", async () => {
  const React = await import("react");
  return {
    WorkbenchLeafPane: (props: WorkbenchLeafPaneProps) => {
      leafPaneCapture.props.push(props);
      return React.createElement("div", {
        "data-pane-id": props.paneId,
      });
    },
  };
});

vi.mock("@/v4/WorkbenchSplitDivider.js", async () => {
  const React = await import("react");
  return {
    WorkbenchSplitDivider: () =>
      React.createElement("div", { "data-testid": "mock-divider" }),
  };
});

function resetWorkbenchState(): void {
  usePaneLayoutStore.setState({
    root: INITIAL_PANE_LAYOUT.root,
    panes: INITIAL_PANE_LAYOUT.panes,
    focusedPaneId: INITIAL_PANE_LAYOUT.focusedPaneId,
  });
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  leafPaneCapture.props = [];
}

describe("V4WorkspaceChatArea draft drag/drop", () => {
  beforeEach(resetWorkbenchState);
  afterEach(resetWorkbenchState);

  it("allows dropping a sidebar session beside a draft primary pane without creating a group", () => {
    renderToStaticMarkup(
      createElement(V4WorkspaceChatArea, {
        sessionId: null,
        workspacePath: "/workspace",
      }),
    );

    const primaryPane = leafPaneCapture.props[0];
    const payload = {
      kind: "zcode/session" as const,
      sessionId: "sess-b",
      workspacePath: "/workspace",
    };

    expect(primaryPane.canDropSession?.(payload)).toBe(true);
    primaryPane.onDropSession?.(V4_PRIMARY_PANE_ID, "right", payload);

    const paneState = usePaneLayoutStore.getState();
    expect(leafPaneIds(paneState.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
    expect(paneState.panes["pane-1"]).toEqual({
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "sess-b",
    });
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });

  it("keeps the drop preview layer above composer and input layers", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/ui/src/v4/WorkbenchPane.tsx"),
      "utf8",
    );

    expect(source).toContain("pointer-events-none absolute inset-0 z-50");
  });
});
