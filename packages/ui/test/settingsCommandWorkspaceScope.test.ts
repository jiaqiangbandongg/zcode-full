import { describe, expect, it } from "vitest";
import {
  resolveCommandScopeRecovery,
  resolveCommandStorageTarget,
  shouldRefreshCurrentCommandList,
} from "../src/settings/commandWorkspaceScope.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

describe("Command settings concrete Workspace scope", () => {
  const localTab = {
    id: "local",
    kind: "workspace",
    label: "repo",
    workspacePath: "/repo",
  } as WorkspaceTabState;
  const remoteTabA = {
    id: "remote-a",
    kind: "workspace",
    label: "default",
    workspaceIdentity: "ssh://host-a/root",
    workspacePath: "/root",
    remoteSessionId: "session-a",
  } as WorkspaceTabState;
  const remoteTabB = {
    id: "remote-b",
    kind: "workspace",
    label: "default",
    workspaceIdentity: "ssh://host-b/root",
    workspacePath: "/root",
    remoteSessionId: "session-b",
  } as WorkspaceTabState;

  it("keeps same-path remote Workspaces isolated by identity", () => {
    const tabs = [localTab, remoteTabA, remoteTabB];
    expect(resolveCommandStorageTarget("ssh://host-b/root", tabs)).toEqual({
      storageLevel: "project",
      workspace: remoteTabB,
    });
  });

  it("falls back only for create and closes an edit whose owner disappeared", () => {
    expect(
      resolveCommandScopeRecovery({
        editing: false,
        scopeKey: "ssh://closed/root",
        workspaceTabs: [remoteTabA],
      }),
    ).toBe("fallback-user");
    expect(
      resolveCommandScopeRecovery({
        editing: true,
        scopeKey: "ssh://closed/root",
        workspaceTabs: [remoteTabA],
      }),
    ).toBe("close-editor");
  });

  it("refreshes the parent projection only for User or the current Workspace", () => {
    expect(shouldRefreshCurrentCommandList("user", "workspace-a")).toBe(true);
    expect(shouldRefreshCurrentCommandList("workspace-a", "workspace-a")).toBe(true);
    expect(shouldRefreshCurrentCommandList("workspace-b", "workspace-a")).toBe(false);
  });
});
