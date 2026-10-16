import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const {
  fileChangesMock,
  fileRewindPreviewMock,
  headerProps,
  layerMock,
  queueProps,
  sendCommandMock,
  timelineProps,
} = vi.hoisted(() => ({
  fileChangesMock: vi.fn(),
  fileRewindPreviewMock: vi.fn(),
  headerProps: [] as Array<{
    onDelete?: () => void;
    onRename?: (title: string) => void;
  }>,
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
  queueProps: [] as Array<{ onSendNow?: (queueItemId: string) => void }>,
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      revisionAtDecision: envelope.baseRevision ?? 0,
      status: "accepted",
    }),
  ),
  timelineProps: [] as Array<{
    bottomDock?: ReactNode;
    scrollMemoryKey?: string | null;
    rowContext?: {
      fetchFileChanges?: (
        target: ConversationRowTarget,
        options: {
          cachePolicy: "in-flight" | "terminal";
          fileChangesState?: "active" | "reverted";
        },
      ) => Promise<V4ConversationFileChangesResult>;
      previewFileRewind?: (target: ConversationRowTarget) => Promise<unknown>;
    };
    onFork?: (target: ConversationRowTarget) => void;
    onRetry?: (target: ConversationRowTarget) => void;
    onEdit?: (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
    ) => Promise<boolean | void> | boolean | void;
  }>,
}));

