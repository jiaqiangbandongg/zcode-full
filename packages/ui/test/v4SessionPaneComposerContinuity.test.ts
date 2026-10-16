import { act, createElement, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { pendingCommandRegistry, type PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";

type ProjectionState = {
  status: "connecting" | "live";
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  optimisticCommands: readonly [];
  loadingOlder: boolean;
};

const recoveryCapture = vi.hoisted(() => ({
  entries: [] as PendingCommandEntry[],
  onResend: null as null | (() => void),
}));
vi.mock("@/v4/usePendingCommandRecovery.js", () => ({
  usePendingCommandRecovery: () => recoveryCapture.entries,
}));
vi.mock("@/v4/PendingCommandRecoveryBanner.js", () => ({
  PendingCommandRecoveryBanner: (props: { onResend?: () => void }) => {
    recoveryCapture.onResend = props.onResend ?? null;
    return null;
  },
}));

const sessionCreateCapture = vi.hoisted(() => ({ report: vi.fn(async () => {}) }));
vi.mock("@/lib/sessionCreateTelemetry.js", () => ({
  reportSessionCreate: sessionCreateCapture.report,
}));

const projectionState = vi.hoisted(() => ({
  current: null as ProjectionState | null,
}));

const composerLifecycle = vi.hoisted(() => ({
  disabledStates: [] as boolean[],
  mounts: 0,
  nextInstanceId: 1,
  renders: [] as number[],
  unmounts: 0,
}));

const scrollFocus = vi.hoisted(() => ({
  composerProps: null as null | {
    onOpenRunningBackgroundWorks?: () => void;
    onSendText: (
      text: string,
      options?: {
        heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
        expectedHeldQueueItemIds?: readonly string[];
        requestedDelivery?: "startNow" | "queue" | "guide";
        sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
        submission?: {
          mode: "build";
          modelSelection: {
            providerId: string;
            modelId: string;
            options: { reasoningLevel: string };
          };
        };
      },
    ) => Promise<"sent" | "blocked" | "confirmationRequired">;
  },
  queueProps: null as null | {
    onResume?: () => Promise<void>;
    onSendNow?: (queueItemId: string) => void;
  },
  statusPanelProps: null as null | {
    onTerminalSectionOpenChange?: (open: boolean) => void;
    terminalSectionOpen?: boolean;
    onAgentSectionOpenChange?: (open: boolean) => void;
    agentSectionOpen?: boolean;
    summaryPanelVariantOverride?: "panel" | "mini" | null;
  },
  scrollToBottom: vi.fn(),
}));

// 永不 resolve：这些文件不测发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const conversationMock = vi.hoisted(() => {
  const lease = {
    release: vi.fn(),
    store: {
      expectAcceptedInputProjection: vi.fn(),
      markCommandPending: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
  };
  const sendCommand = vi.fn(async (envelope: { commandId: string }) => ({
    commandId: envelope.commandId,
    revisionAtDecision: 1,
    status: "accepted" as const,
  }));
  const layer = {
    acquire: vi.fn(() => lease),
    queryCommands: vi.fn(async () => ({ results: [] })),
  };
  return {
    layer,
    lease,
    currentLayer: null as typeof layer | null,
    currentSendCommand: null as typeof sendCommand | null,
    sendCommand,
  };
});

const prewarmHookInputs = vi.hoisted(() => ({
  binding: null as null | { sessionId: string; beginPromotion: () => boolean; promote: () => void },
  current: [] as Array<{
    workspaceKey: string;
    transportIdentity: unknown;
    dispatchCommand: (
      type: string,
      payload: Record<string, unknown>,
      sessionId: string | null,
    ) => Promise<unknown>;
  }>,
}));

const servicesMock = vi.hoisted(() => ({
  highspeedCardService: {
    // 本文件使用会在用例结束后销毁的极简 DOM；保持无关 Highspeed 查询 pending，
    // 避免其 Promise 回调在 window 清理后再次唤醒 React scheduler。
    getSnapshot: vi.fn(() => new Promise(() => {})),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  // 修复原因：readiness hook 将 service 作为 effect 依赖；每次 render 重建会导致无限重渲染直至 OOM。
  modelSelectionService: {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [
        {
          providerId: "provider-deepseek",
          config: { kind: "api" as const },
          models: [{ modelId: "deepseek-v4-flash", config: {} }],
        },
      ],
    })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    validate: vi.fn(),
  },
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

// 本组只验证输入框连续性；群同步服务由独立组件测试和真实 Host/CLI E2E 覆盖。
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

// Bugfix：本文件只验证 SessionPane 的 composer 连续性，隔离闲时入口对真实 TabStore 的依赖。
vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));

// 同理隔离推荐提示词占位：本文件用的是只实现 createElement 的极简 DOM，
// 渲染 lucide 图标会走 createElementNS 而直接崩掉，与 composer 连续性无关。
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: conversationMock.currentLayer ?? conversationMock.layer,
    sendCommand: conversationMock.currentSendCommand ?? conversationMock.sendCommand,
    attachmentPut: vi.fn(),
    // SessionPane 挂载即拉 journal 兜底的 run 发现查询：缺桩会在 effect 里 TypeError；
    // 桩必须是稳定引用——effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { zcodeInteractionBehavior: "queue" },
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

// 本文件只验证 composer 生命周期；目标 Host View 的异步订阅已有独立 hook 测试。
// 若让真实 hook 在极简 DOM 中运行，Promise 回流会把 React 调度留到 window 清理之后。
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionServiceView: () => ({
    state: {
      status: "ready",
      view: {
        revision: 1,
        preferredSelection: {
          providerId: "provider-deepseek",
          modelId: "deepseek-v4-flash",
        },
        providers: [
          {
            providerId: "provider-deepseek",
            config: { kind: "api" as const },
            models: [
              {
                modelId: "deepseek-v4-flash",
                config: {
                  optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } },
                },
              },
            ],
          },
        ],
      },
    },
    reload: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: useModelSelectionServiceView(null),
    captureAcceptedModelSelection: () => vi.fn(),
    composerDraft: { text: "", updatedAt: 0 },
    draftConfig: {},
    draftConfigRef: {
      current: {
        mode: "build",
        modelSelection: {
          providerId: "provider-deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "high" },
        },
      },
    },
    resolveInitialDraftConfig: vi.fn(async () => ({})),
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    promoteComposerDraft: vi.fn(),
    replaceComposerDraft: vi.fn(),
    updateComposerContent: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: (params: (typeof prewarmHookInputs.current)[number]) => {
    prewarmHookInputs.current.push(params);
    return {
      binding: prewarmHookInputs.binding,
    };
  },
}));

