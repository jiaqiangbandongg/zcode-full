import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { createBotRemoteWorkspaceService } from "../src/bots/botRemoteWorkspaceBridge.js";

type ParentPortListener = (event: { data: unknown; ports?: unknown[] }) => void;

class ParentPortMock {
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<ParentPortListener>();

  postMessage(message: unknown): void {
    this.messages.push(message);
    const payload = message as { type?: string; requestId?: string };
    if (!payload.requestId) {
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest) {
      queueMicrotask(() => {
        this.emit({
          type: HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult,
          requestId: payload.requestId,
          ok: true,
          connected: true,
        });
      });
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceReconnectRequest) {
      queueMicrotask(() => {
        this.emit({
          type: HostMessageTypes.BotRemoteWorkspaceReconnectResult,
          requestId: payload.requestId,
          ok: true,
          sessionId: "session-1",
        });
      });
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest) {
      queueMicrotask(() => {
        this.emit(
          {
            type: HostMessageTypes.BotRemoteWorkspaceRuntimePort,
            requestId: payload.requestId,
            ok: true,
          },
          [new RuntimePortMock()],
        );
      });
    }
  }

  on(event: "message", listener: ParentPortListener): void {
    if (event === "message") {
      this.listeners.add(listener);
    }
  }

  off(event: "message", listener: ParentPortListener): void {
    if (event === "message") {
      this.listeners.delete(listener);
    }
  }

  emit(data: unknown, ports?: unknown[]): void {
    for (const listener of this.listeners) {
      listener({ data, ports });
    }
  }
}

class RuntimePortMock {
  postMessage(): void {}
  start(): void {}
  close(): void {}
  on(): void {}
  off(): void {}
}

function createBridge(port: ParentPortMock, autoResolutionEnabled = true) {
  const remoteZCodeSessionService = {
    updateProviderRegistry: vi.fn(async () => ({
      workspaceState: {},
      status: "applied",
      providerCount: 0,
    })),
  };
  const remoteZCodeAgentService = {
    syncAppRuntimePreferences: vi.fn(async () => undefined),
  };
  const remoteModelSelectionService = {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [],
    })),
  };
  const bridge = createBotRemoteWorkspaceService({
    parentPort: port,
    settingService: {
      get: vi.fn(async () => ({
        askUserQuestionAutoResolutionEnabled: autoResolutionEnabled,
        lastWorkspaceSession: [
          {
            kind: "remote" as const,
            workspacePath: "/workspace/real",
            workspaceIdentity: "remote:docker:demo:/workspace/link",
            target: {
              kind: "docker" as const,
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected" as const,
          },
        ],
      })),
    } as never,
    credentialService: {
      load: vi.fn(async () => null),
    } as never,
    createRuntimeServicesFromPort: vi.fn(() => ({
      zcodeAgentService: remoteZCodeAgentService,
      zcodeTaskService: {},
      zcodeSessionService: remoteZCodeSessionService,
      modelSelectionService: remoteModelSelectionService,
    })) as never,
  });
  return {
    bridge,
    remoteZCodeAgentService,
    remoteModelSelectionService,
    remoteZCodeSessionService,
  };
}

function runtimePortRequestCount(port: ParentPortMock): number {
  return port.messages.filter(
    (message) =>
      (message as { type?: string }).type ===
      HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
  ).length;
}

describe("createBotRemoteWorkspaceService", () => {
  it("queries main for UI-created remote sessions before reporting disconnected", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);

    await expect(
      bridge.isConnected({
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
      }),
    ).resolves.toBe(true);

    expect(port.messages).toContainEqual(
      expect.objectContaining({
        type: HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest,
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
        target: {
          kind: "docker",
          container: "demo",
        },
      }),
    );
  });

  it("exposes remote task and model-selection services through one shared runtime port", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await expect(bridge.getZCodeTaskService(target)).resolves.toBeTruthy();
    await expect(bridge.getModelSelectionService(target)).resolves.toBeTruthy();

    expect(runtimePortRequestCount(port)).toBe(1);
    expect(port.messages).toContainEqual(
      expect.objectContaining({
        type: HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
        target: {
          kind: "docker",
          container: "demo",
        },
      }),
    );
  });

  it("validates the remote registry without injecting Desktop provider facts", async () => {
    const port = new ParentPortMock();
    const { bridge, remoteModelSelectionService, remoteZCodeSessionService } = createBridge(port);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await bridge.getZCodeTaskService(target);
    await bridge.getModelSelectionService(target);

    expect(runtimePortRequestCount(port)).toBe(1);
    expect(remoteModelSelectionService.getView).toHaveBeenCalledTimes(1);
    expect(remoteZCodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
  });

  it("applies the app preference before exposing a new remote Bot runtime", async () => {
    const port = new ParentPortMock();
    const { bridge, remoteZCodeAgentService } = createBridge(port, false);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await bridge.getZCodeTaskService(target);

    // settings 未配置 modelIoFullRetentionEnabled 时按默认关闭（=== true → false）下发
    expect(remoteZCodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });
  });

  it("syncs only cached remote Bot runtimes without spawning another runtime", async () => {
    const port = new ParentPortMock();
    const { bridge, remoteZCodeAgentService } = createBridge(port);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await bridge.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
    });
    expect(runtimePortRequestCount(port)).toBe(0);

    await bridge.getZCodeTaskService(target);
    remoteZCodeAgentService.syncAppRuntimePreferences.mockClear();
    await bridge.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
    });

    expect(runtimePortRequestCount(port)).toBe(1);
    expect(remoteZCodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
    });
  });
});
