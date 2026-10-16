import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { useEnsureWorkspaceMcpLoaded } from "@/hooks/useEnsureWorkspaceMcpLoaded.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceTerminalTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { setMcpStoreDirectoryService, setMcpStorePlatform, useMcpStore } from "@/store/mcpStore.js";
import { DEFAULT_MCP_CONFIG } from "@/store/mcpStoreHelpers.js";

const mountedRoots: Root[] = [];
const taskNotificationPlatform = { showTaskNotification: vi.fn() };
const formatMessage = ({ id }: { id: string }) => id;

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function makeServices() {
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const subscribeSessionsIndexV4 = vi.fn(async () => ({
    ack: {
      subscriptionId: "sub-1",
      mode: "snapshot" as const,
      logEpoch: "epoch-1",
    },
  }));
  const loadMcpFromUserDirectory = vi.fn(async () => ({ servers: [] }));
  const services = {
    zcodeAgentService: {
      helloConversationV4: vi.fn(async () => ({
        kind: "hello" as const,
        protocolVersion: 3 as const,
        connectionId: "test-connection",
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: 1,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
        },
        auth: {},
      })),
      initializeConversationV4: vi.fn(async () => {}),
      subscribeSessionsIndexV4,
      unsubscribeSessionsIndexV4: vi.fn(async () => {}),
      resyncSessionsIndexV4: vi.fn(async (params: { subscriptionId: string }) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      })),
      onDynamicSessionsIndexFrame: vi.fn(() => () => ({ dispose: () => {} })),
      onAgentRuntimeRestarted: runtimeRestarts.event,
    },
    mcpSyncService: {
      loadMcpFromUserDirectory,
      saveMcpToUserDirectory: vi.fn(async () => {}),
    },
  } as unknown as IServiceAccessor;
  return { loadMcpFromUserDirectory, services, subscribeSessionsIndexV4 };
}

function WorkspaceStartupRpcEffects({
  remote = true,
  rpcReady,
}: {
  remote?: boolean;
  rpcReady: boolean;
}) {
  const workspacePath = remote ? "/remote/workspace" : "/local/workspace";
  const workspaceIdentity = remote ? "remote:ssh:dev:/remote/workspace" : undefined;
  const notificationParams = {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remote ? { endpointKey: "remote-session-1" } : {}),
    enabled: true,
    rpcReady,
    platform: taskNotificationPlatform,
    formatMessage,
  };
  useWorkspaceTerminalTaskNotifications(notificationParams);
  useEnsureWorkspaceMcpLoaded(workspacePath, workspaceIdentity, rpcReady);
  return null;
}

beforeEach(() => {
  setMcpStoreDirectoryService(null);
  setMcpStorePlatform(null);
  useMcpStore.setState((state) => ({
    ...state,
    config: { ...DEFAULT_MCP_CONFIG },
    nativeServers: [],
    servers: [],
    statusSnapshots: {},
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    enabledStates: {},
    deletedPreloadMcpServers: new Set(),
    isConfigLoaded: false,
    currentSessionId: null,
  }));
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  setMcpStoreDirectoryService(null);
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("workspace startup RPC effects", () => {
  it("remote-waiting 不订阅任务通知或水合 MCP，remote-ready 后各启动一次", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const { loadMcpFromUserDirectory, services, subscribeSessionsIndexV4 } = makeServices();

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services },
          createElement(WorkspaceStartupRpcEffects, { rpcReady: false }),
        ),
      );
      await Promise.resolve();
    });

    expect(subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(loadMcpFromUserDirectory).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services },
          createElement(WorkspaceStartupRpcEffects, { rpcReady: true }),
        ),
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(loadMcpFromUserDirectory).toHaveBeenCalledTimes(1);
    });
  });

  it("本地 workspace 的 ready 路径仍立即启动两类副作用", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const { loadMcpFromUserDirectory, services, subscribeSessionsIndexV4 } = makeServices();
    const platformLoadMcpFromUserDirectory = vi.fn(async () => ({ servers: [] }));
    setMcpStorePlatform({
      loadMcpFromUserDirectory: platformLoadMcpFromUserDirectory,
      migrateLegacyCommonMcp: vi.fn(async () => ({
        importedCount: 0,
        servers: {},
        skippedCount: 0,
        totalCount: 0,
      })),
      saveMcpToUserDirectory: vi.fn(async () => ({ success: true })),
    });

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services },
          createElement(WorkspaceStartupRpcEffects, { remote: false, rpcReady: true }),
        ),
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(platformLoadMcpFromUserDirectory).toHaveBeenCalledTimes(1);
    });
    expect(loadMcpFromUserDirectory).not.toHaveBeenCalled();
  });
});
