import { describe, expect, it } from "vitest";
import {
  claimPluginUiSidePaneAutoOpen,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "./taskSidePaneMemory.js";
import { buildPluginUiSurfaceKey } from "../plugin-ui/contract.js";

const target = {
  workspacePath: "/project",
  sessionId: "session",
  pluginId: "plugin",
  serverName: "server",
  resourceUri: "ui://view",
};
const callKey = (changes = {}, toolCallId = "call") =>
  buildPluginUiSurfaceKey({ ...target, ...changes }, { kind: "toolCall", toolCallId });

describe("MCP App automatic sidebar opening", () => {
  it("consumes a call across remounts without changing the saved close preference", () => {
    const workspace = "sidebar-remount";
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey())).toBe(true);
    saveTaskSidePaneCollapsedPreference(workspace, target.sessionId, true);
    saveTaskSidePaneMemoryState(workspace, { browserUrls: { tab: "about:blank" } });
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey())).toBe(false);
    expect(
      getSidePaneCollapsedPreference(readTaskSidePaneMemoryState(workspace), target.sessionId),
    ).toBe(true);
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey({}, "next-call"))).toBe(true);
  });
  it("isolates execution identity, session, source and actual tool calls", () => {
    const workspace = "sidebar-isolation";
    const keys = [
      callKey(),
      callKey({ sessionId: "other" }),
      callKey({ pluginId: "other" }),
      callKey({ serverName: "other" }),
      callKey({ resourceUri: "ui://other" }),
      callKey({ workspaceIdentity: "ssh:first:/project" }),
      callKey({ workspaceIdentity: "ssh:second:/project" }),
    ];
    for (const key of keys) expect(claimPluginUiSidePaneAutoOpen(workspace, key)).toBe(true);
    for (const key of keys) expect(claimPluginUiSidePaneAutoOpen(workspace, key)).toBe(false);
    expect(claimPluginUiSidePaneAutoOpen("other-workspace-cache", keys[0]!)).toBe(true);
  });
});
