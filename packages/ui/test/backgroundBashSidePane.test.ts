import { describe, expect, it } from "vitest";
import { getVisibleSidePaneTabs, openBackgroundBashSidePane } from "@/lib/workspaceSidePane.js";

describe("background Bash tabs", () => {
  const target = {
    workspacePath: "/project",
    workspaceIdentity: "ssh:a",
    remoteSessionId: "remote-a",
    rootSessionId: "root",
    sessionId: "child",
    workId: "work",
    title: "build",
  };
  it("reuses the same task and isolates identical paths/ids in different scopes", () => {
    const first = openBackgroundBashSidePane(null, target);
    expect(openBackgroundBashSidePane(first, target).tabs).toHaveLength(1);
    const other = openBackgroundBashSidePane(first, { ...target, remoteSessionId: "remote-b" });
    expect(other.tabs).toHaveLength(2);
    const foreign = openBackgroundBashSidePane(other, { ...target, workspaceIdentity: "ssh:b" });
    expect(foreign.tabs).toHaveLength(3);
    expect(getVisibleSidePaneTabs(first, "root")).toHaveLength(1);
    expect(getVisibleSidePaneTabs(first, "other")).toHaveLength(0);
    expect(first.tabs[0]).toMatchObject({
      type: "bash-output",
      workspaceKey: "ssh:a",
      sessionId: "child",
      rootSessionId: "root",
    });
  });
});
