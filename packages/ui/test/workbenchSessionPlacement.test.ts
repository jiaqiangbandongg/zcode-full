import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  countPanes,
  openSessionInNewPane,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import {
  buildWorkbenchSessionKey,
  createWorkbenchGroupFromSessions,
  useWorkbenchGroupStore,
  type WorkbenchGroupSnapshot,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  selectWorkbenchSession,
} from "@/v4/workbenchSessionPlacement.js";

const SCOPE = { workspacePath: "/workspace" };

function binding(sessionId: string): WorkbenchSessionBinding {
  return { workspaceScope: SCOPE, sessionId };
}

function target(sessionId: string) {
  return { ...SCOPE, sessionId };
}

function groupSnapshot(): WorkbenchGroupSnapshot {
  const group = createWorkbenchGroupFromSessions(
    binding("session-a"),
    binding("session-b"),
    "right",
    { id: "group-1", updatedAt: 1 },
  );
  return {
    activeGroupId: group.id,
    groups: { [group.id]: group },
    sessionIndex: {
      [buildWorkbenchSessionKey(SCOPE, "session-a")]: group.id,
      [buildWorkbenchSessionKey(SCOPE, "session-b")]: group.id,
    },
  };
}

function resetStores(): void {
  usePaneLayoutStore.setState({
    root: INITIAL_PANE_LAYOUT.root,
    panes: INITIAL_PANE_LAYOUT.panes,
    focusedPaneId: INITIAL_PANE_LAYOUT.focusedPaneId,
  });
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
}

describe("workbench session placement", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("uses one focused binding guard for context menu and drag", () => {
    useWorkbenchGroupStore.setState(groupSnapshot());

    expect(
      canPlaceWorkbenchSessionInSplit(binding("session-a"), target("session-b"), {
        mode: "context-menu",
        side: "right",
      }),
    ).toBe(false);
    expect(
      canPlaceWorkbenchSessionInSplit(binding("session-a"), target("session-b"), {
        mode: "drag",
        side: "right",
      }),
    ).toBe(false);
  });

  it("focuses an existing group for context menu while drag rejects duplicate placement", () => {
    useWorkbenchGroupStore.setState(groupSnapshot());

    expect(
      canPlaceWorkbenchSessionInSplit(binding("session-b"), target("session-a"), {
        mode: "context-menu",
        side: "right",
      }),
    ).toBe(true);
    expect(
      canPlaceWorkbenchSessionInSplit(binding("session-b"), target("session-a"), {
        mode: "drag",
        side: "right",
      }),
    ).toBe(false);

    placeWorkbenchSessionInSplit(binding("session-b"), target("session-a"), {
      mode: "context-menu",
      side: "right",
    });
    expect(useWorkbenchGroupStore.getState().getActiveContext()).toEqual(binding("session-a"));
  });

  it("uses the same draft split owner for context menu and drag", () => {
    expect(
      canPlaceWorkbenchSessionInSplit(null, target("session-b"), {
        mode: "context-menu",
        side: "right",
      }),
    ).toBe(true);
    expect(
      canPlaceWorkbenchSessionInSplit(null, target("session-b"), {
        mode: "drag",
        side: "right",
      }),
    ).toBe(true);

    const shouldSelectTarget = placeWorkbenchSessionInSplit(null, target("session-b"), {
      mode: "context-menu",
      side: "right",
    });
    expect(shouldSelectTarget).toBe(false);
    expect(usePaneLayoutStore.getState().panes["pane-1"]).toEqual({
      workspaceScope: SCOPE,
      sessionId: "session-b",
    });
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });

  it("creates a real group when a normal primary session opens a split", () => {
    expect(
      placeWorkbenchSessionInSplit(binding("session-a"), target("session-b"), {
        mode: "context-menu",
        side: "right",
      }),
    ).toBe(true);

    const groups = useWorkbenchGroupStore.getState();
    expect(groups.activeGroupId).toBeTruthy();
    expect(groups.sessionIndex[buildWorkbenchSessionKey(SCOPE, "session-a")]).toBe(
      groups.activeGroupId,
    );
    expect(groups.sessionIndex[buildWorkbenchSessionKey(SCOPE, "session-b")]).toBe(
      groups.activeGroupId,
    );
  });

  it("rebinds [draft | B] focused secondary to C before shell navigation", () => {
    const layout = openSessionInNewPane(INITIAL_PANE_LAYOUT, SCOPE, "session-b");
    usePaneLayoutStore.setState(layout);

    selectWorkbenchSession(null, target("session-c"));
    const replaced = usePaneLayoutStore.getState();
    expect(countPanes(replaced)).toBe(2);
    expect(replaced.root).toBe(layout.root);
    expect(replaced.focusedPaneId).toBe("pane-1");
    expect(replaced.panes["pane-1"]).toEqual({
      workspaceScope: SCOPE,
      sessionId: "session-c",
    });
    expect(replaced.panes[V4_PRIMARY_PANE_ID]).toBeUndefined();
  });

  it("focuses an existing temporary pane instead of duplicating its session", () => {
    let layout = openSessionInNewPane(INITIAL_PANE_LAYOUT, SCOPE, "session-b");
    layout = openSessionInNewPane(layout, SCOPE, "session-c");
    usePaneLayoutStore.setState(layout);

    selectWorkbenchSession(binding("session-c"), target("session-b"));
    expect(usePaneLayoutStore.getState().focusedPaneId).toBe("pane-1");
  });
});
