import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import {
  ConversationTelemetryWorkspaceAttachment,
  disposeConversationTelemetrySupervisors,
  reconcileConversationTelemetryWorkspaceScopes,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

interface ServiceHarness {
  services: IServiceAccessor;
  facts: Emitter<ConversationTelemetryFact>;
  onFact: ReturnType<typeof vi.fn>;
  removedLastListener: ReturnType<typeof vi.fn>;
}

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
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom(): Element {
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
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => {},
      document: documentMock,
      HTMLIFrameElement: function HTMLIFrameElement() {},
      HTMLElement: function HTMLElement() {},
      Node: function Node() {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

function createServices(): ServiceHarness {
  const removedLastListener = vi.fn();
  const facts = new Emitter<ConversationTelemetryFact>({
    onDidRemoveLastListener: removedLastListener,
  });
  const onFact = vi.fn(() => facts.event);
  return {
    services: {
      zcodeAgentService: {
        onDynamicConversationTelemetryFact: onFact,
      },
    } as unknown as IServiceAccessor,
    facts,
    onFact,
    removedLastListener,
  };
}

function modelFact(eventId: string): ConversationTelemetryFact {
  return {
    version: 1,
    eventId,
    eventSeq: 1,
    occurredAt: 1,
    sessionId: "session-1",
    kind: "model.request.status",
    requestId: `request-${eventId}`,
    status: "model_request_started",
    providerId: "provider",
    modelId: "model",
    transport: "fetch",
    attempt: 1,
    maxAttempts: 1,
  };
}

function mountAttachment(params: {
  services: IServiceAccessor;
  platform: IPlatformService;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  onSupervisor(supervisor: ConversationTelemetrySupervisor | null): void;
}): Root {
  const scope = {
    workspacePath: "/same/path",
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
  };
  function Probe() {
    params.onSupervisor(useScopedConversationTelemetrySupervisor(scope));
    return null;
  }
  const root = createRoot(installMinimalDom());
  mountedRoots.push(root);
  act(() => {
    root.render(
      createElement(
        PlatformProvider,
        { platform: params.platform },
        createElement(
          ConversationTelemetryWorkspaceAttachment,
          { enabled: true, services: params.services, ...scope },
          createElement(Probe),
        ),
      ),
    );
  });
  return root;
}

function unmount(root: Root): void {
  act(() => root.unmount());
  const index = mountedRoots.indexOf(root);
  if (index >= 0) mountedRoots.splice(index, 1);
}

describe("ConversationTelemetryWorkspaceAttachment", () => {
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    disposeConversationTelemetrySupervisors();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("Platform 或 agent service 未就绪时保持旁路 no-op，不阻断 workspace 渲染", () => {
    const services = {} as IServiceAccessor;
    const scope = { workspacePath: "/not-ready" };
    const seen: Array<ConversationTelemetrySupervisor | null> = [];
    function Probe() {
      seen.push(useScopedConversationTelemetrySupervisor(scope));
      return null;
    }
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    expect(() => {
      act(() => {
        root.render(
          createElement(
            ConversationTelemetryWorkspaceAttachment,
            { enabled: true, services, ...scope },
            createElement(Probe),
          ),
        );
      });
    }).not.toThrow();
    expect(seen.at(-1)).toBeNull();

    const platform = {
      reportArmsCustomEvent: vi.fn(async () => undefined),
      reportTelemetryEvent: vi.fn(async () => undefined),
    } as unknown as IPlatformService;
    expect(() => {
      act(() => {
        root.render(
          createElement(
            PlatformProvider,
            { platform },
            createElement(
              ConversationTelemetryWorkspaceAttachment,
              { enabled: true, services, ...scope },
              createElement(Probe),
            ),
          ),
        );
      });
    }).not.toThrow();
    expect(seen.at(-1)).toBeNull();
  });

  it("pane 卸载后保留 workspace subscription，重挂复用 supervisor，真实 detach 才销毁", () => {
    const service = createServices();
    const reportArmsCustomEvent = vi.fn(async () => undefined);
    const platform = {
      reportArmsCustomEvent,
      reportTelemetryEvent: vi.fn(),
    } as unknown as IPlatformService;
    const seen: Array<ConversationTelemetrySupervisor | null> = [];
    const firstRoot = mountAttachment({
      services: service.services,
      platform,
      workspaceIdentity: "workspace-A",
      onSupervisor: (supervisor) => seen.push(supervisor),
    });
    expect(service.onFact).toHaveBeenCalledTimes(1);
    const firstSupervisor = seen.at(-1);

    unmount(firstRoot);
    expect(service.removedLastListener).not.toHaveBeenCalled();
    service.facts.fire(modelFact("background-after-pane-close"));
    expect(reportArmsCustomEvent).toHaveBeenCalledTimes(1);

    const secondRoot = mountAttachment({
      services: service.services,
      platform,
      workspaceIdentity: "workspace-A",
      onSupervisor: (supervisor) => seen.push(supervisor),
    });
    expect(seen.at(-1)).toBe(firstSupervisor);
    expect(service.onFact).toHaveBeenCalledTimes(1);
    service.facts.fire(modelFact("after-remount"));
    expect(reportArmsCustomEvent).toHaveBeenCalledTimes(2);

    unmount(secondRoot);
    reconcileConversationTelemetryWorkspaceScopes([]);
    expect(service.removedLastListener).toHaveBeenCalledTimes(1);
    service.facts.fire(modelFact("after-detach"));
    expect(reportArmsCustomEvent).toHaveBeenCalledTimes(2);
  });

  it("service generation 替换与 remoteSessionId/workspaceIdentity 使用独立 supervisor", () => {
    const oldService = createServices();
    const newService = createServices();
    const platform = {
      reportArmsCustomEvent: vi.fn(async () => undefined),
      reportTelemetryEvent: vi.fn(async () => undefined),
    } as unknown as IPlatformService;
    let oldSupervisor: ConversationTelemetrySupervisor | null = null;
    let newSupervisor: ConversationTelemetrySupervisor | null = null;
    let remoteSupervisor: ConversationTelemetrySupervisor | null = null;
    const oldRoot = mountAttachment({
      services: oldService.services,
      platform,
      workspaceIdentity: "workspace-A",
      remoteSessionId: "remote-1",
      onSupervisor: (supervisor) => {
        oldSupervisor = supervisor;
      },
    });
    const newRoot = mountAttachment({
      services: newService.services,
      platform,
      workspaceIdentity: "workspace-A",
      remoteSessionId: "remote-1",
      onSupervisor: (supervisor) => {
        newSupervisor = supervisor;
      },
    });
    const remoteRoot = mountAttachment({
      services: newService.services,
      platform,
      workspaceIdentity: "workspace-A",
      remoteSessionId: "remote-2",
      onSupervisor: (supervisor) => {
        remoteSupervisor = supervisor;
      },
    });
    expect(newSupervisor).not.toBe(oldSupervisor);
    expect(remoteSupervisor).not.toBe(newSupervisor);

    unmount(oldRoot);
    expect(oldService.removedLastListener).toHaveBeenCalledTimes(1);
    expect(newService.removedLastListener).not.toHaveBeenCalled();
    unmount(newRoot);
    unmount(remoteRoot);
    reconcileConversationTelemetryWorkspaceScopes([]);
    expect(newService.removedLastListener).toHaveBeenCalledTimes(1);
  });

  it("本地与远程 attachment 的 message_completion/agent_step 携带场景维度", async () => {
    const localService = createServices();
    const remoteService = createServices();
    const reportTelemetryEvent = vi.fn(async () => undefined);
    const platform = {
      reportArmsCustomEvent: vi.fn(async () => undefined),
      reportTelemetryEvent,
    } as unknown as IPlatformService;
    let localSupervisor: ConversationTelemetrySupervisor | null = null;
    let remoteSupervisor: ConversationTelemetrySupervisor | null = null;
    const localRoot = mountAttachment({
      services: localService.services,
      platform,
      onSupervisor: (supervisor) => {
        localSupervisor = supervisor;
      },
    });
    const remoteRoot = mountAttachment({
      services: remoteService.services,
      platform,
      workspaceIdentity: "remote:ssh:example.test:22:alice:/same/path",
      remoteSessionId: "remote-1",
      onSupervisor: (supervisor) => {
        remoteSupervisor = supervisor;
      },
    });

    expect(localSupervisor).not.toBeNull();
    expect(remoteSupervisor).not.toBeNull();

    await emitSuccessfulConversation(localSupervisor!, "local-session", "local-command");
    await emitSuccessfulConversation(remoteSupervisor!, "remote-session", "remote-command");

    const localReports = reportTelemetryEvent.mock.calls
      .map(([payload]) => payload)
      .filter(
        (payload) =>
          payload.talkId === "local-session" &&
          (payload.elementName === "agent_step" || payload.elementName === "message_completion"),
      );
    const remoteReports = reportTelemetryEvent.mock.calls
      .map(([payload]) => payload)
      .filter(
        (payload) =>
          payload.talkId === "remote-session" &&
          (payload.elementName === "agent_step" || payload.elementName === "message_completion"),
      );

    expect(localReports).toHaveLength(2);
    expect(remoteReports).toHaveLength(2);
    expect(localReports.map((payload) => payload.elementName).sort()).toEqual([
      "agent_step",
      "message_completion",
    ]);
    expect(remoteReports.map((payload) => payload.elementName).sort()).toEqual([
      "agent_step",
      "message_completion",
    ]);
    for (const payload of localReports) {
      expect(payload.eventExtraDetail).toMatchObject({
        workspace_kind: "local",
        remote_kind: "",
      });
    }
    for (const payload of remoteReports) {
      expect(payload.eventExtraDetail).toMatchObject({
        workspace_kind: "remote",
        remote_kind: "ssh",
      });
    }

    unmount(localRoot);
    unmount(remoteRoot);
    reconcileConversationTelemetryWorkspaceScopes([]);
  });

  it("无法解析的 remote identity 在缺少 remoteSessionId 时仍按远程 workspace 上报", async () => {
    const service = createServices();
    const reportTelemetryEvent = vi.fn(async () => undefined);
    const platform = {
      reportArmsCustomEvent: vi.fn(async () => undefined),
      reportTelemetryEvent,
    } as unknown as IPlatformService;
    let supervisor: ConversationTelemetrySupervisor | null = null;
    const root = mountAttachment({
      services: service.services,
      platform,
      // 远程 identity 可能来自尚未升级的 host 或未来格式；此时仍不能退化成本地。
      workspaceIdentity: "remote:future:opaque:/same/path",
      onSupervisor: (nextSupervisor) => {
        supervisor = nextSupervisor;
      },
    });

    expect(supervisor).not.toBeNull();
    await emitSuccessfulConversation(
      supervisor!,
      "unknown-remote-session",
      "unknown-remote-command",
    );

    const reports = reportTelemetryEvent.mock.calls
      .map(([payload]) => payload)
      .filter(
        (payload) =>
          payload.talkId === "unknown-remote-session" &&
          (payload.elementName === "agent_step" || payload.elementName === "message_completion"),
      );
    expect(reports).toHaveLength(2);
    for (const payload of reports) {
      expect(payload.eventExtraDetail).toMatchObject({
        workspace_kind: "remote",
        remote_kind: "",
      });
    }

    unmount(root);
    reconcileConversationTelemetryWorkspaceScopes([]);
  });
});

async function emitSuccessfulConversation(
  supervisor: ConversationTelemetrySupervisor,
  sessionId: string,
  commandId: string,
): Promise<void> {
  supervisor.acceptPromptSeed({
    sessionId,
    sourceCommandId: commandId,
    sendTime: 100,
    extraDetail: {
      model_name: "provider/model",
      model_provider: "provider",
    },
  });
  supervisor.handleFact({
    version: 1,
    eventId: `${commandId}-start`,
    eventSeq: 1,
    occurredAt: 100,
    sessionId,
    sourceCommandId: commandId,
    turnId: `${commandId}-turn`,
    kind: "turn.started",
    executionKind: "agent",
  });
  supervisor.handleFact({
    version: 1,
    eventId: `${commandId}-chunk`,
    eventSeq: 2,
    occurredAt: 110,
    sessionId,
    sourceCommandId: commandId,
    turnId: `${commandId}-turn`,
    kind: "stream.chunk",
    channel: "text",
    chunkLength: 1,
    firstChunk: true,
  });
  supervisor.handleFact({
    version: 1,
    eventId: `${commandId}-terminal`,
    eventSeq: 3,
    occurredAt: 120,
    sessionId,
    sourceCommandId: commandId,
    turnId: `${commandId}-turn`,
    kind: "turn.terminal",
    status: "success",
    resultType: "complete",
  });
  await supervisor.flushReportsForTest();
}
