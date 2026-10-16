import { act, createElement, type ComponentProps, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import {
  type ModelSelection,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  type ZCodeWorkspaceStateSnapshot,
} from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
  SessionModelTransition,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationComposer } from "@/v4/ConversationComposer.js";
import type { V4InteractionDialogsProps } from "@/v4/V4InteractionDialogs.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { logger } from "@/logger.js";

const recommendation = vi.hoisted(() =>
  vi.fn(async (selection: ModelSelection): Promise<ModelSelection | null> => selection),
);
vi.mock("@/hooks/useStartPlanRecommendation.js", () => ({
  useStartPlanRecommendation: () => recommendation,
}));
const modelSelectionMock = vi.hoisted(() => ({ view: null as ModelSelectionView | null }));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({
    state: modelSelectionMock.view
      ? { status: "ready", view: modelSelectionMock.view }
      : { status: "loading" },
    reload: vi.fn(),
  }),
  useModelSelectionServiceView: () => ({
    state: modelSelectionMock.view
      ? { status: "ready", view: modelSelectionMock.view }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 本组只验证模型恢复；群同步服务由独立组件测试和真实 Host/CLI E2E 覆盖。
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

type ComposerProps = ComponentProps<typeof ConversationComposer>;

function seedModelProviderNames(): void {
  modelSelectionMock.view = {
    revision: 1,
    providers: [
      {
        providerId: "primary-provider",
        providerName: "Primary Coding Plan",
        config: {},
        models: [],
      },
      {
        providerId: "alternate-provider",
        providerName: "Alternate API",
        config: {},
        models: [],
      },
    ],
  };
}

// 永不 resolve：这些文件不测发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const captured = vi.hoisted(() => ({
  composerProps: null as ComposerProps | null,
  interactionProps: null as V4InteractionDialogsProps | null,
}));

const draftConfigMock = vi.hoisted(() => ({
  draftConfigRef: { current: {} as Partial<SessionConfigState> },
  resolveInitialDraftConfig: vi.fn<() => Partial<SessionConfigState> | undefined>(),
  handleDraftSelectModel: vi.fn((provider: string, model: string) => {
    draftConfigMock.draftConfigRef.current = {
      ...draftConfigMock.draftConfigRef.current,
      provider,
      model,
      modelSelection: { providerId: provider, modelId: model, options: { reasoningLevel: "high" } },
    };
  }),
  handleDraftSelectThought: vi.fn((thought: string) => {
    draftConfigMock.draftConfigRef.current = {
      ...draftConfigMock.draftConfigRef.current,
      thought,
      modelSelection: draftConfigMock.draftConfigRef.current.modelSelection
        ? {
            ...draftConfigMock.draftConfigRef.current.modelSelection,
            options: { reasoningLevel: thought },
          }
        : undefined,
    };
  }),
  handleDraftSwitchMode: vi.fn((mode: SessionConfigState["mode"]) => {
    draftConfigMock.draftConfigRef.current = {
      ...draftConfigMock.draftConfigRef.current,
      mode,
    };
  }),
}));

const composerRecentMocks = vi.hoisted(() => ({
  acceptSubmission: vi.fn(),
}));

const prewarmHookMock = vi.hoisted(() => ({
  lastEnabled: null as boolean | null,
  binding: undefined as
    | {
        workspaceKey: string;
        sessionId: string;
        promote: () => void;
        discard: () => void;
      }
    | null
    | undefined,
}));

const modelTransitionMock = vi.hoisted(() => ({
  listener: null as ((transition: SessionModelTransition) => void) | null,
  onAcquire: null as (() => void) | null,
}));

const sessionOpenTelemetryMock = vi.hoisted(() => ({
  lastParams: null as null | { sessionId: string | null; enabled?: boolean },
}));

const mocks = vi.hoisted(() => ({
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
  recoverFromStaleAuthority: vi.fn(),
  layer: {
    acquire: vi.fn((sessionId: string) => {
      const lease = {
        sessionId,
        openKind: "cold" as const,
        startedAt: 0,
        store: {
          getState: vi.fn(() => ({
            snapshot: projectionState.current?.snapshot ?? null,
          })),
          markCommandPending: vi.fn(),
          expectAcceptedInputProjection: vi.fn(),
          recoverFromStaleAuthority: mocks.recoverFromStaleAuthority,
          onOnlineModelTransition: vi.fn(
            (listener: (transition: SessionModelTransition) => void) => {
              modelTransitionMock.listener = listener;
              return () => {
                if (modelTransitionMock.listener === listener) {
                  modelTransitionMock.listener = null;
                }
              };
            },
          ),
          onLiveDeltas: vi.fn(() => () => {}),
          refreshPlans: vi.fn(async () => {}),
          settleCommand: vi.fn(),
        },
        release: vi.fn(),
      };
      modelTransitionMock.onAcquire?.();
      return lease;
    }),
  },
  sendCommand: vi.fn(),
  attachmentPut: vi.fn(),
  modelSelectionService: {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [
        {
          providerId: "alternate-provider",
          config: { kind: "api" as const },
          models: [{ modelId: "deepseek-v4-pro", config: {} }],
        },
      ],
    })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    validate: vi.fn(),
  },
  zcodeSessionService: {
    getWorkspaceRuntimeIdentity: vi.fn(async () => ({
      identity: "runtime-1",
      workspaceKey: "remote:ssh:dev:/workspace",
    })),
    updateProviderRegistry: vi.fn(async () => ({
      providerCount: 1,
      status: "applied" as const,
    })),
    readWorkspacePresentation: vi.fn(async () => ({
      workspace: makeWorkspaceStateSnapshot().workspace,
      mode: "build" as const,
      slashCommands: [],
    })),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(async () => {}),
  },
  toast: vi.fn(),
}));

const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot | null;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

// Bugfix：本文件只验证 SessionPane 的模型恢复，隔离闲时入口对真实 TabStore 的依赖。
vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));

// 同理隔离推荐提示词容器：它通过 useWorkspaceServicesResolution 依赖 TabStoreProvider，
// 而本文件只验证草稿 provider/model 恢复链路，不提供 Tab store。
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => ({
    highspeedCardService: mocks.highspeedCardService,
    modelSelectionService: mocks.modelSelectionService,
    zcodeSessionService: mocks.zcodeSessionService,
    zcodeTaskService: mocks.zcodeTaskService,
  }),
}));

vi.mock("@/lib/composerRecent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composerRecent.js")>()),
  captureComposerRecentSubmission:
    (
      ...args: Parameters<typeof import("@/lib/composerRecent.js").captureComposerRecentSubmission>
    ) =>
    () =>
      composerRecentMocks.acceptSubmission(...args),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/composer/useDraftSessionPrewarm.js")>();
  return {
    ...actual,
    useDraftSessionPrewarm: (params: Parameters<typeof actual.useDraftSessionPrewarm>[0]) => {
      prewarmHookMock.lastEnabled = params.enabled;
      // 每个挂载实例冻结 mock/真实分支，避免测试在 rerender 中修改全局 binding
      // 导致 Hook 数量变化；生产 hook 本身不存在这个测试替身问题。
      const useActual = useRef(prewarmHookMock.binding === undefined).current;
      return useActual
        ? actual.useDraftSessionPrewarm(params)
        : {
            binding: prewarmHookMock.binding
              ? { beginPromotion: () => true, ...prewarmHookMock.binding }
              : null,
          };
    },
  };
});

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: {
      modelProviderFamilySelectedKeys: { bigmodel: "team-plan-key" },
      zcodeInteractionBehavior: "queue",
    },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/telemetry/useSessionOpenArmsTelemetry.js", () => ({
  useSessionOpenArmsTelemetry: (params: { sessionId: string | null; enabled?: boolean }) => {
    sessionOpenTelemetryMock.lastParams = params;
  },
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: mocks.layer,
    sendCommand: mocks.sendCommand,
    attachmentPut: mocks.attachmentPut,
    // SessionPane 挂载即拉 journal 兜底的 run 发现查询：缺桩会在 effect 里 TypeError；
    // 桩必须是稳定引用——effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/composer/useDraftConfigControl.js")>();
  return {
    ...actual,
    useDraftConfigControl: () => ({
      modelSelectionRead: useModelSelectionServiceView(null),
      captureAcceptedModelSelection: () => vi.fn(),
      composerDraft: { text: "", updatedAt: 0 },
      draftConfig: draftConfigMock.draftConfigRef.current,
      draftConfigRef: draftConfigMock.draftConfigRef,
      draftConfigSeedSignal: 0,
      resolveInitialDraftConfig: draftConfigMock.resolveInitialDraftConfig,
      handleDraftSelectModel: draftConfigMock.handleDraftSelectModel,
      handleDraftSelectThought: draftConfigMock.handleDraftSelectThought,
      handleDraftSwitchMode: draftConfigMock.handleDraftSwitchMode,
      promoteComposerDraft: vi.fn(),
      replaceComposerDraft: vi.fn(),
      updateComposerContent: vi.fn(),
    }),
  };
});

