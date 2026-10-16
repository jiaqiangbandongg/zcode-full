import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import {
  bindRemoteWorkspaceIdentity,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import {
  useV4Conversation,
  V4ConversationProvider,
  V4PaneConversationProvider,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import { workspaceConnectionRegistrySize } from "@/v4/workspaceConnectionRegistry.js";

const mountedRoots: Root[] = [];

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

function makeServices(id: string): IServiceAccessor {
  return {
    __testId: id,
    zcodeAgentService: {
      onDynamicConversationFrame: () => () => ({ dispose: () => {} }),
      onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
    },
  } as unknown as IServiceAccessor;
}

function makeObservableServices(id: string) {
  const onDynamicConversationFrame = vi.fn(() => () => ({ dispose: () => {} }));
  return {
    services: {
      __testId: id,
      zcodeAgentService: {
        onDynamicConversationFrame,
        onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
      },
    } as unknown as IServiceAccessor,
    onDynamicConversationFrame,
  };
}

function makePreviewServices(id: string) {
  const attachmentPreviewSourceV4 = vi.fn(async () => ({
    kind: "local_path" as const,
    path: "/remote/work/demo.mp4",
    mediaType: "video/mp4",
  }));
  const attachmentReadV4 = vi.fn(async () => ({
    dataBase64: Buffer.from("remote-video").toString("base64"),
    mediaType: "video/mp4",
    totalBytes: 12,
    nextOffset: null,
  }));
  return {
    services: {
      __testId: id,
      zcodeAgentService: {
        helloConversationV4: vi.fn(async () => ({
          kind: "hello" as const,
          protocolVersion: 3 as const,
          connectionId: `${id}-connection`,
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
        attachmentPreviewSourceV4,
        attachmentReadV4,
        onDynamicConversationFrame: () => () => ({ dispose: () => {} }),
        onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
      },
    } as unknown as IServiceAccessor,
    attachmentPreviewSourceV4,
    attachmentReadV4,
  };
}

function TestProviders({
  services,
  platform = {} as IPlatformService,
  children,
}: {
  services: IServiceAccessor;
  platform?: IPlatformService;
  children: ReactNode;
}) {
  return createElement(
    PlatformProvider,
    { platform },
    createElement(ServiceProvider, { services }, createElement(TabStoreProvider, null, children)),
  );
}

function MountProbe({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return null;
}

function AttachmentReadProbe({
  onReady,
}: {
  onReady: (attachmentRead: V4ConversationContextValue["attachmentRead"]) => void;
}) {
  const { attachmentRead } = useV4Conversation();
  useEffect(() => {
    onReady(attachmentRead);
  }, [attachmentRead, onReady]);
  return null;
}

beforeEach(() => {
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("V4ConversationProvider remote readiness", () => {
  it("远端 services 注册前不挂载 workspace 数据层，注册后只挂载一次", () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const baseServices = makeServices("base");
    const remoteServices = makeServices("remote");
    const onMount = vi.fn();
    const workspaceIdentity = "remote:ssh:dev:/workspace/app";
    registerBaseWorkspaceServices(baseServices);

    act(() => {
      root.render(
        createElement(
          TestProviders,
          { services: baseServices },
          createElement(
            V4ConversationProvider,
            {
              workspacePath: "/workspace/app",
              workspaceIdentity,
            },
            createElement(MountProbe, { onMount }),
          ),
        ),
      );
    });

    expect(onMount).not.toHaveBeenCalled();

    act(() => {
      registerRemoteWorkspaceSession({
        sessionId: "remote-session-1",
        services: remoteServices,
      });
    });
    expect(onMount).not.toHaveBeenCalled();

    act(() => {
      bindRemoteWorkspaceIdentity(workspaceIdentity, "remote-session-1");
    });

    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("跨 workspace pane 在远端 endpoint ready 前不获取 conversation 连接", () => {
    vi.useFakeTimers();
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const baseServices = makeServices("base");
    const remoteServices = makeServices("remote-pane");
    const onMount = vi.fn();
    const workspaceIdentity = "remote:ssh:dev:/workspace/pane";
    registerBaseWorkspaceServices(baseServices);

    act(() => {
      root.render(
        createElement(
          TestProviders,
          { services: baseServices },
          createElement(
            V4PaneConversationProvider,
            {
              scope: {
                workspacePath: "/workspace/pane",
                workspaceIdentity,
                remoteSessionId: "remote-session-pane",
              },
            },
            createElement(MountProbe, { onMount }),
          ),
        ),
      );
    });
    expect(onMount).not.toHaveBeenCalled();

    act(() => {
      registerRemoteWorkspaceSession({
        sessionId: "remote-session-pane",
        services: remoteServices,
      });
      bindRemoteWorkspaceIdentity(workspaceIdentity, "remote-session-pane");
    });
    expect(onMount).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    mountedRoots.pop();
    act(() => vi.runAllTimers());
    vi.useRealTimers();
  });

  it("pane 从 identity 解析出的 endpoint 与随后注入的 remoteSessionId 复用同一连接", () => {
    vi.useFakeTimers();
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const baseServices = makeServices("base");
    const remoteServices = makeObservableServices("remote-resolved");
    const workspaceIdentity = "remote:wsl:Ubuntu:/workspace/resolved";
    const remoteSessionId = "remote-session-resolved";
    registerBaseWorkspaceServices(baseServices);
    registerRemoteWorkspaceSession({
      sessionId: remoteSessionId,
      services: remoteServices.services,
    });
    bindRemoteWorkspaceIdentity(workspaceIdentity, remoteSessionId);

    const renderPane = (includeRemoteSessionId: boolean) =>
      createElement(
        TestProviders,
        { services: baseServices },
        createElement(
          V4PaneConversationProvider,
          {
            scope: {
              workspacePath: "/workspace/resolved",
              workspaceIdentity,
              ...(includeRemoteSessionId ? { remoteSessionId } : {}),
            },
          },
          createElement(MountProbe, { onMount: () => {} }),
        ),
      );

    act(() => root.render(renderPane(false)));
    expect(workspaceConnectionRegistrySize()).toBe(1);
    expect(remoteServices.onDynamicConversationFrame).toHaveBeenCalledTimes(1);

    act(() => root.render(renderPane(true)));
    expect(workspaceConnectionRegistrySize()).toBe(1);
    expect(remoteServices.onDynamicConversationFrame).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    mountedRoots.pop();
    act(() => vi.runAllTimers());
    vi.useRealTimers();
  });

  it("本地 workspace 保持立即挂载数据层", () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const baseServices = makeServices("base-local");
    const onMount = vi.fn();
    registerBaseWorkspaceServices(baseServices);

    act(() => {
      root.render(
        createElement(
          TestProviders,
          { services: baseServices },
          createElement(
            V4ConversationProvider,
            { workspacePath: "/workspace/local" },
            createElement(MountProbe, { onMount }),
          ),
        ),
      );
    });

    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("远端 services 换代在 Provider commit 后激活新 transport", () => {
    vi.useFakeTimers();
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const baseServices = makeServices("base");
    const oldRemote = makeObservableServices("remote-old");
    const newRemote = makeObservableServices("remote-new");
    const workspaceIdentity = "remote:ssh:dev:/workspace/handoff";
    const scope = {
      workspacePath: "/workspace/handoff",
      workspaceIdentity,
      remoteSessionId: "remote-session-handoff",
    };
    registerBaseWorkspaceServices(baseServices);
    registerRemoteWorkspaceSession({
      sessionId: scope.remoteSessionId,
      services: oldRemote.services,
    });
    bindRemoteWorkspaceIdentity(workspaceIdentity, scope.remoteSessionId);

    act(() => {
      root.render(
        createElement(
          TestProviders,
          { services: baseServices },
          createElement(
            V4PaneConversationProvider,
            { scope },
            createElement(MountProbe, { onMount: () => {} }),
          ),
        ),
      );
    });
    expect(oldRemote.onDynamicConversationFrame).toHaveBeenCalledTimes(1);
    expect(newRemote.onDynamicConversationFrame).not.toHaveBeenCalled();

    act(() => {
      registerRemoteWorkspaceSession({
        sessionId: scope.remoteSessionId,
        services: newRemote.services,
      });
    });

    expect(newRemote.onDynamicConversationFrame).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    mountedRoots.pop();
    act(() => vi.runAllTimers());
    vi.useRealTimers();
  });

  it("本地主 workspace 注入本地视频预览能力", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const local = makePreviewServices("local-preview");
    const createLocalMediaPreviewUrl = vi.fn(() => "zcode-media://local/preview");
    const platform = { createLocalMediaPreviewUrl } as unknown as IPlatformService;
    let attachmentRead: V4ConversationContextValue["attachmentRead"] | undefined;
    registerBaseWorkspaceServices(local.services);

    act(() => {
      root.render(
        createElement(
          TestProviders,
          { services: local.services, platform },
          createElement(
            V4ConversationProvider,
            { workspacePath: "/workspace/local" },
            createElement(AttachmentReadProbe, {
              onReady: (read) => {
                attachmentRead = read;
              },
            }),
          ),
        ),
      );
    });

    await expect(
      attachmentRead?.({
        sessionId: "session-local",
        ref: "/workspace/local/demo.mp4",
        mediaType: "video/mp4",
      }),
    ).resolves.toEqual({ url: "zcode-media://local/preview", mediaType: "video/mp4" });
    expect(local.attachmentPreviewSourceV4).toHaveBeenCalledOnce();
    expect(local.attachmentReadV4).not.toHaveBeenCalled();
  });

  it("远端主 workspace 不把远端文件路径交给 Desktop 本地媒体协议", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoots.push(root);
    const baseServices = makeServices("base-remote-preview");
    const remote = makePreviewServices("remote-preview");
    const createLocalMediaPreviewUrl = vi.fn(() => "zcode-media://local/wrong-host");
    const platform = { createLocalMediaPreviewUrl } as unknown as IPlatformService;
    const workspaceIdentity = "remote:ssh:dev:/remote/work";
    const remoteSessionId = "remote-session-preview";
    let attachmentRead: V4ConversationContextValue["attachmentRead"] | undefined;
    registerBaseWorkspaceServices(baseServices);
    registerRemoteWorkspaceSession({ sessionId: remoteSessionId, services: remote.services });
    bindRemoteWorkspaceIdentity(workspaceIdentity, remoteSessionId);

    act(() => {
      root.render(
        createElement(
          TestProviders,
          { services: baseServices, platform },
          createElement(
            V4ConversationProvider,
            { workspacePath: "/remote/work", workspaceIdentity },
            createElement(AttachmentReadProbe, {
              onReady: (read) => {
                attachmentRead = read;
              },
            }),
          ),
        ),
      );
    });

    await expect(
      attachmentRead?.({
        sessionId: "session-remote",
        ref: "/remote/work/demo.mp4",
        mediaType: "video/mp4",
      }),
    ).resolves.toEqual({
      bytes: new Uint8Array(Buffer.from("remote-video")),
      mediaType: "video/mp4",
    });
    expect(remote.attachmentPreviewSourceV4).not.toHaveBeenCalled();
    expect(createLocalMediaPreviewUrl).not.toHaveBeenCalled();
    expect(remote.attachmentReadV4).toHaveBeenCalledOnce();
  });
});
