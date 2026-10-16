import { describe, expect, it } from "vitest";
import { getCloseActiveContextSidePaneTab } from "../src/lib/closeActiveContext.js";

describe("closeActiveContext", () => {
  it("returns the active side pane tab only when the visible pane is expanded", () => {
    const sidePaneState = {
      activeTabId: "browser:a",
      tabs: [
        { id: "browser:a", type: "browser" as const },
        { id: "git", type: "git" as const },
      ],
    };

    expect(
      getCloseActiveContextSidePaneTab({
        isWorkspaceVisible: true,
        isSidePaneCollapsed: false,
        sidePaneState,
      }),
    ).toEqual({ id: "browser:a", type: "browser" });

    expect(
      getCloseActiveContextSidePaneTab({
        isWorkspaceVisible: false,
        isSidePaneCollapsed: false,
        sidePaneState,
      }),
    ).toBeNull();
    expect(
      getCloseActiveContextSidePaneTab({
        isWorkspaceVisible: true,
        isSidePaneCollapsed: true,
        sidePaneState,
      }),
    ).toBeNull();
  });
});