vi.mock("@/components/ui/toast.js", () => ({
  toast: mocks.toast,
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: ComposerProps) => {
      captured.composerProps = props;
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
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
    ConversationTimeline: ({ bottomDock }: { bottomDock?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-timeline" }, bottomDock),
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
    V4InteractionDialogs: (props: V4InteractionDialogsProps) => {
      captured.interactionProps = props;
      return React.createElement("div", { "data-testid": "mock-interactions" });
    },
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
    addEventListener: vi.fn(),
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
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function ackFor(envelope: CommandEnvelope, patch: Partial<CommandAck>): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: envelope.baseRevision ?? 0,
    ...patch,
  };
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
    config: {
      provider: "primary-provider",
      model: "deepseek-v4-flash",
      thought: "high",
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
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function makePlanPendingSnapshot(): ConversationSnapshot {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    control: {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "tool",
    },
    pendingInteractions: [
      {
        interactionId: "plan-request-1",
        kind: "userInput",
        anchorRowId: 5,
        createdAt: 300,
        payload: {
          kind: "userInput",
          prompt: "Review this implementation plan.",
          freeText: true,
          toolName: "ExitPlanMode",
          toolCallId: "exit-plan-1",
          questions: [
            {
              question: "Review this implementation plan.",
              header: "Plan",
              options: [{ value: "approve", label: "Approve" }],
            },
          ],
        },
      },
    ],
  };
}

function makeWorkspaceStateSnapshot(): ZCodeWorkspaceStateSnapshot {
  return {
    workspace: {
      workspacePath: "/workspace",
      workspaceIdentity: undefined,
      workspaceKey: "/workspace",
    },
    settings: {
      model: {
        current: { providerId: "alternate-provider", modelId: "deepseek-v4-pro" },
        available: [
          {
            ref: { providerId: "alternate-provider", modelId: "deepseek-v4-pro" },
            label: "DeepSeek V4 Pro",
          },
        ],
      },
      thoughtLevel: {
        enabled: true,
        current: "high",
        available: [{ value: "high", label: "High" }],
      },
      mode: { current: "build" },
    },
    slashCommands: [{ name: "compact", description: "Compact" }],
  };
}

function createPaneElement(props: Partial<ComponentProps<typeof SessionPane>> = {}) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(SessionPane, {
      paneId: "workspace-main",
      sessionId: "session-1",
      workspacePath: "/workspace",
      ...props,
    }),
  );
}

async function rerenderPane(root: Root, props: Partial<ComponentProps<typeof SessionPane>> = {}) {
  await act(async () => {
    root.render(createPaneElement(props));
    await flushMicrotasks();
  });
}

async function renderPane(props: Partial<ComponentProps<typeof SessionPane>> = {}) {
  // 本文件 mock 了 Composer owner。仅在 fixture 初始挂载时建立完整草稿，不能再让
  // 生产 Submission helper 从 Snapshot/平铺别名救活缺失的 fixture。
  const seed = {
    ...projectionState.current?.snapshot?.config,
    ...draftConfigMock.resolveInitialDraftConfig(),
    ...draftConfigMock.draftConfigRef.current,
  };
  draftConfigMock.draftConfigRef.current = {
    ...seed,
    mode: seed.mode ?? "build",
    modelSelection: seed.modelSelection ?? {
      providerId: seed.provider ?? "primary-provider",
      modelId: seed.model ?? "deepseek-v4-flash",
      options: { reasoningLevel: seed.thought || "high" },
    },
  };
  if (!modelSelectionMock.view) {
    modelSelectionMock.view = {
      revision: 1,
      providers: ["primary-provider", "alternate-provider", "e2e-deepseek"].map((providerId) => ({
        providerId,
        config: {},
        models: ["deepseek-v4-flash", "deepseek-v4-pro", "GLM-5.2"].map((modelId) => ({
          modelId,
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["off", "low", "high", "max"], map: "{}" },
            },
          },
        })),
      })),
    } as ModelSelectionView;
  }
  const root: Root = createRoot(installMinimalDom());
  await rerenderPane(root, props);
  return root;
}

afterEach(() => {
  recommendation.mockReset().mockImplementation(async (selection) => selection);
  modelSelectionMock.view = null;
  captured.composerProps = null;
  captured.interactionProps = null;
  draftConfigMock.draftConfigRef.current = {};
  draftConfigMock.resolveInitialDraftConfig.mockReset();
  draftConfigMock.handleDraftSelectModel.mockClear();
  draftConfigMock.handleDraftSelectThought.mockClear();
  draftConfigMock.handleDraftSwitchMode.mockClear();
  prewarmHookMock.binding = undefined;
  prewarmHookMock.lastEnabled = null;
  modelTransitionMock.listener = null;
  modelTransitionMock.onAcquire = null;
  sessionOpenTelemetryMock.lastParams = null;
  projectionState.current = null;
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.modelSelectionService.getView.mockImplementation(async () => ({
    revision: 1,
    providers: [
      {
        providerId: "alternate-provider",
        config: { kind: "api" as const },
        models: [{ modelId: "deepseek-v4-pro", config: {} }],
      },
    ],
  }));
});

