import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes } from "@zcode/shared";
import { createWebRemoteControlSharedHostAttachments } from "../src/main/webRemoteControlSharedHostAttachments.js";

const { browserWindowMock } = vi.hoisted(() => ({
  browserWindowMock: {
    fromId: vi.fn(() => null),
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowMock,
  MessageChannelMain: vi.fn(),
}));

class MockUtilityProcess extends EventEmitter {
  kill = vi.fn();
  postMessage = vi.fn();
}

function createPortPair() {
  const port1 = { close: vi.fn(), start: vi.fn(), on: vi.fn(), off: vi.fn(), postMessage: vi.fn() };
  const port2 = { close: vi.fn(), start: vi.fn(), on: vi.fn(), off: vi.fn(), postMessage: vi.fn() };
  return { port1, port2 };
}

describe("createWebRemoteControlSharedHostAttachments", () => {
  it("attaches a local bridge to the existing desktop host process", async () => {
    const child = new MockUtilityProcess();
    const ports = createPortPair();
    browserWindowMock.fromId.mockReturnValueOnce({
      id: 7,
      webContents: { id: 99 },
    });
    const manager = createWebRemoteControlSharedHostAttachments({
      windowHostProcessMap: new Map([[99, child as never]]),
      createMessageChannel: () => ports as never,
      attachRemoteWorkspaceSessionHost: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const attachment = await manager.attachWorkspaceHost(7, {
      kind: "local",
      workspacePath: "/repo/demo",
    });

    expect(attachment.entryId).toBe("desktop-host:7");
    expect(attachment.attachmentId).toMatch(/^shared-host-attachment-/);
    expect(attachment.process).toBe(child);
    expect(attachment.port).toBe(ports.port1);
    expect(child.postMessage).toHaveBeenCalledWith(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: expect.any(String),
        attachmentId: attachment.attachmentId,
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [ports.port2],
    );

    manager.releaseAttachment(attachment.attachmentId);
    expect(ports.port1.close).toHaveBeenCalledTimes(1);
  });

  it("throws desktop-disconnected when the desktop host is missing", async () => {
    const manager = createWebRemoteControlSharedHostAttachments({
      windowHostProcessMap: new Map(),
      createMessageChannel: createPortPair as never,
      attachRemoteWorkspaceSessionHost: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      manager.attachWorkspaceHost(7, {
        kind: "local",
        workspacePath: "/repo/demo",
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_HOST_MISSING" });
  });

  it("rejects remote attach without workspaceIdentity", async () => {
    const attachRemoteWorkspaceSessionHost = vi.fn();
    const manager = createWebRemoteControlSharedHostAttachments({
      windowHostProcessMap: new Map(),
      createMessageChannel: createPortPair as never,
      attachRemoteWorkspaceSessionHost,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      manager.attachWorkspaceHost(7, {
        kind: "remote",
        workspacePath: "/repo/demo",
        remoteSessionId: "remote-session-1",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_WORKSPACE_IDENTITY_MISSING" });
    expect(attachRemoteWorkspaceSessionHost).not.toHaveBeenCalled();
  });

  it("WPL-012 reuses one remote Window Host without copying Plugin state into the mobile attachment", async () => {
    const workspacePluginSecret = "E2E_WPL_012_WORKSPACE_PLUGIN_SECRET";
    const child = Object.assign(new MockUtilityProcess(), {
      workspacePluginRuntime: {
        configStoreId: "remote-host-user-store",
        runtimeId: "remote-cli-runtime-1",
        secret: workspacePluginSecret,
      },
    });
    const ports = createPortPair();
    const attachRemoteWorkspaceSessionHost = vi.fn(() => ({
      process: child as never,
      port: ports.port1 as never,
      remoteKind: "ssh" as const,
    }));
    const manager = createWebRemoteControlSharedHostAttachments({
      windowHostProcessMap: new Map(),
      createMessageChannel: createPortPair as never,
      attachRemoteWorkspaceSessionHost,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const attachment = await manager.attachWorkspaceHost(7, {
      kind: "remote",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host:22:user:/workspace",
      remoteSessionId: "remote-session-1",
      initialTaskId: "task-1",
    });

    expect(attachRemoteWorkspaceSessionHost).toHaveBeenCalledTimes(1);
    expect(attachRemoteWorkspaceSessionHost).toHaveBeenCalledWith({
      windowId: 7,
      remoteSessionId: "remote-session-1",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host:22:user:/workspace",
      workspaceKey: "remote:ssh:host:22:user:/workspace",
      clientMode: "web-remote-replayable",
    });
    expect(attachment).toMatchObject({
      entryId: "remote-session-host:remote-session-1",
      process: child,
      port: ports.port1,
      remoteKind: "ssh",
    });
    expect(JSON.stringify(attachRemoteWorkspaceSessionHost.mock.calls)).not.toContain(
      workspacePluginSecret,
    );
    expect(child.workspacePluginRuntime).toEqual({
      configStoreId: "remote-host-user-store",
      runtimeId: "remote-cli-runtime-1",
      secret: workspacePluginSecret,
    });

    manager.releaseAttachment(attachment.attachmentId);
    expect(ports.port1.close).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.workspacePluginRuntime.runtimeId).toBe("remote-cli-runtime-1");
  });
});
