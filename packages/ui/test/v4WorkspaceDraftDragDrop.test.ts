import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    WorkbenchSplitDivider: () => React.createElement("div", { "data-testid": "mock-divider" }),
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

describe("V4WorkspaceChatArea split entries", () => {
  beforeEach(resetWorkbenchState);
  afterEach(resetWorkbenchState);

  // 拆分入口已整体下线（docs/v4-split-pane-workbench.md）：pane 不再接收拖放分屏与拆分回调，
  // 既有布局仍只负责渲染、聚焦与关闭。
  it("does not hand split or drop callbacks to leaf panes", () => {
    renderToStaticMarkup(
      createElement(V4WorkspaceChatArea, {
        sessionId: null,
        workspacePath: "/workspace",
        isDesktop: true,
      }),
    );

    const primaryPane = leafPaneCapture.props[0];
    expect(primaryPane?.paneId).toBe(V4_PRIMARY_PANE_ID);
    expect("canDropSession" in primaryPane!).toBe(false);
    expect("onDropSession" in primaryPane!).toBe(false);
    expect("onSplit" in primaryPane!).toBe(false);
    expect("canSplit" in primaryPane!).toBe(false);
    expect(leafPaneIds(usePaneLayoutStore.getState().root)).toEqual([V4_PRIMARY_PANE_ID]);
  });
});