// 永不 resolve：这些文件不测发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
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
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    settings: { zcodeInteractionBehavior: "queue" },
    update: vi.fn(async () => {}),
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
    attachmentPut: vi.fn(),
    fileChanges: fileChangesMock,
    fileRewindPreview: fileRewindPreviewMock,
    layer: layerMock,
    sendCommand: sendCommandMock,
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
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    resolveInitialDraftConfig: vi.fn(),
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
    ConversationHeader: (props: Record<string, unknown>) => {
      headerProps.push(props as (typeof headerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-header" });
    },
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: (props: Record<string, unknown>) => {
      timelineProps.push(props as (typeof timelineProps)[number]);
      return React.createElement(
        Fragment,
        null,
        React.createElement("div", { "data-testid": "mock-timeline" }),
        props.bottomDock as ReactNode,
      );
    },
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
    ConversationQueuePanel: (props: Record<string, unknown>) => {
      queueProps.push(props as (typeof queueProps)[number]);
      return React.createElement("div", { "data-testid": "mock-queue" });
    },
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
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    window: windowMock,
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
      sendQueuedNow: {
        allowed: false,
        reasonCode: "sendQueuedNowRequiresRunning",
      },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: {
      provider: "",
      model: "",
      thought: "",
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

function makeEmptyFileChanges(): V4ConversationFileChangesResult {
  return {
    files: 0,
    additions: 0,
    deletions: 0,
    items: [],
  };
}

afterEach(() => {
  fileChangesMock.mockReset();
  fileRewindPreviewMock.mockReset();
  sendCommandMock.mockClear();
  layerMock.acquire.mockImplementation(() => ({
    store: {
      markCommandPending: vi.fn(),
      expectAcceptedInputProjection: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
    release: vi.fn(),
  }));
  headerProps.length = 0;
  queueProps.length = 0;
  timelineProps.length = 0;
  servicesMock.highspeedCardService.prepareTurn.mockReset();
  servicesMock.highspeedCardService.prepareTurn.mockResolvedValue({
    kind: "fallback",
    reason: "draw-miss",
    nextDrawAt: null,
  });
  projectionState.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane user query editing", () => {
  it("builds pane-isolated timeline scroll memory keys for bound sessions", async () => {
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
            paneId: "pane-2",
            sessionId: "session-1",
            workspaceIdentity: "ssh://demo",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    expect(timelineProps.at(-1)?.scrollMemoryKey).toBe(
      "ssh://demo::pane:pane-2::session:session-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("虚拟行复挂载共享同一 fileChanges 请求，target 或 logEpoch 变化后才重查", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    let resolveFirstRequest: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const firstRequest = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveFirstRequest = resolve;
    });
    fileChangesMock.mockReturnValueOnce(firstRequest).mockResolvedValue(makeEmptyFileChanges());
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const target = { rowId: 42, entityId: "entity-42" };
    const fetchBeforeRemount = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const pendingFromFirstMount = fetchBeforeRemount?.(target, {
      cachePolicy: "terminal",
    });
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });
    const fetchAfterRemount = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const pendingFromRemount = fetchAfterRemount?.({ ...target }, { cachePolicy: "terminal" });

    expect(fileChangesMock).toHaveBeenCalledTimes(1);
    expect(pendingFromRemount).toBe(pendingFromFirstMount);
    resolveFirstRequest?.(makeEmptyFileChanges());
    await Promise.all([pendingFromFirstMount, pendingFromRemount]);

    await fetchAfterRemount?.({ ...target }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(1);

    await fetchAfterRemount?.({ rowId: 43, entityId: "entity-43" }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(2);

    const nextSnapshot = makeSnapshot();
    nextSnapshot.logEpoch = "epoch-2";
    nextSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: nextSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    await timelineProps
      .at(-1)
      ?.rowContext?.fetchFileChanges?.({ ...target }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(3);
    expect(fileChangesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseLogEpoch: "epoch-2",
        target,
      }),
    );

    await act(async () => root.unmount());
  });

  it("终态 fileChanges 缓存按 active/reverted 状态隔离", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const activeResult = {
      ...makeEmptyFileChanges(),
      state: "active" as const,
      files: 1,
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    const revertedResult = {
      ...makeEmptyFileChanges(),
      state: "reverted" as const,
    };
    fileChangesMock.mockResolvedValueOnce(activeResult).mockResolvedValueOnce(revertedResult);
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const target = { rowId: 42, entityId: "entity-42" };
    const fetchActive = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(
      fetchActive?.(target, {
        cachePolicy: "terminal",
        fileChangesState: "active",
      }),
    ).resolves.toEqual(activeResult);
    await expect(
      fetchActive?.(
        { ...target },
        {
          cachePolicy: "terminal",
          fileChangesState: "active",
        },
      ),
    ).resolves.toEqual(activeResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(1);

    const revertedSnapshot = makeSnapshot();
    revertedSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: revertedSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const fetchReverted = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(
      fetchReverted?.(target, {
        cachePolicy: "terminal",
        fileChangesState: "reverted",
      }),
    ).resolves.toEqual(revertedResult);
    await expect(
      fetchReverted?.(
        { ...target },
        {
          cachePolicy: "terminal",
          fileChangesState: "reverted",
        },
      ),
    ).resolves.toEqual(revertedResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 8, target }),
    );

    await act(async () => root.unmount());
  });

  it("fileChanges 完整结果缓存最多保留 20 个 turn", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    fileChangesMock.mockResolvedValue(makeEmptyFileChanges());
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

    const fetchFileChanges = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    for (let rowId = 1; rowId <= 21; rowId += 1) {
      await fetchFileChanges?.({ rowId, entityId: `entity-${rowId}` }, { cachePolicy: "terminal" });
    }
    await fetchFileChanges?.({ rowId: 1, entityId: "entity-1" }, { cachePolicy: "terminal" });

    expect(fileChangesMock).toHaveBeenCalledTimes(22);
    await act(async () => root.unmount());
  });

  it("运行中 revision 前进后重查 fileChanges，终态结果才跨复挂载缓存", async () => {
    const runningSnapshot = makeSnapshot();
    runningSnapshot.revision = 7;
    projectionState.current = {
      status: "live",
      snapshot: runningSnapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const partialResult = {
      ...makeEmptyFileChanges(),
      files: 1,
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    const finalResult = {
      ...makeEmptyFileChanges(),
      files: 2,
      items: [
        { path: "/workspace/README.md", patches: [] },
        { path: "/workspace/index.html", patches: [] },
      ],
    };
    let resolveRunningRequest: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const runningRequest = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveRunningRequest = resolve;
    });
    fileChangesMock.mockReturnValueOnce(runningRequest).mockResolvedValueOnce(finalResult);
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "entity-42" };
    const fetchWhileRunning = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const firstRunningResult = fetchWhileRunning?.(target, {
      cachePolicy: "in-flight",
    });
    const duplicateRunningResult = fetchWhileRunning?.({ ...target }, { cachePolicy: "in-flight" });
    expect(duplicateRunningResult).toBe(firstRunningResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(1);
    resolveRunningRequest?.(partialResult);
    await expect(firstRunningResult).resolves.toEqual(partialResult);
    await expect(duplicateRunningResult).resolves.toEqual(partialResult);

    const terminalSnapshot = makeSnapshot();
    terminalSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: terminalSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const fetchAfterTerminal = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(fetchAfterTerminal?.(target, { cachePolicy: "terminal" })).resolves.toEqual(
      finalResult,
    );
    await expect(fetchAfterTerminal?.({ ...target }, { cachePolicy: "terminal" })).resolves.toEqual(
      finalResult,
    );

    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ baseRevision: 7, target }),
    );
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 8, target }),
    );
    await act(async () => root.unmount());
  });

  it("row command 收到 stale log epoch ACK 时触发 projection resync", async () => {
    const recoverFromStaleLogEpoch = vi.fn();
    layerMock.acquire.mockReturnValue({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        recoverFromStaleAuthority: recoverFromStaleLogEpoch,
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    } as never);
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    sendCommandMock.mockImplementationOnce(async (command: CommandEnvelope) => ({
      commandId: command.commandId,
      revisionAtDecision: 8,
      status: "stale",
      reasonCode: "proto.staleLogEpoch",
    }));
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

    await act(async () => {
      timelineProps.at(-1)?.onRetry?.({ rowId: 42, entityId: "message-assistant-42" });
      await flushMicrotasks();
    });

    expect(recoverFromStaleLogEpoch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it.each(["proto.staleTarget", "proto.staleRevision"])(
    "row command 收到 %s ACK 时同样触发 projection resync",
    async (reasonCode) => {
      const recoverFromStaleAuthority = vi.fn();
      layerMock.acquire.mockReturnValue({
        store: {
          markCommandPending: vi.fn(),
          expectAcceptedInputProjection: vi.fn(),
          onOnlineModelTransition: vi.fn(() => () => {}),
          refreshPlans: vi.fn(async () => {}),
          recoverFromStaleAuthority,
          settleCommand: vi.fn(),
        },
        release: vi.fn(),
      } as never);
      projectionState.current = {
        status: "live",
        snapshot: makeSnapshot(),
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      sendCommandMock.mockResolvedValueOnce({
        commandId: "cmd-stale-target",
        revisionAtDecision: 8,
        status: "stale",
        reasonCode,
      });
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
      await act(async () => {
        timelineProps.at(-1)?.onRetry?.({ rowId: 42, entityId: "stale-entity" });
        await flushMicrotasks();
      });
      expect(recoverFromStaleAuthority).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    },
  );

  it("file changes/preview stale authority fault 触发同一 projection recovery", async () => {
    const recoverFromStaleAuthority = vi.fn();
    layerMock.acquire.mockReturnValue({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        recoverFromStaleAuthority,
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    } as never);
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    fileChangesMock.mockRejectedValueOnce(new Error("proto.staleLogEpoch"));
    fileRewindPreviewMock.mockRejectedValueOnce(new Error("proto.staleTarget"));
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
    const target = { rowId: 42, entityId: "entity-42" };
    await expect(
      timelineProps.at(-1)?.rowContext?.fetchFileChanges?.(target, { cachePolicy: "terminal" }),
    ).rejects.toThrow("proto.staleLogEpoch");
    fileChangesMock.mockResolvedValueOnce(makeEmptyFileChanges());
    await expect(
      timelineProps.at(-1)?.rowContext?.fetchFileChanges?.(target, { cachePolicy: "terminal" }),
    ).resolves.toEqual(makeEmptyFileChanges());
    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    await expect(timelineProps.at(-1)?.rowContext?.previewFileRewind?.(target)).rejects.toThrow(
      "proto.staleTarget",
    );
    expect(recoverFromStaleAuthority).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("running 时 edit 可用，fork 回调交给 row.actions 裁决，retry 仍保持 completed gate", async () => {
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_700_000_000_000 }],
    };
    projectionState.current = {
      status: "live",
      snapshot,
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

    const props = timelineProps.at(-1);
    expect(typeof props?.onEdit).toBe("function");
    expect(props?.onFork).toBeTypeOf("function");
    // row.actions 是唯一 action authority；Timeline 收到稳定 resolver，再逐 row 决定是否展示 retry。
    expect(props?.onRetry).toBeTypeOf("function");

    await act(async () => {
      root.unmount();
    });
  });

  it("dispatches editUserQuery with edited text and original attachments", async () => {
    const attachments: AttachmentRef[] = [
      {
        bytes: 12,
        fileName: "note.txt",
        mime: "text/plain",
        ref: "/workspace/note.txt",
      },
    ];
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

    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "改过的问题", attachments);
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      baseRevision: 7,
      baseLogEpoch: "epoch-1",
      payload: {
        attachments,
        newText: "改过的问题",
        target: { rowId: 42, entityId: "message-user-42" },
      },
      sessionId: "session-1",
      type: "editUserQuery",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("重新编辑时重新准备 Highspeed，并随 editUserQuery 提交本次卡和 runtime", async () => {
    const snapshot = makeSnapshot();
    snapshot.config = {
      ...snapshot.config,
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-edit",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const execution = {
      modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
      requestAuth: {
        apiKey: "card-jwt",
        headers: { Authorization: "Bearer card-jwt", "X-Highspeed-Card-ID": "card-edit" },
      },
      selectionFallback: {
        providerId: "account:bigmodel-highspeed-card",
        rules: [
          { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
          { reason: "highspeed_request_failed" as const },
        ],
      },
    };
    servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: highspeedMeta,
      nextDrawAt: highspeedMeta.expiresAt,
      execution,
    });
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
    expect(timelineProps.at(-1)?.onEdit).toBeTypeOf("function");
    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "重新加速的问题", []);
    });

    expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "session-1" }),
    );
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      type: "editUserQuery",
      payload: {
        highspeedMeta,
        // 显式重编辑会重新抽卡：Selection 与执行材料必须整体刷新，且永远是 execution 作用域，
        // 不允许把会话常驻 Selection 改成加速卡 Provider。
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
    });

    await act(async () => root.unmount());
  });

  it("手动发送 Highspeed 队列项时刷新同卡 runtime 后再提升", async () => {
    const snapshot = makeSnapshot();
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-queue",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    snapshot.queue = {
      autoDrain: false,
      items: [
        {
          sourceCommandId: "source-queue",
          queueItemId: "queue-1",
          clientId: "client-1",
          kind: "sendText",
          text: "排队消息",
          attachments: [],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1,
          highspeed: highspeedMeta,
        },
      ],
    };
    snapshot.availability = {
      ...snapshot.availability,
      sendQueuedNow: { allowed: true },
    };
    snapshot.config = {
      ...snapshot.config,
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const execution = {
      modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
      requestAuth: {
        apiKey: "card-jwt",
        headers: { Authorization: "Bearer card-jwt", "X-Highspeed-Card-ID": "card-queue" },
      },
      selectionFallback: {
        providerId: "account:bigmodel-highspeed-card",
        rules: [
          { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
          { reason: "highspeed_request_failed" as const },
        ],
      },
    };
    servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: highspeedMeta,
      nextDrawAt: highspeedMeta.expiresAt,
      execution,
    });
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
    expect(queueProps.at(-1)?.onSendNow).toBeTypeOf("function");
    await act(async () => {
      queueProps.at(-1)?.onSendNow?.("queue-1");
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      type: "sendQueuedNow",
      payload: {
        queueItemId: "queue-1",
        highspeedMeta,
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
    });

    await act(async () => root.unmount());
  });

  it("serializes an explicit empty attachment list when edit removes every ref", async () => {
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

    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "保留正文", []);
    });

    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        attachments: [],
        newText: "保留正文",
        target: { rowId: 42, entityId: "message-user-42" },
      },
      type: "editUserQuery",
    });

    await act(async () => root.unmount());
  });

  it("keeps accepted legacy fork-disposition edit ACK on the current session", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    sendCommandMock.mockImplementationOnce(async (envelope: CommandEnvelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 7,
      status: "accepted",
      result: {
        type: "editUserQuery",
        disposition: "fork",
        sessionId: "session-child",
      },
    }));
    const onSessionCreated = vi.fn();
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
            onSessionCreated,
          }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "edited child text");
    });

    expect(onSessionCreated).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("duplicate fork ACK 导航既有 child，edit 与失败 ACK 即使带 result 也不导航", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const ack = (
      status: CommandAck["status"],
      type: "forkAssistant" | "editUserQuery",
      sessionId: string,
    ): CommandAck => ({
      commandId: `cmd-${status}-${type}`,
      revisionAtDecision: 7,
      status,
      result:
        type === "forkAssistant" ? { type, sessionId } : { type, disposition: "fork", sessionId },
    });
    sendCommandMock
      .mockResolvedValueOnce(ack("duplicate", "editUserQuery", "session-edit-existing"))
      .mockResolvedValueOnce(ack("duplicate", "forkAssistant", "session-fork-existing"))
      .mockResolvedValueOnce(ack("failed", "editUserQuery", "session-failed"))
      .mockResolvedValueOnce(ack("rejected", "editUserQuery", "session-rejected"))
      .mockResolvedValueOnce(ack("stale", "editUserQuery", "session-stale"));
    const onSessionCreated = vi.fn();
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
            onSessionCreated,
          }),
        ),
      );
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "message-target-42" };
    await act(async () => {
      await timelineProps.at(-1)?.onEdit?.(target, "duplicate edit");
      timelineProps.at(-1)?.onFork?.(target);
      await flushMicrotasks();
      await timelineProps.at(-1)?.onEdit?.(target, "failed edit");
      await timelineProps.at(-1)?.onEdit?.(target, "rejected edit");
      await timelineProps.at(-1)?.onEdit?.(target, "stale edit");
      await flushMicrotasks();
    });

    expect(onSessionCreated.mock.calls).toEqual([["session-fork-existing"]]);
    await act(async () => root.unmount());
  });

  it("does not expose task rename or delete actions in conversation pane chrome", async () => {
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

    expect(headerProps.at(-1)?.onRename).toBeUndefined();
    expect(headerProps.at(-1)?.onDelete).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });
});
