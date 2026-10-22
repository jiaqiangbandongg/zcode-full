// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import type { ProjectSidebarProps, ProjectTask } from "@/project-sidebar/contract.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { useRemoteWorkspaceSessionStore } from "@zcode/ui/remote-workspace-session-store";
import { registerWebRemoteControlWorkspaceBridgeServices } from "#src/web-remote-control/index.js";

describe("registerWebRemoteControlWorkspaceBridgeServices", () => {
  beforeEach(() => {
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
  });

  it("opens files after the actual mobile bridge registration without session identity metadata", async () => {
    const registration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-files",
        kind: "remote",
        workspaceKey: "remote:task",
        workspacePath: "/task",
        workspaceIdentity: "remote:task",
        remoteSessionId: "mobile-files",
      },
      services: {} as IServiceAccessor,
    });
    expect(
      useRemoteWorkspaceSessionStore.getState().sessionsById["mobile-files"].workspaceIdentity,
    ).toBeUndefined();
    const onOpenFileManager = vi.fn();
    const { result, unmount } = renderHook(() =>
      useProjectFileTree(
        {
          workspacePath: "/task",
          workspaceIdentity: "remote:task",
          onOpenFileManager,
        } as unknown as ProjectSidebarProps,
        { hosts: [], entries: [] },
      ),
    );
    await act(async () => {
      await result.current.openTaskFiles({
        taskId: "files",
        hostId: "remote-host",
        workspacePath: "/task",
        workspaceIdentity: "remote:task",
      } as ProjectTask);
    });
    expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceRemoteSessionId: "mobile-files",
        workspaceIdentity: "remote:task",
      }),
    );
    unmount();
    registration.dispose();
  });
  it("registers and binds remote bridge services by remote session, identity, and path", () => {
    const services = { __testId: "remote" } as unknown as IServiceAccessor;

    const registration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-1",
        kind: "remote",
        workspaceKey: "remote:docker:container:/root",
        workspacePath: "/root",
        workspaceIdentity: "remote:docker:container:/root",
        remoteSessionId: "remote-session-1",
      },
      services,
    });

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(state.sessionsById["remote-session-1"]?.services).toBe(services);
    expect(state.sessionIdByWorkspaceIdentity["remote:docker:container:/root"]).toBe(
      "remote-session-1",
    );
    expect(state.sessionIdByWorkspacePath["/root"]).toBe("remote-session-1");

    registration.dispose();

    const disposedState = useRemoteWorkspaceSessionStore.getState();
    expect(disposedState.sessionsById["remote-session-1"]).toBeUndefined();
    expect(
      disposedState.sessionIdByWorkspaceIdentity["remote:docker:container:/root"],
    ).toBeUndefined();
    expect(disposedState.sessionIdByWorkspacePath["/root"]).toBeUndefined();
  });

  it("does not register local bridge services as remote sessions", () => {
    const services = { __testId: "local" } as unknown as IServiceAccessor;

    const registration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-1",
        kind: "local",
        workspaceKey: "/workspace/local",
        workspacePath: "/workspace/local",
      },
      services,
    });

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(state.sessionsById).toEqual({});
    expect(state.sessionIdByWorkspacePath).toEqual({});
    expect(state.sessionIdByWorkspaceIdentity).toEqual({});

    registration.dispose();

    expect(useRemoteWorkspaceSessionStore.getState().sessionsById).toEqual({});
  });

  it("does not remove a newer session when disposing a stale bridge registration", () => {
    const firstServices = { __testId: "first" } as unknown as IServiceAccessor;
    const secondServices = { __testId: "second" } as unknown as IServiceAccessor;

    const firstRegistration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-1",
        kind: "remote",
        workspaceKey: "remote:docker:container:/root",
        workspacePath: "/root",
        workspaceIdentity: "remote:docker:container:/root",
        remoteSessionId: "remote-session-1",
      },
      services: firstServices,
    });
    registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-2",
        kind: "remote",
        workspaceKey: "remote:docker:container:/root",
        workspacePath: "/root",
        workspaceIdentity: "remote:docker:container:/root",
        remoteSessionId: "remote-session-2",
      },
      services: secondServices,
    });

    firstRegistration.dispose();

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(state.sessionsById["remote-session-1"]).toBeUndefined();
    expect(state.sessionsById["remote-session-2"]?.services).toBe(secondServices);
    expect(state.sessionIdByWorkspaceIdentity["remote:docker:container:/root"]).toBe(
      "remote-session-2",
    );
    expect(state.sessionIdByWorkspacePath["/root"]).toBe("remote-session-2");
  });

  it("does not remove a newer bridge registration that reuses the same remote session", () => {
    const firstServices = { __testId: "first" } as unknown as IServiceAccessor;
    const secondServices = { __testId: "second" } as unknown as IServiceAccessor;

    const firstRegistration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-1",
        kind: "remote",
        workspaceKey: "remote:ssh:host:/root",
        workspacePath: "/root",
        workspaceIdentity: "remote:ssh:host:/root",
        remoteSessionId: "remote-session-1",
      },
      services: firstServices,
    });
    registerWebRemoteControlWorkspaceBridgeServices({
      bridge: {
        bridgeSessionId: "bridge-2",
        kind: "remote",
        workspaceKey: "remote:ssh:host:/root",
        workspacePath: "/root",
        workspaceIdentity: "remote:ssh:host:/root",
        remoteSessionId: "remote-session-1",
      },
      services: secondServices,
    });

    firstRegistration.dispose();

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(state.sessionsById["remote-session-1"]?.services).toBe(secondServices);
    expect(state.sessionIdByWorkspaceIdentity["remote:ssh:host:/root"]).toBe("remote-session-1");
    expect(state.sessionIdByWorkspacePath["/root"]).toBe("remote-session-1");
  });
});
