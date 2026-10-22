import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";

describe("RemoteWorkspaceController", () => {
  it("dispatches all explicit intents to the corresponding owner", async () => {
    const connectDevice = vi.fn(async () => undefined);
    const disconnectDevice = vi.fn(async () => undefined);
    const openConversation = vi.fn(async () => undefined);
    const openProject = vi.fn(async () => undefined);
    const reconnectWorkspace = vi.fn(async () => undefined);
    const closeWorkspace = vi.fn(async () => undefined);
    const controller = createRemoteWorkspaceController({
      connectDevice,
      disconnectDevice,
      openConversation,
      openProject,
      reconnectWorkspace,
      closeWorkspace,
    });

    await controller.dispatch({
      type: "connect-device",
      profileId: "profile-1",
      effect: "select-project",
    });
    await controller.dispatch({
      type: "disconnect-device",
      sourceServerId: "server-1",
    });
    await expect(
      controller.dispatch({
        type: "open-conversation",
        sourceServerId: "server-1",
        remoteSessionId: "session-1",
      }),
    ).rejects.toThrow("project.remote-project-required");
    await controller.dispatch({
      type: "open-project",
      sourceServerId: "server-1",
      path: "/workspace/project",
      profileId: "profile-1",
    });
    await controller.dispatch({
      type: "reconnect-workspace",
      workspaceKey: "remote:server:server-1:/workspace/project",
    });
    await controller.dispatch({
      type: "close-workspace",
      workspaceKey: "remote:server:server-1:/workspace/project",
      origin: "user-close",
    });

    expect(connectDevice).toHaveBeenCalledWith("profile-1", "select-project");
    expect(disconnectDevice).toHaveBeenCalledWith("server-1");
    expect(openConversation).not.toHaveBeenCalled();
    expect(openProject).toHaveBeenCalledWith({
      type: "open-project",
      sourceServerId: "server-1",
      path: "/workspace/project",
      profileId: "profile-1",
    });
    expect(reconnectWorkspace).toHaveBeenCalledWith("remote:server:server-1:/workspace/project");
    expect(closeWorkspace).toHaveBeenCalledWith("remote:server:server-1:/workspace/project");
  });

  it("rejects non-user close origins", async () => {
    const controller = createRemoteWorkspaceController({
      connectDevice: vi.fn(async () => undefined),
      disconnectDevice: vi.fn(async () => undefined),
      openConversation: vi.fn(),
      openProject: vi.fn(async () => undefined),
      reconnectWorkspace: vi.fn(async () => undefined),
      closeWorkspace: vi.fn(async () => undefined),
    });

    await expect(
      controller.dispatch({
        type: "close-workspace",
        workspaceKey: "remote:server:server-1:/workspace/project",
        origin: "restore" as never,
      }),
    ).rejects.toThrow("user-close");
  });
});