describe("SessionPane draft provider readiness", () => {
  it("本地草稿预热不由 Host 解析 runtimeModel", async () => {
    prewarmHookMock.binding = null;
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "local-draft-runtime-model",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    });

    const root = await renderPane();
    await act(async () => root.unmount());
  });

  it("远端草稿预热只提交 config，由远端 Registry 创建 Model", async () => {
    prewarmHookMock.binding = null;
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "remote-draft-runtime-model",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    });

    const root = await renderPane({ workspaceIdentity: "remote:ssh:dev:/workspace" });
    await act(async () => root.unmount());
  });

  it("blocks first send before command dispatch when no model is available", async () => {
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "draft-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = null;
    mocks.modelSelectionService.getView.mockResolvedValue({
      revision: 2,
      providers: [],
    });

    const root = await renderPane({ sessionId: null });
    try {
      expect(prewarmHookMock.lastEnabled).toBe(false);
      expect(captured.composerProps?.error).toMatchObject({
        code: "model_config_missing",
      });

      let result: Awaited<ReturnType<ComposerProps["onSendText"]>>;
      await act(async () => {
        result = await captured.composerProps?.onSendText("keep this draft");
        await flushMicrotasks();
      });

      expect(result!).toBe("blocked");
      expect(mocks.sendCommand).not.toHaveBeenCalled();
      expect(captured.composerProps?.error).toMatchObject({
        code: "model_config_missing",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("settles the recovery ledger when Host wins the readiness race", async () => {
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = "draft-prewarm-provider-race";
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-race-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "draft-prewarm-provider-race",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    const providerNotReady = Object.assign(new Error("当前没有可用的模型供应商和模型"), {
      code: ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
    });
    mocks.sendCommand.mockRejectedValue(providerNotReady);

    const root = await renderPane({ sessionId: null });
    try {
      let result: Awaited<ReturnType<ComposerProps["onSendText"]>>;
      await act(async () => {
        result = await captured.composerProps?.onSendText("race-safe draft");
        await flushMicrotasks();
      });

      expect(result!).toBe("blocked");
      expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
      expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
        sessionId: "draft-prewarm-provider-race",
        type: "sendText",
      });
      expect(pendingCommandRegistry.list("draft-prewarm-provider-race")).toHaveLength(0);
      expect(captured.composerProps?.error).toMatchObject({
        code: "model_config_missing",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane send failure feedback", () => {
  it("surfaces provider.notInRegistry as a visible composer error", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "session-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockRejectedValue(
      new Error("switchModelConfig 未在首发前收敛: failed provider.notInRegistry"),
    );

    const root = await renderPane();
    try {
      await expect(
        act(async () => captured.composerProps?.onSendText("keep visible draft")),
      ).rejects.toThrow("provider.notInRegistry");
      await act(async () => flushMicrotasks());

      expect(captured.composerProps?.error).toMatchObject({
        code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
        detail: expect.stringContaining("provider.notInRegistry"),
      });
      await act(async () => {
        captured.composerProps?.onDismissError?.();
        await flushMicrotasks();
      });
      expect(captured.composerProps?.error).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane draft prewarm admission lifecycle", () => {
  it("只为已有 Session 打开埋点，不记录草稿预热提升的首次绑定", async () => {
    const prewarmSessionId = "draft-prewarm-session-open-excluded";
    const existingSessionId = "existing-session-open-included";
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = prewarmSessionId;
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-prewarm-session-open-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: prewarmSessionId,
      promote: vi.fn(),
      discard: vi.fn(),
    };
    const onSessionCreated = vi.fn();
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null, onSessionCreated });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("promote prewarm without session-open telemetry");
        await flushMicrotasks();
      });
      expect(onSessionCreated).toHaveBeenCalledWith(prewarmSessionId);

      await rerenderPane(root, { sessionId: prewarmSessionId, onSessionCreated });
      expect(sessionOpenTelemetryMock.lastParams).toMatchObject({
        sessionId: prewarmSessionId,
        enabled: false,
      });

      const existingSnapshot = makeSnapshot();
      existingSnapshot.sessionId = existingSessionId;
      projectionState.current = {
        ...projectionState.current,
        snapshot: existingSnapshot,
        subscriptionId: "existing-session-open-subscription",
      };
      prewarmHookMock.binding = null;
      await rerenderPane(root, { sessionId: existingSessionId, onSessionCreated });
      expect(sessionOpenTelemetryMock.lastParams).toMatchObject({
        sessionId: existingSessionId,
        enabled: true,
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["existing", "prewarm", "no-prewarm"] as const)(
    "keeps shared context and the complete submission together for %s",
    async (entry) => {
      const targetSessionId = entry === "existing" ? "session-1" : "share-created";
      const snapshot = makeSnapshot();
      snapshot.sessionId = targetSessionId;
      projectionState.current = {
        status: "live",
        snapshot: entry === "no-prewarm" ? null : snapshot,
        subscriptionId: "share-submission",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      prewarmHookMock.binding =
        entry === "prewarm"
          ? {
              workspaceKey: "/workspace",
              sessionId: targetSessionId,
              promote: vi.fn(),
              discard: vi.fn(),
            }
          : null;
      const modelSelection = {
        providerId: "alternate-provider",
        modelId: "deepseek-v4-pro",
        options: { reasoningLevel: "high" },
      };
      draftConfigMock.draftConfigRef.current = { modelSelection, mode: "build" };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
        ackFor(envelope, {
          status: "accepted",
          ...(envelope.type === "createSession"
            ? { result: { type: "createSession" as const, sessionId: targetSessionId } }
            : {}),
        }),
      );
      const root = await renderPane({ sessionId: entry === "existing" ? targetSessionId : null });
      try {
        await act(async () => {
          await captured.composerProps?.onSendText("继续分享上下文", {
            sharedContextRefs: [{ kind: "shared_context_import", context_id: "shared-1" }],
          });
          await flushMicrotasks();
        });
        const sends = mocks.sendCommand.mock.calls.filter(
          ([command]) => command.type === "sendText",
        );
        expect(sends).toHaveLength(1);
        expect(sends[0]?.[0]).toMatchObject({
          sessionId: targetSessionId,
          payload: {
            text: "继续分享上下文",
            modelSelection,
            mode: "build",
            context_refs: [{ kind: "shared_context_import", context_id: "shared-1" }],
          },
        });
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("不记录无预热 fallback createSession 的首次绑定", async () => {
    const createdSessionId = "fallback-created-session-open-excluded";
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "draft-without-prewarm-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = null;
    // 本用例验证无预热的 createSession 埋点边界；草稿仍必须具备生产提交所要求的完整执行配置。
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      mode: "build",
    });
    const onSessionCreated = vi.fn();
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: "accepted",
        ...(envelope.type === "createSession"
          ? { result: { type: "createSession" as const, sessionId: createdSessionId } }
          : {}),
      }),
    );

    const root = await renderPane({ sessionId: null, onSessionCreated });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("create without prewarm telemetry");
        await flushMicrotasks();
      });
      expect(onSessionCreated).toHaveBeenCalledWith(createdSessionId);

      const createdSnapshot = makeSnapshot();
      createdSnapshot.sessionId = createdSessionId;
      projectionState.current = {
        ...projectionState.current,
        snapshot: createdSnapshot,
        subscriptionId: "fallback-created-session-open-subscription",
      };
      await rerenderPane(root, { sessionId: createdSessionId, onSessionCreated });
      expect(sessionOpenTelemetryMock.lastParams).toMatchObject({
        sessionId: createdSessionId,
        enabled: false,
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    {
      caseName: "transport outcome is unknown",
      expectedError: "connection closed after command write",
      sendResult: "transport-error" as const,
    },
    {
      caseName: "projection commit timed out after runtime admission",
      expectedError: "fault.projectionEventCommit.timeout",
      sendResult: "failed-ack" as const,
    },
  ])(
    "does not resubmit first input when the prewarm sendText $caseName",
    async ({ expectedError, sendResult }) => {
      const prewarmSessionId = "draft-prewarm-unknown-send";
      const fallbackSessionId = "draft-prewarm-unknown-send-fallback";
      const prewarmSnapshot = makeSnapshot();
      prewarmSnapshot.sessionId = prewarmSessionId;
      projectionState.current = {
        status: "live",
        snapshot: prewarmSnapshot,
        subscriptionId: "draft-prewarm-unknown-send-subscription",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      const onSessionCreated = vi.fn();
      const discard = vi.fn();
      let unknownSendEnvelope: CommandEnvelope | null = null;
      prewarmHookMock.binding = {
        workspaceKey: "/workspace",
        sessionId: prewarmSessionId,
        promote: vi.fn(),
        discard,
      };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
        if (envelope.type === "sendText") {
          unknownSendEnvelope = envelope;
          if (sendResult === "failed-ack") {
            return ackFor(envelope, {
              status: "failed",
              reasonCode: "fault.projectionEventCommit.timeout",
            });
          }
          // Bug 复现：写入是否到达 Agent 未知，transport error 不能证明 command 未 admission。
          throw new Error("connection closed after command write");
        }
        if (envelope.type === "createSession") {
          return ackFor(envelope, {
            result: { type: "createSession", sessionId: fallbackSessionId },
          });
        }
        return ackFor(envelope, { status: "accepted" });
      });

      const root = await renderPane({ sessionId: null, onSessionCreated });
      try {
        let sendError: unknown;
        await act(async () => {
          try {
            await captured.composerProps?.onSendText("must execute exactly once");
          } catch (error) {
            sendError = error;
          }
          await flushMicrotasks();
        });

        expect(sendError).toMatchObject({
          message: expectedError,
        });
        expect(unknownSendEnvelope).toMatchObject({
          sessionId: prewarmSessionId,
          type: "sendText",
        });
        expect(
          mocks.sendCommand.mock.calls.filter(
            ([envelope]) => (envelope as CommandEnvelope).type === "createSession",
          ),
        ).toHaveLength(0);
        expect(discard).not.toHaveBeenCalled();
        expect(onSessionCreated).not.toHaveBeenCalled();
      } finally {
        if (unknownSendEnvelope) {
          await act(async () => {
            pendingCommandRegistry.settle(
              prewarmSessionId,
              (unknownSendEnvelope as CommandEnvelope).commandId,
            );
            await flushMicrotasks();
          });
        }
        await act(async () => root.unmount());
      }
    },
  );

  it("does not resubmit a draft slash command when its transport outcome is unknown", async () => {
    const prewarmSessionId = "draft-prewarm-unknown-slash";
    const fallbackSessionId = "draft-prewarm-unknown-slash-fallback";
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = prewarmSessionId;
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-prewarm-unknown-slash-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const onSessionCreated = vi.fn();
    const discard = vi.fn();
    let unknownSlashEnvelope: CommandEnvelope | null = null;
    let slashAttempts = 0;
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: prewarmSessionId,
      promote: vi.fn(),
      discard,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (envelope.type === "sendGoalCommand") {
        slashAttempts += 1;
        if (slashAttempts === 1) {
          unknownSlashEnvelope = envelope;
          throw new Error("connection closed after slash command write");
        }
        return ackFor(envelope, { status: "accepted" });
      }
      if (envelope.type === "createSession") {
        return ackFor(envelope, {
          result: { type: "createSession", sessionId: fallbackSessionId },
        });
      }
      return ackFor(envelope, { status: "accepted" });
    });

    const root = await renderPane({ sessionId: null, onSessionCreated });
    try {
      let sendError: unknown;
      await act(async () => {
        try {
          await captured.composerProps?.onSendText("/goal ship once");
        } catch (error) {
          sendError = error;
        }
        await flushMicrotasks();
      });

      expect(sendError).toMatchObject({
        message: "connection closed after slash command write",
      });
      expect(slashAttempts).toBe(1);
      expect(
        mocks.sendCommand.mock.calls.filter(
          ([envelope]) => (envelope as CommandEnvelope).type === "createSession",
        ),
      ).toHaveLength(0);
      expect(discard).not.toHaveBeenCalled();
      expect(onSessionCreated).not.toHaveBeenCalled();
    } finally {
      if (unknownSlashEnvelope) {
        await act(async () => {
          pendingCommandRegistry.settle(
            prewarmSessionId,
            (unknownSlashEnvelope as CommandEnvelope).commandId,
          );
          await flushMicrotasks();
        });
      }
      await act(async () => root.unmount());
    }
  });

  it("keeps an admitted prewarm session alive while the sendText ACK is pending", async () => {
    const prewarmSessionId = "draft-prewarm-send-pending";
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = prewarmSessionId;
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-prewarm-send-pending-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    let resolveSendText!: (ack: CommandAck) => void;
    let pendingSendEnvelope: CommandEnvelope | null = null;
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (envelope.type === "createSession") {
        return ackFor(envelope, {
          result: { type: "createSession", sessionId: prewarmSessionId },
        });
      }
      if (envelope.type === "sendText") {
        pendingSendEnvelope = envelope;
        return await new Promise<CommandAck>((resolve) => {
          resolveSendText = resolve;
        });
      }
      return ackFor(envelope, { status: "accepted" });
    });

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(
      mocks.sendCommand.mock.calls.some(
        ([envelope]) => (envelope as CommandEnvelope).type === "createSession",
      ),
    ).toBe(true);

    let sendPromise!: ReturnType<ComposerProps["onSendText"]>;
    act(() => {
      sendPromise = captured.composerProps!.onSendText("first input while MCP is starting");
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(pendingSendEnvelope).toMatchObject({
      sessionId: prewarmSessionId,
      type: "sendText",
    });

    // Bug 复现：Agent 已经 admission 首发，但 MCP 初始化让 renderer ACK 仍在途。
    // 此时 pane/owner cleanup 不能把运行中的预热会话当作未使用草稿删除。
    await act(async () => {
      root.unmount();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    });

    resolveSendText(ackFor(pendingSendEnvelope!, { status: "accepted" }));
    await act(async () => {
      await sendPromise;
      await flushMicrotasks();
    });

    expect(
      mocks.sendCommand.mock.calls.filter(
        ([envelope]) => (envelope as CommandEnvelope).type === "deleteSession",
      ),
    ).toHaveLength(0);
  });
});

