import { describe, expect, it } from "vitest";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";

describe("Model Provider connectivity target", () => {
  it("uses the active local workspace", () => {
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: "/local/active",
        activeWorkspaceIdentity: undefined,
        activeWorkspaceTab: { workspacePath: "/local/active" },
        workspaceTabs: [{ workspacePath: "/local/active" }],
      }),
    ).toBe("/local/active");
  });

  it("uses a remote tab's remembered local workspace when available", () => {
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: "/remote/project",
        activeWorkspaceIdentity: "remote:ssh:host:/remote/project",
        activeWorkspaceTab: {
          workspacePath: "/remote/project",
          workspaceIdentity: "remote:ssh:host:/remote/project",
          localWorkspacePath: "/local/source",
        },
        workspaceTabs: [],
      }),
    ).toBe("/local/source");
  });

  it("returns empty when a remote tab has no local workspace", () => {
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: "/remote/project",
        activeWorkspaceIdentity: "remote:ssh:host:/remote/project",
        activeWorkspaceTab: {
          workspacePath: "/remote/project",
          workspaceIdentity: "remote:ssh:host:/remote/project",
        },
        workspaceTabs: [
          {
            workspacePath: "/remote/other",
            workspaceIdentity: "remote:ssh:other:/remote/other",
          },
        ],
      }),
    ).toBe("");
  });

  it("returns empty when a remote session tab has no identity or local workspace", () => {
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: "/remote/project",
        activeWorkspaceIdentity: undefined,
        activeWorkspaceTab: {
          workspacePath: "/remote/project",
          remoteSessionId: "remote-session",
        },
        workspaceTabs: [],
      }),
    ).toBe("");
  });

  it("returns empty when a remote target tab has no identity or local workspace", () => {
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: "/remote/project",
        activeWorkspaceIdentity: undefined,
        activeWorkspaceTab: {
          workspacePath: "/remote/project",
          remoteTarget: { kind: "ssh" },
        },
        workspaceTabs: [],
      }),
    ).toBe("");
  });

  it("treats a whitespace-only remote session id as local metadata", () => {
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: "/remote/project",
        activeWorkspaceIdentity: "remote:ssh:host:/remote/project",
        activeWorkspaceTab: {
          workspacePath: "/remote/project",
          workspaceIdentity: "remote:ssh:host:/remote/project",
        },
        workspaceTabs: [{ workspacePath: "/local/project", remoteSessionId: "   " }],
      }),
    ).toBe("/local/project");
  });
});
