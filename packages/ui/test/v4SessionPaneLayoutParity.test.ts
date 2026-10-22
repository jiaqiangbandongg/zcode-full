import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationSnapshot,
  PendingInteraction,
  SubagentRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
} from "@/lib/workspaceSidePane.js";

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

const statusPanelCapture = vi.hoisted(() => ({
  composerProps: [] as Array<Record<string, unknown>>,
  props: [] as Array<Record<string, unknown>>,
}));

const conversationTelemetryState = vi.hoisted(() => ({
  current: null as null | {
    acceptPromptSeed: ReturnType<typeof vi.fn>;
    attachForeground: ReturnType<typeof vi.fn>;
  },
}));

// Bugfix：本文件只验证 SessionPane 布局骨架，隔离闲时入口对真实 TabStore 的依赖。
vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));

// 同理隔离推荐提示词容器：它通过 useWorkspaceServicesResolution 依赖 TabStoreProvider，
// 而本文件只挂 SessionPane 验证布局，不提供 Tab store。
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));

vi.mock("@/v4/telemetry/ConversationTelemetryAttachment.js", () => ({
  useScopedConversationTelemetrySupervisor: () => conversationTelemetryState.current,
  useScopedConversationTelemetryForegroundEnabled: () =>
    conversationTelemetryState.current !== null,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: {
      acquire: vi.fn(),
    },
    sendCommand: vi.fn(),
    attachmentPut: vi.fn(),
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
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => ({
    zcodeSessionService: {},
    zcodeTaskService: {
      restartWorkspaceProcess: vi.fn(),
    },
  }),
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfig: {},
    draftConfigRef: { current: {} },
    resolveInitialDraftConfig: vi.fn(() => ({})),
    acceptAuthoritativeDraftModelConfig: vi.fn(),
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
    ConversationComposer: (props: Record<string, unknown>) => {
      statusPanelCapture.composerProps.push(props);
      return React.createElement(
        "div",
        {
          "data-testid": "mock-composer",
          "data-blocking-request-id": (props.blockingRequestId as string | null) ?? "",
          "data-centered": props.centered ? "true" : "false",
          "data-draft-mode": props.draftMode ? "true" : "false",
        },
        "composer",
      );
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: (props: Record<string, unknown>) => {
      statusPanelCapture.props.push(props);
      return React.createElement("div", { "data-testid": "mock-status" });
    },
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
    ConversationDraftEmptyState: (props: { compactForRemoteControl?: boolean }) =>
      React.createElement("div", {
        "data-testid": "mock-draft-empty",
        "data-compact-remote": props.compactForRemoteControl ? "true" : "false",
      }),
  };
});

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnGroup: () => React.createElement("div", { "data-testid": "mock-turn-group" }),
  };
});

function userInputRow(): UserInputRow {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1_777_777_777,
    createdAtSeq: 1,
    kind: "userInput",
    text: "hello",
    origin: "realUser",
  };
}

function subagentRow(overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId: 2,
    turnId: "turn-1",
    createdAt: 1_777_777_778,
    createdAtSeq: 2,
    kind: "subagent",
    subagentType: "Explore",
    status: "running",
    summaryText: "正在后台探索",
    backgrounded: true,
    workId: "work-agent",
    childSessionId: "child-session",
    ...overrides,
  };
}

function pendingPermissionInteraction(): PendingInteraction {
  return {
    interactionId: "perm-1",
    kind: "permission",
    anchorRowId: null,
    createdAt: 1_777_777_778,
    payload: {
      kind: "permission",
      toolCallId: "tool-call-1",
      toolName: "Bash",
      summary: "Tool has side effects and requires approval",
      detail: { command: "touch quickSort.js" },
      options: [
        { optionId: "allow_once", label: "允许", kind: "allowOnce" },
        { optionId: "allow_always", label: "始终允许", kind: "allowAlways" },
        { optionId: "deny", label: "拒绝", kind: "deny" },
      ],
    },
  };
}

function pendingStructuredUserInputInteraction(): PendingInteraction {
  return {
    interactionId: "ask-1",
    kind: "userInput",
    anchorRowId: null,
    createdAt: 1_777_777_779,
    payload: {
      kind: "userInput",
      prompt: "选择实现形式",
      freeText: false,
      toolName: "AskUserQuestion",
      toolCallId: "tool-call-ask-1",
      questions: [
        {
          question: "你想把这个番茄时钟作为什么形式存在？",
          header: "形式",
          options: [
            { value: "page", label: "独立新页面", description: "通过导航访问" },
            { value: "widget", label: "独立小工具视图", description: "可复用组件" },
          ],
        },
      ],
    },
  };
}

function makeSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  const snapshot: ConversationSnapshot = {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
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
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue" },
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
    rows: { window: [userInputRow()], totalCount: 1, firstRowId: 1 },
  };
  return { ...snapshot, ...overrides };
}

function renderPane({
  compactForRemoteControl = false,
  onOpenSubagentSession,
  onOpenWorkflowRun,
  onSummaryPanelVariantOverrideChange,
  snapshot = makeSnapshot(),
  sessionId = "session-1",
}: {
  compactForRemoteControl?: boolean;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onSummaryPanelVariantOverrideChange?: (variant: "panel" | "mini" | null) => void;
  snapshot?: ConversationSnapshot;
  sessionId?: string | null;
} = {}): string {
  statusPanelCapture.props = [];
  statusPanelCapture.composerProps = [];
  projectionState.current = {
    status: "live",
    snapshot,
    subscriptionId: "sub-1",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SessionPane, {
        paneId: "workspace-main",
        sessionId,
        workspacePath: "/workspace",
        compactForRemoteControl,
        ...(onOpenSubagentSession ? { onOpenSubagentSession } : {}),
        ...(onOpenWorkflowRun ? { onOpenWorkflowRun } : {}),
        ...(onSummaryPanelVariantOverrideChange ? { onSummaryPanelVariantOverrideChange } : {}),
      }),
    ),
  );
}

