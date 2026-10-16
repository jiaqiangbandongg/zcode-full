import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";

const workspaceSettingsLayerMock = vi.fn(() => null);

vi.mock("../src/App.js", () => ({
  App: () => null,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/root/WorkspaceSettingsLayer.js", () => ({
  WorkspaceSettingsLayer: (props: Record<string, unknown>) => {
    workspaceSettingsLayerMock(props);
    return createElement("div", null, "settings");
  },
}));

function makeServices(id: string): IServiceAccessor {
  return { __testId: id } as unknown as IServiceAccessor;
}

describe("RootWorkspaceContent settings layer services", () => {
  beforeEach(() => {
    workspaceSettingsLayerMock.mockClear();
  });

  it("passes workspace-scoped services into the settings overlay", async () => {
    const { RootWorkspaceContent } = await import("../src/root/RootWorkspaceContent.js");
    const workspaceScopedServices = makeServices("remote-workspace");

    renderToStaticMarkup(
      createElement(RootWorkspaceContent, {
        workspaceScopedServices,
        workspaceShellPath: "/workspace/remote",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        workspaceRemoteSessionId: "remote-session-1",
        activeWorkspacePath: "/workspace/remote",
        isSettingsTabActive: true,
        handleConnectRemote: vi.fn(),
        handleSelectRemoteProject: vi.fn(),
        handleCancelRemoteProject: vi.fn(),
        handleReconnectRemoteWorkspace: vi.fn(),
        handleCreateTask: vi.fn(),
        handleOpenWorkspace: vi.fn(),
        remoteWorkspaceSessions: [],
        allowRemoteWorkspace: true,
        handleBackFromSettings: vi.fn(),
        user: null,
        reconnectingRemoteWorkspaceKeys: [],
        remoteWorkspaceErrorByWorkspaceKey: {},
        reconnectingRemoteWorkspaceLogsByWorkspaceKey: {},
        allowOpenWorkspace: true,
      }),
    );

    expect(workspaceSettingsLayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceScopedServices }),
    );
  });
});