vi.mock("@/v4/ConversationComposer.js", () => ({
  ConversationComposer: (props: {
    disabled?: boolean;
    onOpenRunningBackgroundWorks?: () => void;
    onSendText: (
      text: string,
      options?: {
        heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
        expectedHeldQueueItemIds?: readonly string[];
        requestedDelivery?: "startNow" | "queue" | "guide";
        sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
      },
    ) => Promise<"sent" | "blocked" | "confirmationRequired">;
  }) => {
    const { disabled = false } = props;
    scrollFocus.composerProps = props;
    const instanceIdRef = useRef<number | null>(null);
    if (instanceIdRef.current === null) {
      instanceIdRef.current = composerLifecycle.nextInstanceId;
      composerLifecycle.nextInstanceId += 1;
    }
    composerLifecycle.renders.push(instanceIdRef.current);
    composerLifecycle.disabledStates.push(disabled);
    useEffect(() => {
      composerLifecycle.mounts += 1;
      return () => {
        composerLifecycle.unmounts += 1;
      };
    }, []);
    return createElement("div", { "data-testid": "mock-composer" });
  },
}));

vi.mock("@/v4/ConversationHeader.js", () => ({
  ConversationHeader: () => createElement("div", null),
}));

vi.mock("@/v4/ConversationStatusPanel.js", () => ({
  ConversationStatusPanel: (props: {
    onTerminalSectionOpenChange?: (open: boolean) => void;
    terminalSectionOpen?: boolean;
    onAgentSectionOpenChange?: (open: boolean) => void;
    agentSectionOpen?: boolean;
    summaryPanelVariantOverride?: "panel" | "mini" | null;
  }) => {
    scrollFocus.statusPanelProps = props;
    return createElement("div", null);
  },
}));