describe("SessionPane stop foreground execution", () => {
  it.each(["button", "escape"] as const)(
    "forwards the execution id and records %s when stopping a goal verifier",
    async (source) => {
      const infoSpy = vi.spyOn(logger.lifecycle, "info");
      const running = makeSnapshot();
      running.control = {
        ...running.control,
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "goalVerifier",
        activeWorks: [
          {
            kind: "goalVerifier",
            foregroundExecutionId: "foreground-1",
            startedAt: 10,
          },
        ],
      };
      projectionState.current = {
        status: "live",
        snapshot: running,
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
        ackFor(envelope, { status: "accepted" }),
      );

      const root = await renderPane();
      await act(async () => {
        if (source === "button") {
          captured.composerProps?.onStop?.();
        } else {
          const listener = vi
            .mocked(window.addEventListener)
            .mock.calls.find(([type]) => type === "keydown")?.[1] as (event: KeyboardEvent) => void;
          expect(listener).toBeTypeOf("function");
          listener({
            key: "Escape",
            defaultPrevented: false,
            composedPath: () => [],
            preventDefault: vi.fn(),
          } as unknown as KeyboardEvent);
        }
        await flushMicrotasks();
      });

      expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
      expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
        type: "stop",
        payload: { expectedForegroundExecutionId: "foreground-1" },
      });
      // 普通 info 在生产禁用；停止归因必须走生命周期通道，同时保留执行 ID 防误停。
      expect(infoSpy).toHaveBeenCalledWith("[v4-pane] stop 命令发出", {
        source,
        sessionId: "session-1",
        foregroundExecutionId: "foreground-1",
      });
      await act(async () => {
        root.unmount();
      });
    },
  );

  it("records a skipped button stop without dispatching for an idle session", async () => {
    const infoSpy = vi.spyOn(logger.lifecycle, "info");
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-idle",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane();
    try {
      await act(async () => {
        captured.composerProps?.onStop?.();
        await flushMicrotasks();
      });
      expect(mocks.sendCommand).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith("[v4-pane] stop 命令被跳过（无可停执行）", {
        source: "button",
        sessionId: "session-1",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane remote provider admission", () => {
  it("desktop remote runtime 重建后直接发送模型命令，由远端 Registry 自行恢复", async () => {
    const workspaceIdentity = "remote:ssh:dev:/workspace";
    const remoteSessionId = "remote-session-stable";
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "remote-provider-recovery-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    mocks.zcodeSessionService.updateProviderRegistry.mockClear();
    mocks.sendCommand.mockClear();

    const root = await renderPane({ workspaceIdentity, remoteSessionId });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("recover remote runtime");
        await flushMicrotasks();
      });

      expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
      expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "sendText" }));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("本地 desktop workspace 不触发远端 provider registry 同步", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "local-provider-admission-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    mocks.zcodeSessionService.updateProviderRegistry.mockClear();

    const root = await renderPane();
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("local project remains local");
        await flushMicrotasks();
      });

      expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
      expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "sendText" }));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("mobile web remote replayable pane 不复用 desktop provider preflight", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "mobile-provider-admission-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    mocks.zcodeSessionService.updateProviderRegistry.mockClear();

    const root = await renderPane({
      workspaceIdentity: "remote:ssh:dev:/workspace",
      remoteSessionId: "remote-session-mobile",
      compactForRemoteControl: true,
    });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("mobile remote command");
        await flushMicrotasks();
      });

      expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
      expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "sendText" }));
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane mobile plan approval recovery", () => {
  it("recovers authoritative state when an accepted mobile plan interaction stays pending", async () => {
    vi.useFakeTimers();
    projectionState.current = {
      status: "live",
      snapshot: makePlanPendingSnapshot(),
      subscriptionId: "mobile-plan-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ compactForRemoteControl: true });
    try {
      expect(captured.interactionProps?.onPlanInteractionAccepted).toBeTypeOf("function");

      act(() => {
        captured.interactionProps?.onPlanInteractionAccepted?.("plan-request-1");
        captured.interactionProps?.onPlanInteractionAccepted?.("plan-request-1");
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(mocks.recoverFromStaleAuthority).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.recoverFromStaleAuthority).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("skips recovery when the mobile plan interaction clears during the grace window", async () => {
    vi.useFakeTimers();
    projectionState.current = {
      status: "live",
      snapshot: makePlanPendingSnapshot(),
      subscriptionId: "mobile-plan-natural-clear-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ compactForRemoteControl: true });
    try {
      act(() => {
        captured.interactionProps?.onPlanInteractionAccepted?.("plan-request-1");
      });
      projectionState.current = {
        ...projectionState.current,
        snapshot: {
          ...projectionState.current.snapshot!,
          pendingInteractions: [],
        },
      };

      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.recoverFromStaleAuthority).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not register plan reconciliation for desktop continuous panes", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makePlanPendingSnapshot(),
      subscriptionId: "desktop-plan-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ compactForRemoteControl: false });
    try {
      expect(captured.interactionProps?.onPlanInteractionAccepted).toBeUndefined();
      expect(mocks.recoverFromStaleAuthority).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane model switch recovery", () => {
  it("does not lose an online fallback between lease acquisition and listener registration", async () => {
    seedModelProviderNames();
    const fallbackSnapshot = makeSnapshot();
    fallbackSnapshot.config = {
      ...fallbackSnapshot.config,
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    };
    projectionState.current = {
      status: "live",
      snapshot: fallbackSnapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const transition: SessionModelTransition = {
      eventId: "fallback-before-next-effect",
      origin: "registryFallback",
      from: {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      },
      to: {
        provider: "alternate-provider",
        model: "deepseek-v4-pro",
      },
    };
    modelTransitionMock.onAcquire = () => {
      queueMicrotask(() => modelTransitionMock.listener?.(transition));
    };

    // act 会在该 microtask 前冲刷下一轮 effect，掩盖生产调度中的 listener 空窗。
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const root = createRoot(installMinimalDom());
    try {
      root.render(createPaneElement());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      // 自动 fallback 只修正当前执行事实；App Recent 只能由接受的普通 Submission 写入。
      expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("I56：聚焦 pane 的自动 fallback 复用手动切换 toast，后台 pane 不提示", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const transition: SessionModelTransition = {
      eventId: "event-fallback",
      origin: "registryFallback",
      from: { provider: "primary-provider", model: "deepseek-v4-flash" },
      to: { provider: "alternate-provider", model: "deepseek-v4-pro" },
    };
    const root = await renderPane();
    try {
      await act(async () => {
        modelTransitionMock.listener?.(transition);
        await flushMicrotasks();
      });
      expect(mocks.toast).toHaveBeenCalledWith(
        "已从 Primary Coding Plan/deepseek-v4-flash 切换至 Alternate API/deepseek-v4-pro",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
    }

    mocks.toast.mockClear();
    modelTransitionMock.listener = null;
    const backgroundRoot = await renderPane({ focused: false });
    try {
      await act(async () => {
        modelTransitionMock.listener?.(transition);
        await flushMicrotasks();
      });
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        backgroundRoot.unmount();
      });
    }
  });

  it("Highspeed 降级行按 fallbackReason 区分 Toast 文案；旧数据无原因时按卡过期处理", async () => {
    // docs/highspeed/highspeed-card-spec.md §2.2：卡过期与加速服务不可用分别提示，且每轮只提示一次。
    const fallbackAt = Date.now();
    const highspeedRow = (
      sourceCommandId: string,
      fallbackReason: "highspeed_card_expired" | "highspeed_request_failed" | undefined,
    ): ConversationSnapshot["rows"]["window"][number] => ({
      rowId: 1,
      turnId: "turn-1",
      createdAt: fallbackAt - 1_000,
      createdAtSeq: 1,
      kind: "userInput",
      text: "accelerated prompt",
      origin: "realUser",
      sourceCommandId,
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: fallbackAt - 60_000,
        expiresAt: fallbackAt + 60_000,
        fallbackAt,
        ...(fallbackReason ? { fallbackReason } : {}),
      },
    });
    const renderWithRow = async (
      row: ConversationSnapshot["rows"]["window"][number],
    ): Promise<Root> => {
      const snapshot = makeSnapshot();
      projectionState.current = {
        status: "live",
        snapshot: { ...snapshot, rows: { window: [row], totalCount: 1, firstRowId: 1 } },
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      return renderPane();
    };

    const failedRoot = await renderWithRow(
      highspeedRow("command-hs-request-failed", "highspeed_request_failed"),
    );
    try {
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(mocks.toast).toHaveBeenCalledWith(
        "加速服务暂不可用，本轮后续内容将使用原模型继续生成",
      );
    } finally {
      await act(async () => {
        failedRoot.unmount();
      });
    }

    mocks.toast.mockClear();
    const expiredRoot = await renderWithRow(
      highspeedRow("command-hs-card-expired", "highspeed_card_expired"),
    );
    try {
      expect(mocks.toast).toHaveBeenCalledWith("加速卡已到期，本轮后续内容将使用原模型继续生成");
    } finally {
      await act(async () => {
        expiredRoot.unmount();
      });
    }

    mocks.toast.mockClear();
    const legacyRoot = await renderWithRow(highspeedRow("command-hs-legacy", undefined));
    try {
      expect(mocks.toast).toHaveBeenCalledWith("加速卡已到期，本轮后续内容将使用原模型继续生成");
    } finally {
      await act(async () => {
        legacyRoot.unmount();
      });
    }

    // 同一 sourceCommandId 重挂载不重复提示（模块级 claim）。
    mocks.toast.mockClear();
    const remountRoot = await renderWithRow(highspeedRow("command-hs-legacy", undefined));
    try {
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        remountRoot.unmount();
      });
    }
  });

  it("does not show an automatic fallback toast for a draft prewarm session", async () => {
    seedModelProviderNames();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "draft-fallback-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const transition: SessionModelTransition = {
      eventId: "draft-fallback",
      origin: "registryFallback",
      from: { provider: "primary-provider", model: "deepseek-v4-flash" },
      to: { provider: "alternate-provider", model: "deepseek-v4-pro" },
    };

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      modelTransitionMock.listener?.(transition);
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a model-change toast for a draft before prewarm projection", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "draft-catalog-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a model-change toast for a draft with stale prewarm projection", async () => {
    seedModelProviderNames();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    draftConfigMock.draftConfigRef.current = {
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "stale-prewarm-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      captured.composerProps?.onSelectModel("primary-provider", "GLM-5.2", {
        provider: "alternate-provider",
        model: "deepseek-v4-pro",
      });
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps an existing-session model choice in the Composer until submit", async () => {
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      await captured.composerProps?.onSendText("use the selected model");
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      payload: {
        text: "use the selected model",
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "deepseek-v4-pro",
        },
        mode: "build",
      },
    });
    expect(composerRecentMocks.acceptSubmission).toHaveBeenCalledWith(
      "/workspace",
      {
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "deepseek-v4-pro",
          options: { reasoningLevel: "high" },
        },
        mode: "build",
        planEnabled: false,
      },
      undefined,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("加速轮 accepted 后 Recent 记录 Composer 原始选择，不记隐藏加速 Provider（spec §5.1）", async () => {
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    // 抽中卡：execution 携带隐藏加速 Provider 的执行 Selection，会覆盖 payload.modelSelection。
    mocks.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: {
        cardId: "card-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
      },
      nextDrawAt: Date.now() + 60_000,
      execution: {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        requestAuth: { apiKey: "jwt", headers: {} },
        selectionFallback: {
          providerId: "account:zai-highspeed-card",
          rules: [
            { reason: "highspeed_card_expired", providerErrorCode: "3402" },
            { reason: "highspeed_request_failed" },
          ],
        },
      },
    });

    const root = await renderPane();
    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    await act(async () => {
      await captured.composerProps?.onSendText("accelerated turn keeps recent on the original");
      await flushMicrotasks();
    });

    // payload 的 Selection 确已被执行材料覆盖为隐藏加速 Provider（证明本轮真的加速）。
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      payload: {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        mode: "build",
      },
    });
    // Recent 只记发送前 Composer 冻结的原始选择；否则新任务草稿种子解析为空选择器。
    expect(composerRecentMocks.acceptSubmission).toHaveBeenCalledWith(
      "/workspace",
      {
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "deepseek-v4-pro",
          options: { reasoningLevel: "high" },
        },
        mode: "build",
        planEnabled: false,
      },
      undefined,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it.each(["accepted", "rejected", "failed", "duplicate"] as const)(
    "运行中提交的 %s ACK 只在 accepted 时记住提交瞬间的权限",
    async (status) => {
      const running = makeSnapshot();
      running.control = { ...running.control, phase: "running", canStop: true };
      running.inputRouting = { mode: "enqueue" };
      projectionState.current = {
        status: "live",
        snapshot: running,
        subscriptionId: "recent-mode",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      let settle!: () => void;
      mocks.sendCommand.mockImplementationOnce(
        (envelope: CommandEnvelope) =>
          new Promise((resolve) => {
            settle = () =>
              resolve(
                ackFor(envelope, {
                  status,
                  ...(status === "rejected" || status === "failed"
                    ? { reasonCode: "test_failure" }
                    : {}),
                }),
              );
          }),
      );
      const root = await renderPane();
      act(() => draftConfigMock.handleDraftSwitchMode("yolo"));
      let pending: unknown;
      await act(async () => {
        pending = captured.composerProps?.onSendText("queued permission preference");
        await flushMicrotasks();
      });
      expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
      act(() => draftConfigMock.handleDraftSwitchMode("plan"));
      await act(async () => {
        settle();
        if (status === "accepted") await pending;
        else await expect(pending).rejects.toThrow();
      });
      if (status === "accepted") {
        expect(composerRecentMocks.acceptSubmission).toHaveBeenCalledExactlyOnceWith(
          "/workspace",
          expect.objectContaining({ mode: "yolo" }),
          undefined,
        );
      } else {
        expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
      }
      expect(draftConfigMock.draftConfigRef.current.mode).toBe("plan");
      act(() => root.unmount());
      const envelope = mocks.sendCommand.mock.calls[0]![0];
      pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
    },
  );

  it("preserves the initial draft config when immediate first send races a pending prewarm", async () => {
    const initialConfig: Partial<SessionConfigState> = {
      modelSelection: {
        providerId: "e2e-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "high" },
      },
      provider: "e2e-deepseek",
      model: "deepseek-v4-flash",
      thought: "high",
      mode: "build",
      followupMode: "queue",
    };
    draftConfigMock.draftConfigRef.current = {};
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue(initialConfig);
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    let resolvePrewarm!: (ack: CommandAck) => void;
    const pendingPrewarm = new Promise<CommandAck>((resolve) => {
      resolvePrewarm = resolve;
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (mocks.sendCommand.mock.calls.length === 1) {
        return pendingPrewarm;
      }
      return ackFor(envelope, {
        result: { type: "createSession", sessionId: "fallback-session" },
      });
    });

    const root = await renderPane({ sessionId: null });
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "createSession",
      payload: { workspaceId: "/workspace", config: initialConfig },
    });

    await act(async () => {
      await captured.composerProps?.onSendText("immediate first input");
      await flushMicrotasks();
    });

    // Highspeed 抽卡依赖真实 taskId，首发先创建空 session，再按统一 sendText admission 发送。
    expect(mocks.sendCommand).toHaveBeenCalledTimes(3);
    expect(mocks.sendCommand.mock.calls[1]?.[0]).toMatchObject({
      type: "createSession",
      payload: {
        workspaceId: "/workspace",
        config: initialConfig,
      },
    });
    expect(mocks.sendCommand.mock.calls[1]?.[0]).not.toMatchObject({
      payload: { config: { provider: "builtin" } },
    });
    expect(mocks.sendCommand.mock.calls[2]?.[0]).toMatchObject({
      type: "sendText",
      payload: { text: "immediate first input" },
    });

    resolvePrewarm(
      ackFor(mocks.sendCommand.mock.calls[0]?.[0] as CommandEnvelope, {
        status: "failed",
        reasonCode: "test.prewarmCancelled",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
      root.unmount();
    });
  });

  it("prewarm 的迟到模型事件不覆盖 Composer，本次发送保持用户选择", async () => {
    const promote = vi.fn();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote,
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const selection = {
      providerId: "primary-provider",
      modelId: "deepseek-v4-flash",
      options: { reasoningLevel: "high" },
    };
    draftConfigMock.draftConfigRef.current = { mode: "build", modelSelection: selection };
    // Todo71：prewarm 只消费配置，不再拥有 Composer 选择；真正失效由 Ready View 留空。
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "primary-provider",
      model: "deepseek-v4-flash",
      thought: "max",
      mode: "build",
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null });
    const fallbackSnapshot = makeSnapshot();
    fallbackSnapshot.config = {
      ...fallbackSnapshot.config,
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    };
    projectionState.current = {
      ...projectionState.current,
      snapshot: fallbackSnapshot,
    };
    // 普通 snapshot 差异不具备 delivery 来源，不能推断成自动 fallback。
    await rerenderPane(root, { sessionId: null });

    await act(async () => {
      modelTransitionMock.listener?.({
        eventId: "fallback-prewarm-1",
        origin: "registryFallback",
        from: {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
        to: {
          provider: "alternate-provider",
          model: "deepseek-v4-pro",
        },
      });
      await flushMicrotasks();
    });

    expect(draftConfigMock.draftConfigRef.current.modelSelection).toEqual(selection);
    expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
    await act(async () => {
      await captured.composerProps?.onSendText("first input after fallback");
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      sessionId: "session-1",
      payload: { text: "first input after fallback", modelSelection: selection, mode: "build" },
    });
    expect(mocks.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "switchModelConfig",
        payload: expect.objectContaining({
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        }),
      }),
    );
    expect(promote).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("promotes only an online same-session fallback, not a snapshot navigation", async () => {
    const initial = makeSnapshot();
    projectionState.current = {
      status: "live",
      snapshot: initial,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane();

    const fallback = makeSnapshot();
    fallback.revision = 8;
    fallback.config = {
      ...fallback.config,
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    };
    projectionState.current = {
      ...projectionState.current,
      snapshot: fallback,
    };
    await rerenderPane(root);

    await act(async () => {
      modelTransitionMock.listener?.({
        eventId: "fallback-session-1",
        origin: "registryFallback",
        from: {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
        to: {
          provider: "alternate-provider",
          model: "deepseek-v4-pro",
        },
      });
      await flushMicrotasks();
    });
    expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();

    const historical = makeSnapshot();
    historical.sessionId = "session-2";
    historical.revision = 9;
    historical.config = {
      ...historical.config,
      provider: "third-provider",
      model: "historical-model",
      thought: "max",
    };
    projectionState.current = {
      ...projectionState.current,
      snapshot: historical,
    };
    await rerenderPane(root, { sessionId: "session-2" });
    expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("submits an explicit draft intent atomically on first send", async () => {
    const promote = vi.fn();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote,
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    draftConfigMock.draftConfigRef.current = {
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
      mode: "yolo",
    };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "stale-provider",
      model: "stale-model",
      thought: "max",
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      await captured.composerProps?.onSendText("first input with explicit intent");
      await flushMicrotasks();
    });

    const envelopes = mocks.sendCommand.mock.calls.map(([envelope]) => envelope);
    expect(envelopes.at(-1)).toMatchObject({
      type: "sendText",
      payload: {
        text: "first input with explicit intent",
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "deepseek-v4-pro",
          options: { reasoningLevel: "high" },
        },
        mode: "yolo",
      },
    });
    expect(envelopes.some((envelope) => envelope.type === "switchModelConfig")).toBe(false);
    expect(envelopes.some((envelope) => envelope.type === "switchCollaborationMode")).toBe(false);
    expect(promote).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not dispatch or recover provider state when only the Composer selection changes", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane({ remoteSessionId: "remote-session-1" });

    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("本地 Registry 拒绝模型时不使用旧 Provider Snapshot 恢复", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "local-registry-rejection-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: "failed",
        reasonCode: "provider.notInRegistry",
        revisionAtDecision: 7,
      }),
    );

    const root = await renderPane();

    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await expect(captured.composerProps?.onSendText("local registry rejection")).rejects.toThrow(
        "provider.notInRegistry",
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("远端 Registry 拒绝模型时不注入 Desktop runtimeModel 重试", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      const callIndex = mocks.sendCommand.mock.calls.length;
      if (callIndex === 1) {
        return ackFor(envelope, {
          status: "failed",
          reasonCode: "provider.notInRegistry",
          revisionAtDecision: 7,
        });
      }
      return ackFor(envelope, {
        status: "failed",
        reasonCode: "provider.notInRegistry",
        revisionAtDecision: 7,
      });
    });

    const root = await renderPane({ remoteSessionId: "remote-session-1" });

    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await expect(captured.composerProps?.onSendText("remote registry rejection")).rejects.toThrow(
        "provider.notInRegistry",
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("recovers configOptions after a custom provider selection from prepare error", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockResolvedValue(undefined);

    const root = await renderPane();

    await act(async () => {
      await captured.composerProps?.onRecoverCustomModelSelection?.(
        "custom:alternate-provider:deepseek-v4-pro",
        {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "已从 Primary Coding Plan/deepseek-v4-flash 切换至 Alternate API/deepseek-v4-pro",
    );
    expect(draftConfigMock.handleDraftSelectModel).toHaveBeenCalledWith(
      "alternate-provider",
      "deepseek-v4-pro",
    );
    expect(mocks.zcodeTaskService.restartWorkspaceProcess).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: undefined,
      provider: "glm",
      bumpRuntimeEpoch: true,
    });
    expect(mocks.zcodeTaskService.restartWorkspaceProcess.mock.invocationCallOrder[0]).toBeLessThan(
      draftConfigMock.handleDraftSelectModel.mock.invocationCallOrder[0] ?? 0,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("自定义模型恢复重新构造目标 Provider/Model Selection", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "provider-aware-custom-recovery",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane();
    await act(async () => {
      await captured.composerProps?.onRecoverCustomModelSelection?.(
        "custom:alternate-provider:deepseek-v4-pro",
        { provider: "primary-provider", model: "deepseek-v4-flash" },
      );
      await flushMicrotasks();
    });

    expect(draftConfigMock.handleDraftSelectModel).toHaveBeenCalledWith(
      "alternate-provider",
      "deepseek-v4-pro",
    );
    await act(async () => root.unmount());
  });

  it("does not show a custom provider recovery toast for a draft", async () => {
    seedModelProviderNames();
    prewarmHookMock.binding = null;
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "draft-custom-recovery",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockResolvedValue(undefined);

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      await captured.composerProps?.onRecoverCustomModelSelection?.(
        "custom:alternate-provider:deepseek-v4-pro",
        {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
      );
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});

describe("SessionPane compact blocked feedback", () => {
  it.each([
    ["activeTurn", "运行中不能压缩上下文，请等待当前任务结束。"],
    ["compactOperationLock", "已有压缩任务正在运行或排队。"],
  ])("shows a toast when /compact is rejected with %s", async (reasonCode, expectedToast) => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: "failed",
        reasonCode,
      }),
    );

    const root = await renderPane();

    await act(async () => {
      await captured.composerProps?.onSendText("/compact");
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "compact",
    });
    expect(Object.hasOwn(mocks.sendCommand.mock.calls[0]?.[0] ?? {}, "baseRevision")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expectedToast);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an accepted toast when running /compact enters the FIFO", async () => {
    const running = makeSnapshot();
    running.control = {
      ...running.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
    };
    running.inputRouting = { mode: "enqueue" };
    projectionState.current = {
      status: "live",
      snapshot: running,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    await act(async () => {
      await captured.composerProps?.onSendText("/compact");
      await flushMicrotasks();
    });

    expect(mocks.toast).toHaveBeenCalledWith("已加入队列，将按顺序压缩上下文。");
    await act(async () => {
      root.unmount();
    });
  });
});

describe("SessionPane /plan shortcut", () => {
  it("已有会话的 /plan 通过单条 Submission 携带模式，不先发配置 CAS", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/plan 帮我做 X");
      await flushMicrotasks();
    });

    expect(sendResult).toBe("sent");
    const envelopes = mocks.sendCommand.mock.calls.map(([envelope]) => envelope);
    expect(envelopes.map((envelope) => envelope.type)).toEqual(["sendText"]);
    expect(envelopes[0]).toMatchObject({
      payload: { text: "帮我做 X", mode: "build", planEnabled: true },
    });

    await act(async () => root.unmount());
  });

  it("已经处于 Plan 模式时也只发送本次 Submission", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: envelope.type === "switchCollaborationMode" ? "noop" : "accepted",
      }),
    );

    const root = await renderPane();
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/plan 继续整理");
      await flushMicrotasks();
    });

    expect(sendResult).toBe("sent");
    expect(mocks.sendCommand.mock.calls.map(([envelope]) => envelope.type)).toEqual(["sendText"]);

    await act(async () => root.unmount());
  });

  it("/plan 请求被接纳边界拒绝时把错误交还 Composer 保留输入", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "failed", reasonCode: "admission.denied" }),
    );

    const root = await renderPane();
    await act(async () => {
      await expect(captured.composerProps?.onSendText("/plan 保留草稿")).rejects.toThrow(
        "admission.denied",
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      payload: { mode: "build", planEnabled: true, text: "保留草稿" },
    });

    await act(async () => root.unmount());
  });

  it("consumes an empty existing-session shortcut without sending a prompt", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/plan");
      await flushMicrotasks();
    });

    expect(sendResult).toBe("sent");
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(draftConfigMock.handleDraftSwitchMode).toHaveBeenCalledWith("plan");

    await act(async () => root.unmount());
  });

  it("updates draft mode and keeps the empty shortcut local", async () => {
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({});
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        result: { type: "createSession", sessionId: "should-not-create" },
      }),
    );

    const root = await renderPane({ sessionId: null });
    const callsBeforeSubmit = mocks.sendCommand.mock.calls.length;
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/plan");
      await flushMicrotasks();
    });

    expect(sendResult).toBe("sent");
    expect(draftConfigMock.handleDraftSwitchMode).toHaveBeenCalledWith("plan");
    expect(mocks.sendCommand.mock.calls.length).toBe(callsBeforeSubmit);

    await act(async () => root.unmount());
  });

  it("carries draft Plan intent through session creation and the first sendText", async () => {
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = null;
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
    });
    draftConfigMock.handleDraftSwitchMode.mockImplementation((mode: string) => {
      draftConfigMock.draftConfigRef.current = {
        ...draftConfigMock.draftConfigRef.current,
        mode,
      };
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { result: { type: "createSession", sessionId: "created-plan" } }),
    );

    const root = await renderPane({ sessionId: null });
    try {
      const callsBeforeSubmit = mocks.sendCommand.mock.calls.length;
      let sendResult: unknown;
      await act(async () => {
        sendResult = await captured.composerProps?.onSendText("/plan 先列出步骤");
        await flushMicrotasks();
      });

      expect(sendResult).toBe("sent");
      const submitted = mocks.sendCommand.mock.calls.slice(callsBeforeSubmit);
      expect(submitted).toHaveLength(2);
      expect(submitted[0]?.[0]).toMatchObject({
        type: "createSession",
        payload: {
          config: { mode: "plan" },
        },
      });
      expect(submitted[1]?.[0]).toMatchObject({
        type: "sendText",
        payload: { text: "先列出步骤" },
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("blocks an attachment-bearing shortcut before changing mode", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane();
    const callsBeforeSubmit = mocks.sendCommand.mock.calls.length;
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/plan 检查附件", {
        attachments: [
          { ref: "zcode-artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
        ],
      });
      await flushMicrotasks();
    });

    expect(sendResult).toBe("blocked");
    expect(mocks.sendCommand.mock.calls.length).toBe(callsBeforeSubmit);
    expect(mocks.toast).toHaveBeenCalledWith("首版 /plan 仅支持纯文本，请移除附件或上下文后重试。");

    await act(async () => root.unmount());
  });
});