describe("SessionPane v4 chat layout parity", () => {
  it("renders the draft greeting and the composer in the shared timeline viewport", () => {
    const html = renderPane({ sessionId: null });

    expect(html).toContain('data-v4-conversation-drop-target="true"');
    expect(html).toContain('data-v4-timeline-scroll="true"');
    expect(html).toContain('data-testid="mock-draft-empty"');
    expect(html).toContain('data-v4-composer-dock="true"');
    expect(html).toContain('data-compact-remote="false"');
    expect(html).toContain('data-draft-mode="true"');
    expect(html).toContain('data-centered="true"');
  });

  it("passes compact remote draft mode to the empty state", () => {
    const html = renderPane({ sessionId: null, compactForRemoteControl: true });

    expect(html).toContain('data-compact-remote="true"');
  });

  it("keeps a bound empty session blank while preserving the bottom composer dock", () => {
    const html = renderPane({
      snapshot: makeSnapshot({
        rows: { window: [], totalCount: 0, firstRowId: null },
      }),
    });

    expect(html).toContain('data-v4-timeline-scroll="true"');
    expect(html).toContain('data-v4-composer-dock="true"');
    expect(html).toContain('data-testid="mock-composer"');
    expect(html).not.toContain("v4-timeline-empty");
    expect(html).not.toContain("发送第一条消息开始对话");
  });

  it("renders the composer after the timeline viewport and inside its dock", () => {
    const html = renderPane();

    expect(html).toContain('data-v4-timeline-scroll="true"');
    expect(html).toContain('data-v4-timeline-content-column="true"');
    expect(html).toContain('data-v4-composer-dock="true"');
    expect(html.indexOf('data-v4-timeline-scroll="true"')).toBeLessThan(
      html.indexOf('data-v4-composer-dock="true"'),
    );
    expect(html.indexOf('data-v4-composer-dock="true"')).toBeLessThan(
      html.indexOf('data-testid="mock-composer"'),
    );
  });

  it("anchors the back-to-bottom control to the composer dock above input", () => {
    const html = renderPane();

    expect(html).toContain('data-v4-back-to-bottom-anchor="composer-dock"');
    expect(html.indexOf('data-v4-composer-dock="true"')).toBeLessThan(
      html.indexOf('data-v4-back-to-bottom-anchor="composer-dock"'),
    );
    expect(html.indexOf('data-v4-back-to-bottom-anchor="composer-dock"')).toBeLessThan(
      html.indexOf('data-testid="mock-composer"'),
    );
  });

  it("renders pending permission before the composer inside the composer dock", () => {
    conversationTelemetryState.current = {
      acceptPromptSeed: vi.fn(),
      attachForeground: vi.fn(() => () => {}),
    };
    const html = renderPane({
      snapshot: makeSnapshot({
        pendingInteractions: [pendingPermissionInteraction()],
      }),
    });
    conversationTelemetryState.current = null;

    const dockIndex = html.indexOf('data-v4-composer-dock="true"');
    const interactionIndex = html.indexOf('data-testid="mock-interactions"');
    const composerIndex = html.indexOf('data-testid="mock-composer"');

    expect(dockIndex).toBeGreaterThanOrEqual(0);
    expect(interactionIndex).toBeGreaterThanOrEqual(0);
    expect(composerIndex).toBeGreaterThanOrEqual(0);
    expect(dockIndex).toBeLessThan(interactionIndex);
    expect(interactionIndex).toBeLessThan(composerIndex);
    // 2026-08-17：Start Plan runtime headers 应答方已迁出 SessionPane，改由 Root 的
    // V4WorkspaceProviderRuntimeHeadersBridge 按 workspace 常驻挂载（web 远控新建会话
    // 在桌面没有 pane 时也必须有应答方），pane 内不再渲染该控制器。
    expect(html).not.toContain('data-testid="mock-runtime-headers"');
    expect(html).toContain('data-blocking-request-id="perm-1"');
  });

  for (const compactForRemoteControl of [false, true]) {
    it.each([
      ["permission", [pendingPermissionInteraction()]],
      ["user input", [pendingStructuredUserInputInteraction()]],
      ["mixed requests", [pendingPermissionInteraction(), pendingStructuredUserInputInteraction()]],
    ])(
      `keeps %s in the bottom dock without a top notice (remote=${compactForRemoteControl})`,
      (_label, pendingInteractions) => {
        const html = renderPane({
          compactForRemoteControl,
          snapshot: makeSnapshot({ pendingInteractions }),
        });

        // 待处理请求已有底部卡片，顶部不再重复展示 warning 和跳转入口。
        expect(html).not.toContain('data-testid="v4-pending-interaction-top-notice"');
        const dockIndex = html.indexOf('data-v4-composer-dock="true"');
        const interactionIndex = html.indexOf('data-testid="mock-interactions"');
        const composerIndex = html.indexOf('data-testid="mock-composer"');
        expect(dockIndex).toBeGreaterThanOrEqual(0);
        expect(interactionIndex).toBeGreaterThan(dockIndex);
        expect(composerIndex).toBeGreaterThan(interactionIndex);
      },
    );
  }

  it("普通 Web 没有 desktop-continuous attachment 时不挂一次性 runtime header controller", () => {
    conversationTelemetryState.current = null;
    const html = renderPane();

    expect(html).not.toContain('data-testid="mock-runtime-headers"');
  });

  it("renders structured user input before the composer inside the composer dock", () => {
    const html = renderPane({
      snapshot: makeSnapshot({
        pendingInteractions: [pendingStructuredUserInputInteraction()],
      }),
    });

    const dockIndex = html.indexOf('data-v4-composer-dock="true"');
    const interactionIndex = html.indexOf('data-testid="mock-interactions"');
    const composerIndex = html.indexOf('data-testid="mock-composer"');

    expect(dockIndex).toBeGreaterThanOrEqual(0);
    expect(interactionIndex).toBeGreaterThanOrEqual(0);
    expect(composerIndex).toBeGreaterThanOrEqual(0);
    expect(dockIndex).toBeLessThan(interactionIndex);
    expect(interactionIndex).toBeLessThan(composerIndex);
    expect(html).toContain('data-blocking-request-id="ask-1"');
  });

  it("selects automatic status panel layout for an active goal", () => {
    vi.stubGlobal("window", {
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    try {
      const html = renderPane({
        snapshot: makeSnapshot({
          goal: {
            targetId: "goal-inline",
            objective: "Keep status panel inline with the conversation column",
            summaryTitle: null,
            timeUsedSeconds: 0,
            activeRunStartedAtMs: null,
            status: "active",
            iteration: 1,
            verifications: [],
            iterations: [],
          },
        }),
      });

      expect(html).toContain('data-v4-timeline-content-column="true"');
      expect(html).toContain('data-v4-composer-dock="true"');
      expect(statusPanelCapture.props.at(-1)?.layoutMode).toBe("auto");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wires pause/resume callbacks only from authoritative goal availability", () => {
    const active = makeSnapshot();
    active.goal = {
      targetId: "goal-controls",
      objective: "Restore goal controls",
      summaryTitle: null,
      timeUsedSeconds: 3,
      activeRunStartedAtMs: null,
      status: "active",
      iteration: 0,
      verifications: [],
      iterations: [],
    };
    active.availability = {
      ...active.availability,
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: false, reasonCode: "goalNotPaused" },
    };
    renderPane({ snapshot: active });
    expect(statusPanelCapture.props.at(-1)?.onPauseGoal).toEqual(expect.any(Function));
    expect(statusPanelCapture.props.at(-1)?.onResumeGoal).toBeUndefined();

    const paused = makeSnapshot({
      goal: { ...active.goal, status: "paused" },
      availability: {
        ...active.availability,
        pauseGoal: { allowed: false, reasonCode: "goalNotActive" },
        resumeGoal: { allowed: true },
      },
    });
    renderPane({ snapshot: paused });
    expect(statusPanelCapture.props.at(-1)?.onPauseGoal).toBeUndefined();
    expect(statusPanelCapture.props.at(-1)?.onResumeGoal).toEqual(expect.any(Function));
  });

  it("keeps scoped Agent detail opening on remote compact while hiding the directory", () => {
    const onOpenSubagentSession = vi.fn();
    const row = subagentRow();
    const snapshot = makeSnapshot({
      backgroundWorks: [
        {
          workId: "work-agent",
          kind: "subagent",
          title: "分析状态面板",
          status: "running",
          startedAt: 1_777_777_778,
          anchorRowId: row.rowId,
          childSessionId: "child-session",
        },
      ],
      rows: { window: [userInputRow(), row], totalCount: 2, firstRowId: 1 },
    });

    renderPane({ snapshot, onOpenSubagentSession });
    const panelProps = statusPanelCapture.props.at(-1);
    if (!panelProps) throw new Error("Status panel props were not captured");
    expect(panelProps.parentSessionId).toBe("session-1");
    expect(panelProps.runningSubagents).toEqual([]);

    (
      panelProps.onOpenSubagentSession as (request: {
        rootSessionId: string;
        parentSessionId: string;
        childSessionId: string;
        subagentType: string;
        title: string;
      }) => void
    )({
      rootSessionId: "session-1",
      parentSessionId: "session-1",
      childSessionId: "child-session",
      subagentType: "Explore",
      title: "分析状态面板",
    });
    expect(onOpenSubagentSession).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      rootSessionId: "session-1",
      parentSessionId: "session-1",
      childSessionId: "child-session",
      subagentType: "Explore",
      title: "分析状态面板",
    });

    renderPane({
      compactForRemoteControl: true,
      snapshot,
      onOpenSubagentSession,
    });
    expect(statusPanelCapture.props.at(-1)?.isWebRemoteControl).toBe(true);
    expect(statusPanelCapture.props.at(-1)?.isMobileViewport).toBe(false);
    expect(statusPanelCapture.props.at(-1)?.onOpenSubagentSession).toEqual(expect.any(Function));
    expect(statusPanelCapture.props.at(-1)?.onOpenSubagentDirectory).toBeUndefined();
  });

  it("wires the Composer background entry to panel expansion and controlled Running state", () => {
    const onSummaryPanelVariantOverrideChange = vi.fn();
    const snapshot = makeSnapshot({
      backgroundWorks: [
        {
          workId: "work-bash",
          kind: "bash",
          title: "Run checks",
          status: "running",
          startedAt: 1_777_777_778,
          anchorRowId: null,
        },
      ],
    });

    renderPane({ snapshot, onSummaryPanelVariantOverrideChange });
    const composerProps = statusPanelCapture.composerProps.at(-1);
    const panelProps = statusPanelCapture.props.at(-1);
    expect(panelProps?.terminalSectionOpen).toBe(false);
    expect(panelProps?.onTerminalSectionOpenChange).toEqual(expect.any(Function));
    expect(panelProps?.agentSectionOpen).toBe(false);
    expect(panelProps?.onAgentSectionOpenChange).toEqual(expect.any(Function));

    (composerProps?.onOpenRunningBackgroundWorks as (() => void) | undefined)?.();
    expect(onSummaryPanelVariantOverrideChange).toHaveBeenCalledWith("panel");
  });

  it("keeps the Composer Agent count while the directory projection catches up", () => {
    const snapshot = makeSnapshot({
      backgroundWorks: [
        {
          workId: "work-agent",
          kind: "subagent",
          title: "后台分析",
          status: "running",
          startedAt: 1_777_777_778,
          anchorRowId: null,
          childSessionId: "child-session",
        },
      ],
      subagents: {
        revision: 2,
        childSessionIds: ["child-session"],
        running: [],
        endedTotal: 0,
      },
    });

    renderPane({ snapshot });
    const composerProps = statusPanelCapture.composerProps.at(-1);
    expect(composerProps?.runningSubagentCount).toBe(1);
    expect(composerProps?.onOpenRunningBackgroundWorks).toEqual(expect.any(Function));
  });

  // composer 徽标直达（docs/dynamic-workflow/presentation.md）：唯一在跑的工作流
  // 点徽标直接开详情 side tab，胶囊不动；其他形态照旧展开胶囊。
  describe("Composer background entry with dwf workflow runs", () => {
    const workflowWork = {
      workId: "dwfrun-1",
      kind: "workflow" as const,
      title: "发布前检查",
      status: "running" as const,
      startedAt: 1_777_777_778,
      anchorRowId: null,
    };
    const workflowRun = {
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
      status: "running" as const,
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 0,
    };

    it("opens the run details directly when one workflow is the only running activity", () => {
      const onSummaryPanelVariantOverrideChange = vi.fn();
      const onOpenWorkflowRun = vi.fn();
      const snapshot = makeSnapshot({
        backgroundWorks: [workflowWork],
        workflowRuns: { revision: 1, runs: [workflowRun] },
      });

      renderPane({ snapshot, onOpenWorkflowRun, onSummaryPanelVariantOverrideChange });
      const composerProps = statusPanelCapture.composerProps.at(-1);
      expect(composerProps?.backgroundWorkOpenTarget).toBe("workflow-run");

      (composerProps?.onOpenRunningBackgroundWorks as (() => void) | undefined)?.();
      expect(onOpenWorkflowRun).toHaveBeenCalledWith({
        parentSessionId: "session-1",
        runId: "dwfrun-1",
        toolCallId: "tool-wf-1",
        workflowName: "发布前检查",
        workspacePath: "/workspace",
      });
      expect(onSummaryPanelVariantOverrideChange).not.toHaveBeenCalled();
    });

    it("falls back to panel expansion when another kind runs alongside the workflow", () => {
      const onSummaryPanelVariantOverrideChange = vi.fn();
      const onOpenWorkflowRun = vi.fn();
      const snapshot = makeSnapshot({
        backgroundWorks: [
          workflowWork,
          {
            workId: "work-bash",
            kind: "bash",
            title: "Run checks",
            status: "running",
            startedAt: 1_777_777_778,
            anchorRowId: null,
          },
        ],
        workflowRuns: { revision: 1, runs: [workflowRun] },
      });

      renderPane({ snapshot, onOpenWorkflowRun, onSummaryPanelVariantOverrideChange });
      const composerProps = statusPanelCapture.composerProps.at(-1);
      expect(composerProps?.backgroundWorkOpenTarget).toBe("panel");

      (composerProps?.onOpenRunningBackgroundWorks as (() => void) | undefined)?.();
      expect(onOpenWorkflowRun).not.toHaveBeenCalled();
      expect(onSummaryPanelVariantOverrideChange).toHaveBeenCalledWith("panel");
    });

    it("falls back to panel expansion when the host cannot open run details", () => {
      const onSummaryPanelVariantOverrideChange = vi.fn();
      const snapshot = makeSnapshot({
        backgroundWorks: [workflowWork],
        workflowRuns: { revision: 1, runs: [workflowRun] },
      });

      renderPane({ snapshot, onSummaryPanelVariantOverrideChange });
      const composerProps = statusPanelCapture.composerProps.at(-1);
      expect(composerProps?.backgroundWorkOpenTarget).toBe("panel");

      (composerProps?.onOpenRunningBackgroundWorks as (() => void) | undefined)?.();
      expect(onSummaryPanelVariantOverrideChange).toHaveBeenCalledWith("panel");
    });
  });
});