vi.mock("@/v4/ConversationTimeline.js", () => ({
  ConversationTimeline: ({
    bottomDock,
    emptyState,
    scrollToBottomActionRef,
  }: {
    bottomDock?: ReactNode;
    emptyState?: ReactNode;
    scrollToBottomActionRef?: { current: (() => void) | null };
  }) => {
    useLayoutEffect(() => {
      if (scrollToBottomActionRef) {
        scrollToBottomActionRef.current = scrollFocus.scrollToBottom;
      }
    }, [scrollToBottomActionRef]);
    return createElement("div", null, emptyState, bottomDock);
  },
}));

vi.mock("@/v4/ConversationQueuePanel.js", () => ({
  ConversationQueuePanel: (props: {
    onResume?: () => Promise<void>;
    onSendNow?: (queueItemId: string) => void;
  }) => {
    scrollFocus.queueProps = props;
    return createElement("div", null);
  },
}));

vi.mock("@/v4/V4InteractionDialogs.js", () => ({
  V4InteractionDialogs: () => createElement("div", null),
}));

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", () => ({
  V4ProviderRuntimeHeadersController: () => createElement("div", null),
}));

vi.mock("@/v4/ConversationDraftEmptyState.js", () => ({
  ConversationDraftEmptyState: () => createElement("div", null),
}));

function makeDraftSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "prewarm-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "noHistory" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "emptyQueue" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "firstInput" },
    config: {
      provider: "provider-deepseek",
      model: "deepseek-v4-flash",
      thought: "medium",
      followupMode: "queue",
      mode: "build",
    },
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
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
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
    clientWidth: 1024,
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
    innerWidth: 1024,
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

function renderPane(root: Root, sessionId: string | null): void {
  act(() => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
        }),
      ),
    );
  });
}

