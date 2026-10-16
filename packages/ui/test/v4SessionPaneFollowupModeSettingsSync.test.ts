import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { dispatchConversationSelectionAdd } from "@/lib/conversationSelectionReference.js";
import {
  buildSelectionSideChatKey,
  getSelectionSideChatOpenState,
  requestSelectionSideChatOpen,
  setSelectionSideChatBlocked,
} from "@/lib/selectionSideChatRuntime.js";

vi.mock("@/lib/conversationSelectionReference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/conversationSelectionReference.js")>()),
  dispatchConversationSelectionAdd: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 永不 resolve：这些文件不测发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const { layerMock, sendCommandMock } = vi.hoisted(() => ({
  layerMock: {
    acquire: vi.fn(() => ({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        recoverFromStaleAuthority: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    })),
  },
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: envelope.baseRevision ?? 0,
    }),
  ),
}));

const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

const servicesMock = vi.hoisted(() => ({
  highspeedCardService: {
    getSnapshot: vi.fn(async () => ({ card: null, nextDrawAt: null, drawing: false })),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  // 修复原因：readiness hook 将 service 作为 effect 依赖；每次 render 重建会导致无限重渲染直至 OOM。
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
    readSession: vi.fn(async () => ({})),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

// 本组隔离编辑/设置行为，群投递服务由独立单测及 Host/CLI E2E 覆盖。
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { zcodeInteractionBehavior: "guide" },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: layerMock,
    sendCommand: sendCommandMock,
    attachmentPut: vi.fn(),
    // SessionPane 挂载即拉 journal 兜底的 run 发现查询：缺桩会在 effect 里 TypeError；
    // 桩必须是稳定引用——effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    draftConfigSeedSignal: 0,
    resolveInitialDraftConfig: vi.fn(),
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: () => React.createElement("div", { "data-testid": "mock-composer" }),
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: () => React.createElement("div", { "data-testid": "mock-timeline" }),
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () => React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () => React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () => React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return {
    V4ProviderRuntimeHeadersController: () =>
      React.createElement("div", { "data-testid": "mock-runtime-headers" }),
  };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

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

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
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
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

afterEach(() => {
  sendCommandMock.mockClear();
  projectionState.current = null;
  vi.mocked(dispatchConversationSelectionAdd).mockClear();
  setSelectionSideChatBlocked("side-child", false);
});

describe("SessionPane followupMode app setting sync", () => {
  it.each([false, true])("主控制器保留 Markdown 引用路由，辅助阻塞=%s", async (blocked) => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    setSelectionSideChatBlocked("side-child", blocked);
    const onOpen = vi.fn();
    const key = buildSelectionSideChatKey("/workspace", "session-1");
    const reference = {
      id: "markdown-selection",
      contentType: "markdown" as const,
      sourceKey: "file:/workspace/readme.md",
      sourceTitle: "readme.md",
      path: "/workspace/readme.md",
      text: "selected paragraph",
    };
    const root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(SessionPane, {
              paneId: "workspace-main",
              sessionId: "session-1",
              workspacePath: "/workspace",
              activeSelectionSideChatSessionId: "side-child",
              onOpenSelectionSideChat: onOpen,
            }),
          ),
        );
        await flushMicrotasks();
      });
      expect(getSelectionSideChatOpenState(key)).toBe(blocked ? "blocked" : "ready");
      await act(async () => {
        expect(requestSelectionSideChatOpen(key, reference)).toBe(!blocked);
        await flushMicrotasks();
      });
      if (blocked) {
        expect(onOpen).not.toHaveBeenCalled();
        expect(dispatchConversationSelectionAdd).not.toHaveBeenCalled();
      } else {
        expect(onOpen).toHaveBeenCalledWith(
          expect.objectContaining({ childSessionId: "side-child" }),
        );
        expect(dispatchConversationSelectionAdd).toHaveBeenCalledWith({
          targetSessionId: "side-child",
          workspaceKey: "/workspace",
          reference,
        });
        expect(
          sendCommandMock.mock.calls.some(
            ([command]) => command.type === "createSelectionSideSession",
          ),
        ).toBe(false);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("syncs guide app setting to the mounted v4 session", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      type: "setFollowupMode",
      payload: { mode: "guide" },
      baseRevision: 7,
    });

    await act(async () => {
      root.unmount();
    });
  });
});
