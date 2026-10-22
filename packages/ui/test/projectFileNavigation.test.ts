import { expect, it, vi } from "vitest";
import { resolveProjectFileTarget } from "@/project-sidebar/project-file-navigation.js";
const project = {
  id: "p",
  hostId: "local",
  name: "Project",
  roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
};
it("opens a local root without preparing a task or connecting a host", async () => {
  const connect = vi.fn();
  const result = await resolveProjectFileTarget({
    project,
    rootPath: "/repo",
    isRemote: false,
    props: { onConnectRemote: connect },
    findSession: () => undefined,
  } as never);
  expect(result).toEqual({ workspacePath: "/repo", workspaceName: "Project" });
  expect(connect).not.toHaveBeenCalled();
});
it("uses a matching remote attachment and never borrows the same local path", async () => {
  const connect = vi.fn();
  const findSession = vi.fn(() => ({ sessionId: "remote-session" }));
  const result = await resolveProjectFileTarget({
    project: { ...project, hostId: "remote:server:s" },
    rootPath: "/repo",
    isRemote: true,
    props: { onConnectRemote: connect },
    findSession,
  } as never);
  expect(result.workspaceIdentity).toContain("s");
  expect(result.workspaceRemoteSessionId).toBe("remote-session");
  expect(findSession).toHaveBeenCalledWith(result.workspaceIdentity);
  expect(connect).not.toHaveBeenCalled();
});
it("uses only shared-host switching on mobile", async () => {
  const switchWorkspace = vi.fn(async () => {});
  const connect = vi.fn();
  const result = await resolveProjectFileTarget({
    project: { ...project, hostId: "remote:server:s" },
    rootPath: "/repo",
    isRemote: true,
    props: {
      workspacePath: "/current",
      webRemoteControlWorkspaceSwitcher: { switchWorkspace },
      onConnectRemote: connect,
    },
    findSession: () => undefined,
  } as never);
  expect(result).toBeNull();
  expect(switchWorkspace).toHaveBeenCalledWith(expect.stringContaining("s"), {
    mobileNavigationIntent: "chat",
    openFileManager: true,
  });
  expect(connect).not.toHaveBeenCalled();
});
it("rejects a foreign root before any connection side effect", async () => {
  const connect = vi.fn();
  await expect(
    resolveProjectFileTarget({
      project,
      rootPath: "/other",
      isRemote: false,
      props: { onConnectRemote: connect },
      findSession: () => undefined,
    } as never),
  ).rejects.toThrow("project.root-not-found");
  expect(connect).not.toHaveBeenCalled();
});

it("binds an unopened remote root through its existing host connector", async () => {
  let bound = false;
  const bind = vi.fn(async () => {
    bound = true;
  });
  const connectHost = vi.fn(async () => ({
    id: "remote:server:s",
    target: { kind: "server", url: "https://source.test" },
  }));
  const connect = vi.fn(async () => "attached");
  const result = await resolveProjectFileTarget({
    project: { ...project, hostId: "remote:server:s" },
    rootPath: "/repo",
    isRemote: true,
    props: {
      onConnectRemote: connect,
      onSelectRemoteProject: bind,
      onCancelRemoteProject: vi.fn(),
    },
    remoteService: { connectHost },
    findSession: () => (bound ? { sessionId: "attached" } : undefined),
  } as never);
  expect(connectHost).toHaveBeenCalledWith("remote:server:s");
  expect(bind).toHaveBeenCalledWith("attached", "/repo", undefined, result.workspaceIdentity);
  expect(result.workspaceRemoteSessionId).toBe("attached");
});