beforeEach(() => {
  sessionCreateCapture.report.mockClear();
  recoveryCapture.entries = [];
  recoveryCapture.onResend = null;
  prewarmHookInputs.binding = null;
  composerLifecycle.disabledStates = [];
  composerLifecycle.mounts = 0;
  composerLifecycle.nextInstanceId = 1;
  composerLifecycle.renders = [];
  composerLifecycle.unmounts = 0;
  conversationMock.layer.acquire.mockClear();
  conversationMock.lease.release.mockClear();
  conversationMock.lease.store.expectAcceptedInputProjection.mockClear();
  conversationMock.currentLayer = null;
  conversationMock.currentSendCommand = null;
  conversationMock.sendCommand.mockClear();
  prewarmHookInputs.current = [];
  scrollFocus.composerProps = null;
  scrollFocus.queueProps = null;
  scrollFocus.statusPanelProps = null;
  scrollFocus.scrollToBottom.mockClear();
  projectionState.current = {
    status: "live",
    snapshot: makeDraftSnapshot(),
    subscriptionId: "sub-draft",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane composer continuity", () => {
  it.each(["group", "project", "session"] as const)(
    "%s 首发只在 accepted 后报告，打开和后续发送不报告",
    async (source) => {
      const store = useZCodeSessionStore.getState();
      store.startDraft("/workspace", undefined, undefined, { createSource: source });
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      renderPane(root, null);
      expect(sessionCreateCapture.report).not.toHaveBeenCalled();
      conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
        commandId: envelope.commandId,
        revisionAtDecision: 1,
        status: "accepted" as const,
        result: { type: "createSession", sessionId: `created-${source}` },
      }));
      await act(async () => {
        await scrollFocus.composerProps?.onSendText("create session");
      });
      // Highspeed 统一了首发链路：无附件首发也走「空 createSession + sendText」两段式，
      // 好让抽卡 admission 拿到真实 sessionId，因此首发 message_id 是 sendText 的 commandId
      // （calls[1]），不是空创建的 commandId（calls[0]）。埋点不变量仍成立：accepted 后只报一次。
      const firstSendCalls = conversationMock.sendCommand.mock.calls;
      expect(firstSendCalls).toHaveLength(2);
      expect(sessionCreateCapture.report).toHaveBeenCalledExactlyOnceWith(
        null,
        expect.objectContaining({
          sessionId: `created-${source}`,
          messageId: firstSendCalls[1]![0].commandId,
          source,
        }),
      );
      renderPane(root, `created-${source}`);
      await act(async () => {
        await scrollFocus.composerProps?.onSendText("follow up");
      });
      expect(sessionCreateCapture.report).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["accepted", "rejected"] as const)("Goal 首发 %s 时只按 ACK 统计", async (status) => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null);
    conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
      result: { type: "createSession", sessionId: "goal-created" },
    }));
    conversationMock.sendCommand.mockResolvedValueOnce({
      commandId: "goal-command",
      revisionAtDecision: 1,
      status,
    } as never);
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("/goal explain the test");
    });
    expect(sessionCreateCapture.report).toHaveBeenCalledTimes(status === "accepted" ? 1 : 0);
    if (status === "accepted")
      expect(sessionCreateCapture.report).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ messageId: "goal-command" }),
      );
  });

  it.each(["hello", "/goal explain"])("预热首发 %s 携带实际输入 commandId", async (text) => {
    prewarmHookInputs.binding = {
      sessionId: "prewarmed",
      beginPromotion: () => true,
      promote: vi.fn(),
    };
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null);
    await act(async () => {
      await scrollFocus.composerProps?.onSendText(text);
    });
    const commandId = conversationMock.sendCommand.mock.calls[0]![0].commandId;
    expect(sessionCreateCapture.report).toHaveBeenCalledExactlyOnceWith(
      null,
      expect.objectContaining({ sessionId: "prewarmed", messageId: commandId }),
    );
  });

  it("先空创建再首发使用 sendText ID，不用空创建 ID", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null);
    conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
      result: { type: "createSession", sessionId: "two-phase" },
    }));
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("context", {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "context-1" }],
      });
    });
    const calls = conversationMock.sendCommand.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].commandId).not.toBe(calls[1]![0].commandId);
    expect(sessionCreateCapture.report).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ messageId: calls[1]![0].commandId }),
    );
  });

  it("用户确认恢复重发使用新 accepted ID，不用旧命令 ID", async () => {
    recoveryCapture.entries = [
      {
        commandId: "old-command",
        sessionId: null,
        replay: { kind: "input" },
      } as PendingCommandEntry,
    ];
    const replay = vi.spyOn(pendingCommandRegistry, "consumeReplay").mockReturnValueOnce({
      type: "createSession",
      sessionId: null,
      payload: { workspaceId: "/workspace", firstInput: { text: "retry" } },
      clientContext: { workspace: { workspacePath: "/workspace" }, sessionCreateSource: "project" },
    });
    try {
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      renderPane(root, null);
      conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
        commandId: envelope.commandId,
        revisionAtDecision: 1,
        status: "accepted" as const,
        result: { type: "createSession", sessionId: "recovered" },
      }));
      await act(async () => {
        recoveryCapture.onResend?.();
      });
      const newId = conversationMock.sendCommand.mock.calls[0]![0].commandId;
      expect(newId).not.toBe("old-command");
      expect(sessionCreateCapture.report).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ sessionId: "recovered", messageId: newId }),
      );
    } finally {
      replay.mockRestore();
    }
  });

  it("首发传输失败不产生 session_create", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null);
    conversationMock.sendCommand.mockRejectedValueOnce(new Error("transport offline"));
    await act(async () => {
      await expect(scrollFocus.composerProps?.onSendText("create session")).rejects.toThrow(
        "transport offline",
      );
    });
    expect(sessionCreateCapture.report).not.toHaveBeenCalled();
  });

  it("/goal 沿用点击发送时冻结的 Submission，不在异步准备后回读草稿", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, "session-1");
    const submission = {
      mode: "build" as const,
      modelSelection: {
        providerId: "provider-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "low" },
      },
    };
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("/goal 固定此次选择", { submission });
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sendGoalCommand",
        payload: expect.objectContaining(submission),
      }),
    );
  });

  it("workspace 切换后旧预热 dispatcher 仍发送到原本地 transport", async () => {
    const sendCommandA = vi.fn(async (envelope: { commandId: string }) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    const sendCommandB = vi.fn(async (envelope: { commandId: string }) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    const layerA = { ...conversationMock.layer };
    const layerB = { ...conversationMock.layer };
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    conversationMock.currentLayer = layerA;
    conversationMock.currentSendCommand = sendCommandA;
    act(() => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: null,
            workspacePath: "/local/a",
          }),
        ),
      );
    });
    const bindingA = prewarmHookInputs.current.findLast(
      (input) => input.workspaceKey === "/local/a",
    );
    // Bug 根因：single-flight 协调器已改用稳定的 SessionDataLayer 标识 transport，
    // 旧断言仍把 provider 每次可重建的 sendCommand wrapper 当作 identity。
    expect(bindingA?.transportIdentity).toBe(layerA);

    conversationMock.currentLayer = layerB;
    conversationMock.currentSendCommand = sendCommandB;
    act(() => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: null,
            workspacePath: "/local/b",
          }),
        ),
      );
    });
    await act(async () => {
      await bindingA?.dispatchCommand("deleteSession", {}, "draft-a");
    });

    expect(sendCommandA).toHaveBeenCalledTimes(1);
    expect(sendCommandB).not.toHaveBeenCalled();
  });

  it("keeps one composer instance while draft promotion waits for the first snapshot", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    renderPane(root, null);
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");
    projectionState.current = {
      status: "live",
      snapshot: { ...makeDraftSnapshot(), sessionId: "session-1" },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    expect(composerLifecycle.mounts).toBe(1);
    expect(composerLifecycle.unmounts).toBe(0);
    expect(new Set(composerLifecycle.renders)).toEqual(new Set([1]));
    expect(composerLifecycle.disabledStates).toContain(true);
    expect(composerLifecycle.disabledStates.at(-1)).toBe(false);
  });

  it("focuses after start-now, preserves position on enqueue, and focuses on queue send-now", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    projectionState.current = {
      status: "live",
      snapshot: { ...makeDraftSnapshot(), sessionId: "session-1" },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("direct prompt");
    });
    expect(scrollFocus.scrollToBottom).toHaveBeenCalledTimes(1);

    scrollFocus.scrollToBottom.mockClear();
    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        inputRouting: { mode: "enqueue" },
      },
    };
    renderPane(root, "session-1");

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("queued prompt");
    });
    expect(scrollFocus.scrollToBottom).not.toHaveBeenCalled();

    act(() => scrollFocus.queueProps?.onSendNow?.("queue-1"));
    expect(scrollFocus.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("running startNow dispatches one atomic sendText and never creates or promotes a queue item", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    projectionState.current = {
      status: "live",
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId: "session-1",
        inputRouting: { mode: "enqueue" },
      },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");
    conversationMock.sendCommand.mockClear();

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("立即执行", {
        requestedDelivery: "startNow",
      });
    });

    expect(conversationMock.sendCommand).toHaveBeenCalledTimes(1);
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sendText",
        payload: expect.objectContaining({
          text: "立即执行",
          requestedDelivery: "startNow",
        }),
      }),
    );
    expect(conversationMock.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sendQueuedNow" }),
    );
    expect(conversationMock.lease.store.expectAcceptedInputProjection).toHaveBeenCalledWith(
      conversationMock.sendCommand.mock.calls[0]?.[0].commandId,
    );
  });

  it("routes paused queue input to modal, while /compact queues directly", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const queuedItem = {
      queueItemId: "q-1",
      kind: "sendText" as const,
      text: "旧消息",
      sourceCommandId: "old-command",
      clientId: "desktop",
      attachments: [],
      delivery: { requested: "queue" as const, admitted: "queue" as const },
      order: { admissionSeq: 1, queuePosition: 0 },
      steer: { state: "notRequested" as const },
      dispatch: { state: "queued" as const },
      admittedAt: 1,
    };
    projectionState.current = {
      status: "live",
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId: "session-1",
        revision: 7,
        inputRouting: { mode: "choice" },
        queue: { autoDrain: false, pauseReason: "stopped", items: [queuedItem] },
      },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    await act(async () => {
      await expect(scrollFocus.composerProps?.onSendText("新消息")).resolves.toBe(
        "confirmationRequired",
      );
      await expect(scrollFocus.composerProps?.onSendText("/goal 新目标")).resolves.toBe(
        "confirmationRequired",
      );
    });
    expect(conversationMock.sendCommand).not.toHaveBeenCalled();

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("/compact");
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compact", sessionId: "session-1" }),
    );

    conversationMock.sendCommand.mockClear();
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("新消息", {
        heldQueueDisposition: "clearQueueAndSend",
        expectedHeldQueueItemIds: ["q-1"],
      });
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sendText",
        payload: expect.objectContaining({
          heldQueueDisposition: "clearQueueAndSend",
          expectedHeldQueueItemIds: ["q-1"],
        }),
      }),
    );
  });

  it("paused queue continue dispatches CAS setAutoDrain without preempting in UI", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const snapshot = makeDraftSnapshot();
    projectionState.current = {
      status: "live",
      snapshot: {
        ...snapshot,
        sessionId: "session-1",
        revision: 9,
        queue: {
          autoDrain: false,
          items: [
            {
              queueItemId: "q-1",
              kind: "sendText",
              text: "旧消息",
              sourceCommandId: "old-command",
              clientId: "desktop",
              attachments: [],
              delivery: { requested: "queue", admitted: "queue" },
              order: { admissionSeq: 1, queuePosition: 0 },
              steer: { state: "notRequested" },
              dispatch: { state: "queued" },
              admittedAt: 1,
            },
          ],
        },
      },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    await scrollFocus.queueProps?.onResume?.();
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRevision: 9,
        payload: { autoDrain: true },
        sessionId: "session-1",
        type: "setAutoDrain",
      }),
    );
  });

  // 展开后看到的不能比胶囊还少（docs/dynamic-workflow/presentation.md「Other places a run appears」）：
  // 活的 run 出现时（在跑数从 0 变成 ≥1，包括进入一个本就有活 run 的会话）「工作流」分区打开；
  // 最后一条结束时折起。读者手动折起后保持折起，直到 run 全部结束或换会话。
  it("opens the Workflows section while a run is live and respects a manual fold", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const liveRun = {
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
      status: "running" as const,
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 1,
    };
    const withRuns = (sessionId: string, runs: (typeof liveRun)[]) => ({
      status: "live" as const,
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId,
        workflowRuns: { revision: runs.length, runs },
      },
      subscriptionId: `sub-${sessionId}`,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    });

    projectionState.current = withRuns("session-1", []);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(false);

    // 0 → 1：打开。
    projectionState.current = withRuns("session-1", [liveRun]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(true);

    // 手动折起后，run 还在跑（再来一条也一样）就保持折起。
    act(() => scrollFocus.statusPanelProps?.onWorkflowSectionOpenChange?.(false));
    projectionState.current = withRuns("session-1", [liveRun, { ...liveRun, runId: "dwfrun-2" }]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(false);

    // 全部结束：折起；下一条 run 出现：重新打开。
    projectionState.current = withRuns("session-1", [{ ...liveRun, status: "completed" as never }]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(false);
    projectionState.current = withRuns("session-1", [{ ...liveRun, runId: "dwfrun-3" }]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(true);

    // 在一个有活 run 的会话里折起，再进入另一个也有活 run 的会话：新会话里是打开的。
    act(() => scrollFocus.statusPanelProps?.onWorkflowSectionOpenChange?.(false));
    projectionState.current = withRuns("session-2", [liveRun]);
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(true);
  });

  it("opens typed background sections and resets them independently", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const runningWork = {
      workId: "work-bash",
      kind: "bash" as const,
      title: "Run checks",
      status: "running" as const,
      startedAt: 1_700_000_000_000,
      anchorRowId: null,
    };
    const runningAgent = {
      ...runningWork,
      workId: "work-agent",
      kind: "subagent" as const,
      title: "Review changes",
    };
    const runningSubagents = [
      {
        childSessionId: "child-agent",
        subagentType: "Explore",
        title: "Review changes",
        status: "running",
        startedAt: 1_700_000_000_000,
      },
    ];
    projectionState.current = {
      status: "live",
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId: "session-1",
        backgroundWorks: [runningWork, runningAgent],
        subagents: {
          revision: 1,
          childSessionIds: ["child-agent"],
          running: runningSubagents,
          endedTotal: 0,
        },
      },
      subscriptionId: "sub-session-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(false);
    act(() => scrollFocus.composerProps?.onOpenRunningBackgroundWorks?.());
    expect(scrollFocus.statusPanelProps?.summaryPanelVariantOverride).toBe("panel");
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(true);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);

    act(() => scrollFocus.statusPanelProps?.onTerminalSectionOpenChange?.(false));
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);
    act(() => scrollFocus.composerProps?.onOpenRunningBackgroundWorks?.());
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(true);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);

    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        sessionId: "session-2",
        backgroundWorks: [runningWork, runningAgent],
      },
      subscriptionId: "sub-session-2",
    };
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(false);

    act(() => scrollFocus.composerProps?.onOpenRunningBackgroundWorks?.());
    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        backgroundWorks: [runningAgent],
      },
    };
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);

    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        backgroundWorks: [],
        subagents: {
          revision: 2,
          childSessionIds: [],
          running: [],
          endedTotal: 0,
        },
      },
    };
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(false);
    expect(scrollFocus.composerProps?.onOpenRunningBackgroundWorks).toBeUndefined();
  });
});
