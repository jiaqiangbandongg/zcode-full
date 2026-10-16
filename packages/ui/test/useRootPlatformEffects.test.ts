import { describe, expect, it } from "vitest";
import {
  buildConnectedRemoteWorkspaceSessionTargets,
  buildWebRemoteControlWorkspaceTargets,
  shouldPublishCompleteWorkspaceSnapshot,
} from "@/root/rootPlatformWorkspaceSync.js";
import type { WindowTabState } from "@/store/tabStore.js";

function createWorkspaceTab(
  overrides: Partial<Extract<WindowTabState, { kind: "workspace" }>> = {},
): Extract<WindowTabState, { kind: "workspace" }> {
  return {
    id: overrides.id ?? "tab-1",
    kind: "workspace",
    label: overrides.label ?? "demo",
    workspacePath: overrides.workspacePath ?? "/workspace/demo",
    workspaceIdentity: overrides.workspaceIdentity,
    workspacePurpose: overrides.workspacePurpose,
    remoteSessionId: overrides.remoteSessionId,
    remoteTarget: overrides.remoteTarget,
  };
}

describe("buildWebRemoteControlWorkspaceTargets", () => {
  it("preserves conversation purpose for mobile task navigation", () => {
    expect(
      buildWebRemoteControlWorkspaceTargets({
        tabs: [
          createWorkspaceTab({
            id: "conversation",
            label: "default",
            workspacePath: "/Users/demo/.zcode/workspace/default",
            workspacePurpose: "conversation",
          }),
        ],
      }),
    ).toEqual([
      {
        workspacePath: "/Users/demo/.zcode/workspace/default",
        label: "default",
        kind: "local",
        workspacePurpose: "conversation",
      },
    ]);
  });

  it("syncs disconnected errors and reconnecting state by workspace identity", () => {
    expect(
      buildWebRemoteControlWorkspaceTargets({
        tabs: [
          createWorkspaceTab({
            id: "remote-1",
            label: "Remote App",
            workspacePath: "/workspace/remote",
            workspaceIdentity: "remote:ssh:dev:/workspace/remote",
            remoteTarget: { kind: "ssh", host: "dev", username: "root" },
          }),
          createWorkspaceTab({
            id: "remote-2",
            label: "Reconnecting App",
            workspacePath: "/workspace/reconnecting",
            workspaceIdentity: "remote:ssh:dev:/workspace/reconnecting",
            remoteTarget: { kind: "ssh", host: "dev", username: "root" },
          }),
          createWorkspaceTab({
            id: "local-1",
            label: "Local App",
            workspacePath: "/workspace/local",
          }),
        ],
        reconnectingRemoteWorkspaceKeys: [
          "remote:ssh:dev:/workspace/reconnecting",
        ],
        remoteWorkspaceErrorByWorkspaceKey: {
          "remote:ssh:dev:/workspace/remote": "ssh closed",
        },
      }),
    ).toEqual([
      {
        workspacePath: "/workspace/remote",
        label: "Remote App",
        kind: "remote",
        connectionState: "disconnected",
        workspaceIdentity: "remote:ssh:dev:/workspace/remote",
        lastConnectionError: "ssh closed",
      },
      {
        workspacePath: "/workspace/reconnecting",
        label: "Reconnecting App",
        kind: "remote",
        connectionState: "reconnecting",
        workspaceIdentity: "remote:ssh:dev:/workspace/reconnecting",
      },
      {
        workspacePath: "/workspace/local",
        label: "Local App",
        kind: "local",
      },
    ]);
  });
});

describe("buildConnectedRemoteWorkspaceSessionTargets", () => {
  it("returns only connected remote tabs with workspace identity", () => {
    expect(
      buildConnectedRemoteWorkspaceSessionTargets({
        tabs: [
          createWorkspaceTab({
            id: "remote-connected",
            label: "Remote Connected",
            workspacePath: "/root",
            workspaceIdentity: "remote:docker:zcode-ssh-container:/root",
            remoteSessionId: "remote-session-1",
            remoteTarget: { kind: "docker", container: "zcode-ssh-container" },
          }),
          createWorkspaceTab({
            id: "remote-placeholder",
            label: "Remote Placeholder",
            workspacePath: "/workspace/disconnected",
            workspaceIdentity: "remote:ssh:dev:/workspace/disconnected",
            remoteTarget: { kind: "ssh", host: "dev", username: "root" },
          }),
          createWorkspaceTab({
            id: "local",
            label: "Local",
            workspacePath: "/workspace/local",
          }),
        ],
      }),
    ).toEqual([
      {
        workspacePath: "/root",
        label: "Remote Connected",
        kind: "remote",
        connectionState: "connected",
        workspaceIdentity: "remote:docker:zcode-ssh-container:/root",
        remoteSessionId: "remote-session-1",
      },
    ]);
  });
});

describe("shouldPublishCompleteWorkspaceSnapshot", () => {
  it("does not publish the renderer-only active-first projection", () => {
    expect(shouldPublishCompleteWorkspaceSnapshot(false)).toBe(false);
    expect(shouldPublishCompleteWorkspaceSnapshot(true)).toBe(true);
  });
});
