import { describe, expect, it } from "vitest";
import { resolveAppWorkspaceRpcTarget } from "@/app-shell/workspaceRpcTarget.js";

describe("resolveAppWorkspaceRpcTarget", () => {
  it("falls back to the explicit remote workspace identity when active tab has no workspace metadata", () => {
    const workspaceIdentity =
      "remote:ssh:124.223.19.106:22:ubuntu:/home/ubuntu/workspace";

    expect(
      resolveAppWorkspaceRpcTarget({
        activeTarget: {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        },
        explicitWorkspaceIdentity: workspaceIdentity,
        explicitRemoteSessionId: undefined,
      }),
    ).toEqual({
      workspaceIdentity,
      remoteSessionId: undefined,
      remoteTarget: undefined,
    });
  });

  it("does not add remote identity or session for a local workspace", () => {
    expect(
      resolveAppWorkspaceRpcTarget({
        activeTarget: {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        },
        explicitWorkspaceIdentity: undefined,
        explicitRemoteSessionId: undefined,
      }),
    ).toEqual({
      workspaceIdentity: undefined,
      remoteSessionId: undefined,
      remoteTarget: undefined,
    });
  });
});
