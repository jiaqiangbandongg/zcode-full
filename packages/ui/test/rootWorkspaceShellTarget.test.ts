import { describe, expect, it } from "vitest";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";

const remoteWorkspaceIdentity = "remote:ssh:124.223.19.106:22:ubuntu:/home/ubuntu/workspace";
const remoteWorkspaceTab = {
  workspacePath: "/home/ubuntu/workspace",
  workspaceIdentity: remoteWorkspaceIdentity,
  remoteSessionId: "remote-session-1",
};

describe("resolveRootWorkspaceShellTarget", () => {
  it("uses the active workspace tab verbatim", () => {
    const target = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: remoteWorkspaceTab,
      activeWorkspacePath: remoteWorkspaceTab.workspacePath,
      activeWorkspaceIdentity: remoteWorkspaceIdentity,
      workspaceTabs: [remoteWorkspaceTab],
    });

    expect(target).toEqual({
      workspaceShellPath: "/home/ubuntu/workspace",
      workspaceIdentity: remoteWorkspaceIdentity,
      workspaceRemoteSessionId: "remote-session-1",
    });
  });

  it("keeps the covered remote workspace tab's identity and remote session while settings is active", () => {
    const target = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: null,
      activeWorkspacePath: remoteWorkspaceTab.workspacePath,
      activeWorkspaceIdentity: remoteWorkspaceIdentity,
      workspaceTabs: [{ workspacePath: "D:\\zcode\\other-local" }, remoteWorkspaceTab],
    });

    // Settings 覆盖 workspace 时，外壳目标必须与被覆盖的 workspace tab 完全一致；
    // 丢掉 remoteSessionId 会让通知 hook 以 __base__ 键再建一条 sessions-index 订阅并顶掉侧栏订阅。
    expect(target).toEqual({
      workspaceShellPath: "/home/ubuntu/workspace",
      workspaceIdentity: remoteWorkspaceIdentity,
      workspaceRemoteSessionId: "remote-session-1",
    });
  });

  it("matches the covered tab by workspace identity, not by path alone", () => {
    const target = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: null,
      activeWorkspacePath: "/home/ubuntu/workspace",
      activeWorkspaceIdentity: remoteWorkspaceIdentity,
      workspaceTabs: [
        {
          workspacePath: "/home/ubuntu/workspace",
          workspaceIdentity: "remote:wsl:default:ubuntu:/home/ubuntu/workspace",
          remoteSessionId: "remote-session-wsl",
        },
        remoteWorkspaceTab,
      ],
    });

    expect(target.workspaceRemoteSessionId).toBe("remote-session-1");
  });

  it("stays without a remote session when the covered remote tab is not connected", () => {
    const target = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: null,
      activeWorkspacePath: remoteWorkspaceTab.workspacePath,
      activeWorkspaceIdentity: remoteWorkspaceIdentity,
      workspaceTabs: [
        {
          workspacePath: remoteWorkspaceTab.workspacePath,
          workspaceIdentity: remoteWorkspaceIdentity,
        },
      ],
    });

    expect(target).toEqual({
      workspaceShellPath: "/home/ubuntu/workspace",
      workspaceIdentity: remoteWorkspaceIdentity,
      workspaceRemoteSessionId: undefined,
    });
  });

  it("stays without a remote session when the covered workspace tab is already closed", () => {
    const target = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: null,
      activeWorkspacePath: remoteWorkspaceTab.workspacePath,
      activeWorkspaceIdentity: remoteWorkspaceIdentity,
      workspaceTabs: [],
    });

    expect(target).toEqual({
      workspaceShellPath: "/home/ubuntu/workspace",
      workspaceIdentity: remoteWorkspaceIdentity,
      workspaceRemoteSessionId: undefined,
    });
  });

  it("keeps a local workspace local while settings is active", () => {
    const target = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: null,
      activeWorkspacePath: "D:\\zcode\\workspace",
      activeWorkspaceIdentity: null,
      workspaceTabs: [{ workspacePath: "D:\\zcode\\workspace" }, remoteWorkspaceTab],
    });

    expect(target).toEqual({
      workspaceShellPath: "D:\\zcode\\workspace",
      workspaceIdentity: undefined,
      workspaceRemoteSessionId: undefined,
    });
  });
});