describe("SessionPane Plan mode goal guard", () => {
  it.each(["/goal", "/goal 保留这段输入", "/target 保留别名输入", "/goal resume"])(
    "blocks %s before any conversation command is dispatched",
    async (command) => {
      const planSnapshot = makeSnapshot();
      planSnapshot.config.mode = "plan";
      projectionState.current = {
        status: "live",
        snapshot: planSnapshot,
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };

      const root = await renderPane();
      let sendResult: unknown;
      await act(async () => {
        sendResult = await captured.composerProps?.onSendText(command);
        await flushMicrotasks();
      });

      expect(sendResult).toBe("blocked");
      expect(mocks.sendCommand).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith("Goal 无法在 Plan 模式下使用，请切换模式。");

      await act(async () => {
        root.unmount();
      });
    },
  );

  it("keeps the existing goal command path outside Plan mode", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/goal 正常目标");
      await flushMicrotasks();
    });

    expect(sendResult).toBe("sent");
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendGoalCommand",
      payload: {
        text: "正常目标",
        displayText: "/goal 正常目标",
      },
    });
    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not promote a Plan-mode draft when /goal is blocked", async () => {
    draftConfigMock.draftConfigRef.current = { mode: "plan" };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({ mode: "plan" });
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        result: { type: "createSession", sessionId: "prewarm-plan-session" },
      }),
    );
    const onSessionCreated = vi.fn();
    const root = await renderPane({ sessionId: null, onSessionCreated });
    const callsBeforeSubmit = mocks.sendCommand.mock.calls.length;

    let result: unknown;
    await act(async () => {
      result = await captured.composerProps?.onSendText("/goal draft objective");
      await flushMicrotasks();
    });

    expect(result).toBe("blocked");
    expect(mocks.sendCommand).toHaveBeenCalledTimes(callsBeforeSubmit);
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Goal 无法在 Plan 模式下使用，请切换模式。");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("Start 提交推荐只修改本次 Submission", () => {
  it.each([false, true])("桌面/手机(%s)确认切换保留思考强度且只发送一次", async (mobile) => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "start154",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    recommendation.mockImplementation(async (selection) => ({
      ...selection,
      providerId: "account:bigmodel-start-plan",
    }));
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    const root = await renderPane({ compactForRemoteControl: mobile });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("start154-submit");
      });
      expect(recommendation).toHaveBeenCalledOnce();
      const original = recommendation.mock.calls[0]![0];
      const commands = mocks.sendCommand.mock.calls
        .map(([envelope]) => envelope)
        .filter((envelope) => envelope.type === "sendText");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        payload: { modelSelection: { ...original, providerId: "account:bigmodel-start-plan" } },
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("关闭推荐框不提交新消息，沿用原预热规则", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "start154",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    recommendation.mockResolvedValue(null);
    const root = await renderPane({ sessionId: null });
    try {
      let result: unknown;
      await act(async () => {
        result = await captured.composerProps?.onSendText("keep-draft");
      });
      expect(result).toBe("blocked");
      expect(
        mocks.sendCommand.mock.calls
          .map(([envelope]) => envelope)
          .filter((envelope) => envelope.type !== "createSession"),
      ).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("副屏首条推荐的桌面与手机提交边界", () => {
  for (const mobile of [false, true]) {
    it.each(["confirm", "decline", "close"] as const)(
      `mobile=${mobile}：%s 只决定 child 首条，不改父草稿`,
      async (choice) => {
        projectionState.current = {
          status: "live",
          snapshot: makeSnapshot(),
          subscriptionId: "start156-side",
          lastError: null,
          optimisticCommands: [],
          loadingOlder: false,
        };
        draftConfigMock.draftConfigRef.current = {
          modelSelection: {
            providerId: "alternate-provider",
            modelId: "deepseek-v4-pro",
            options: { reasoningLevel: "low" },
          },
        };
        recommendation.mockImplementation(async (selection) =>
          choice === "close"
            ? null
            : choice === "confirm"
              ? { ...selection, providerId: "account:bigmodel-start-plan" }
              : selection,
        );
        mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
          ackFor(envelope, {
            result: { type: "createSelectionSideSession", childSessionId: "start156-child" },
          }),
        );
        const onOpenSelectionSideChat = vi.fn();
        const root = await renderPane({ compactForRemoteControl: mobile, onOpenSelectionSideChat });
        try {
          const before = structuredClone(draftConfigMock.draftConfigRef.current);
          let result: unknown;
          await act(async () => {
            result = await captured.composerProps?.onSendText("/side explain this");
          });
          expect(recommendation).toHaveBeenCalledExactlyOnceWith({
            providerId: "primary-provider",
            modelId: "deepseek-v4-flash",
            options: { reasoningLevel: "high" },
          });
          expect(draftConfigMock.draftConfigRef.current).toEqual(before);
          expect(result).toBe(choice === "close" ? "blocked" : "sent");
          if (choice === "close") {
            expect(mocks.sendCommand).not.toHaveBeenCalled();
            expect(onOpenSelectionSideChat).not.toHaveBeenCalled();
          } else {
            expect(mocks.sendCommand).toHaveBeenCalledOnce();
            expect(mocks.sendCommand.mock.calls[0]![0]).toMatchObject({
              type: "createSelectionSideSession",
              payload: {
                firstInput: {
                  text: "explain this",
                  ...(choice === "confirm"
                    ? {
                        modelSelection: {
                          providerId: "account:bigmodel-start-plan",
                          modelId: "deepseek-v4-flash",
                          options: { reasoningLevel: "high" },
                        },
                      }
                    : {}),
                },
              },
            });
            if (choice === "decline")
              expect(mocks.sendCommand.mock.calls[0]![0].payload).toEqual({
                firstInput: { text: "explain this" },
              });
            expect(onOpenSelectionSideChat).toHaveBeenCalledOnce();
          }
        } finally {
          await act(async () => root.unmount());
        }
      },
    );
  }
});
