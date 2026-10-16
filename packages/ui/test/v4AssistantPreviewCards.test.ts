import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ConversationSnapshot,
  SubagentRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildAssistantPreviewCardsForAssistantTextRow } from "@/v4/assistantPreviewCards.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";

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

const timelineCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

const toolCallBlockCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/AssistantPreviewCards.js", async () => {
  const React = await import("react");
  return {
    AssistantPreviewCards: ({
      cards,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
    }: {
      cards: AssistantPreviewCard[];
      onOpenBrowserUrl?: (url: string) => void;
      onOpenCodeViewer?: (source: unknown) => void;
      onOpenFileLink?: (target: unknown) => void;
    }) =>
      React.createElement("div", {
        "data-testid": "mock-assistant-preview-cards",
        "data-card-ids": cards.map((card) => card.id).join("|"),
        "data-open-browser": String(Boolean(onOpenBrowserUrl)),
        "data-open-code": String(Boolean(onOpenCodeViewer)),
        "data-open-file": String(Boolean(onOpenFileLink)),
      }),
  };
});

vi.mock("@/AssistantCodeCommentCards.js", async () => {
  const React = await import("react");
  return {
    AssistantCodeCommentCards: ({
      cards,
      onOpenCodeViewer,
    }: {
      cards: AssistantCodeCommentCard[];
      onOpenCodeViewer?: (target: unknown) => void;
    }) =>
      React.createElement("div", {
        "data-testid": "mock-assistant-code-comment-cards",
        "data-card-titles": cards.map((card) => card.title).join("|"),
        "data-open-review": String(Boolean(onOpenCodeViewer)),
      }),
  };
});

vi.mock("@/components/ai-elements/message.js", async () => {
  const React = await import("react");
  return {
    MessageAction: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement("button", props, children),
    MessageActions: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement("div", props, children),
    MessageResponse: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
  };
});

vi.mock("@/components/ai-elements/reasoning.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Reasoning: Passthrough,
    ReasoningContent: Passthrough,
    ReasoningTrigger: Passthrough,
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children, ...props }: { children?: ReactNode }) =>
    React.createElement("div", props, children);
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment: Passthrough,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    Attachments: Passthrough,
  };
});

vi.mock("@/ToolCallBlocks.js", async () => {
  const React = await import("react");
  return {
    ToolCallBlock: (props: Record<string, unknown>) => {
      toolCallBlockCapture.props.push(props);
      return React.createElement("div", { "data-testid": "mock-tool-call" });
    },
  };
});

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    layer: { acquire: vi.fn() },
    sendCommand: vi.fn(),
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
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
  // Bug 根因：Highspeed 历史消息改用可选服务以支持无 Provider 的只读渲染；
  // Vitest 的整模块 mock 未同步新导出，导致组件进入业务断言前就直接失败。
  useOptionalServices: () => null,
  useServices: () => ({
    zcodeSessionService: {
      updateProviderRegistry: vi.fn(),
    },
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
    draftConfigRef: { current: {} },
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    resolveInitialDraftConfig: vi.fn(() => ({})),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: (props: Record<string, unknown>) => {
      timelineCapture.props.push(props);
      return React.createElement("div", { "data-testid": "mock-timeline" });
    },
  };
});

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

const rowContext: ConversationRowRenderContext = {
  workspacePath: "/workspace",
  theme: "system",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};

function assistantText(
  rowId: number,
  text: string,
  state: AssistantTextRow["state"] = "complete",
): AssistantTextRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    state,
    text,
  };
}

function buildForRow(
  row: AssistantTextRow,
  rows: readonly AssistantTextRow[],
): AssistantPreviewCard[] {
  return buildAssistantPreviewCardsForAssistantTextRow({
    row,
    assistantTextRows: rows,
    latestAssistantTextRow: rows.at(-1),
    workspacePath: "/workspace",
    changedFilePaths: ["/workspace/README.md"],
  });
}

function baseUnit(assistantTextRows: readonly AssistantTextRow[]): ConversationTurnRenderUnit {
  const latestAssistantTextRow = assistantTextRows.at(-1);
  return {
    key: "turn-1:1",
    turnId: "turn-1",
    visibleUserInputs: [],
    assistantWorkRows: [...assistantTextRows],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows,
    leadingBoundaryRows: [],
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems: latestAssistantTextRow
      ? [{ kind: "assistantText", row: latestAssistantTextRow, latest: true }]
      : [],
    renderRows: [...assistantTextRows],
    isLastTurn: true,
    isRunning: false,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
}

function makeSnapshot(): ConversationSnapshot {
  return {
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      queueEdit: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
      sendQueuedNow: { allowed: true },
      setFollowupMode: { allowed: true },
      switchModelConfig: { allowed: true },
    },
    backgroundWorks: [],
    config: { followupMode: "queue", model: "", provider: "", thought: "" },
    control: {
      activeWorks: [],
      apiRetry: null,
      canStop: false,
      lastError: null,
      phase: "completedSuccess",
      sessionEnded: true,
      stopState: "idle",
      stopTargetKind: "unknown",
    },
    goal: null,
    inputRouting: { mode: "startNow" },
    logEpoch: "epoch-1",
    meta: { title: "Session", titleSource: "generated" },
    pendingCommands: [],
    pendingInteractions: [],
    plan: null,
    protocolVersion: 1,
    queue: { autoDrain: true, items: [] },
    revision: 1,
    rows: { firstRowId: null, totalCount: 0, window: [] },
    seq: 1,
    sessionId: "session-1",
    usage: {
      contextWindow: null,
      cumulative: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };
}

function renderTurn(unit: ConversationTurnRenderUnit): string {
  return renderTurnWithContext(unit, rowContext);
}

function renderTurnWithContext(
  unit: ConversationTurnRenderUnit,
  context: ConversationRowRenderContext,
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationTurnGroup, {
        unit,
        context,
      }),
    ),
  );
}

function renderTurnWithCodeComments(
  unit: ConversationTurnRenderUnit,
  context: ConversationRowRenderContext = rowContext,
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        AssistantCodeCommentFeatureProvider,
        { enabled: true },
        createElement(ConversationTurnGroup, { unit, context }),
      ),
    ),
  );
}

function toolCallRow(rowId: number, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Bash",
    status: "success",
    inputText: '{"command":"node build.js"}',
    input: { command: "node build.js" },
    output: { text: "ok" },
    ...overrides,
  };
}

function subagentRow(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    subagentType: "Explore",
    status: "success",
    summaryText: "done",
    childSessionId: `child-${rowId}`,
    ...overrides,
  };
}

function unitWithWorkRows(
  rows: ConversationTurnRenderUnit["assistantWorkRows"],
): ConversationTurnRenderUnit {
  return {
    key: "turn-1:tools",
    turnId: "turn-1",
    visibleUserInputs: [],
    assistantWorkRows: rows,
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    // Bugfix：Hook footer 将该字段升级为必填后，手写 turn fixture 也必须显式提供空集合，
    // 否则 SSR 会在计算 action row 时访问 undefined.some。
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: rows.length > 0 ? [{ kind: "assistantWork", rows }] : [],
    renderRows: rows,
    isLastTurn: true,
    isRunning: false,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
}

describe("v4 assistant preview cards helper", () => {
  it("builds a website card for a completed latest assistant row", () => {
    const row = assistantText(1, "Preview http://localhost:5173.");

    expect(buildForRow(row, [row])).toMatchObject([
      {
        type: "website",
        url: "http://localhost:5173",
      },
    ]);
  });

  it("builds interrupted turn cards from early assistant text but only for the latest row", () => {
    const early = assistantText(1, "Preview http://localhost:5173.");
    const latest = assistantText(2, "已停止。", "interrupted");

    expect(buildForRow(early, [early, latest])).toEqual([]);
    expect(buildForRow(latest, [early, latest])).toMatchObject([
      {
        type: "website",
        url: "http://localhost:5173",
      },
    ]);
  });

  it("does not build cards for streaming, failed, or non-latest rows", () => {
    const streaming = assistantText(1, "Preview http://localhost:5173.", "streaming");
    const failed = assistantText(2, "Preview http://localhost:5173.", "failed");
    const latest = assistantText(3, "done");

    expect(buildForRow(streaming, [streaming])).toEqual([]);
    expect(buildForRow(failed, [failed])).toEqual([]);
    expect(buildForRow(streaming, [streaming, latest])).toEqual([]);
  });

  it("merges multiple assistant text segments before deduping candidates", () => {
    const first = assistantText(1, "Preview http://localhost:5173 and README.md.");
    const latest = assistantText(2, "Again: http://localhost:5173 and ./README.md.");

    expect(buildForRow(latest, [first, latest]).map((card) => card.id)).toEqual([
      "markdown:/workspace/README.md",
      "website:http://localhost:5173",
    ]);
  });
});

describe("ConversationTurnGroup assistant preview cards", () => {
  it("renders preview cards once below the latest assistant text row", () => {
    const early = assistantText(1, "Preview http://localhost:5173.");
    const latest = assistantText(2, "Final answer.");
    const html = renderTurn(baseUnit([early, latest]));

    expect(html.match(/mock-assistant-preview-cards/g)).toHaveLength(1);
    expect(html).toContain('data-card-ids="website:http://localhost:5173"');
    expect(html.indexOf("Final answer.")).toBeLessThan(
      html.indexOf('data-testid="mock-assistant-preview-cards"'),
    );
  });

  it("passes file, code, and browser open handlers to preview cards", () => {
    const onOpenBrowserUrl = vi.fn();
    const onOpenCodeViewer = vi.fn();
    const onOpenFileLink = vi.fn();
    const row = assistantText(1, "Preview http://localhost:5173 and README.md.");
    const html = renderTurnWithContext(baseUnit([row]), {
      ...rowContext,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
    });

    expect(html).toContain('data-open-browser="true"');
    expect(html).toContain('data-open-code="true"');
    expect(html).toContain('data-open-file="true"');
  });
});

describe("ConversationTurnGroup assistant code-comment cards", () => {
  it("running turn 的 assistant text 即使落在 history renderer 也隐藏 code-comment 协议", () => {
    const directive = '::code-comment{title="Review" body="Action" file="src/main.ts"}';
    const [unit] = buildConversationTurnRenderUnits([
      {
        rowId: 1,
        turnId: "turn-1",
        createdAt: 1_700_000_000_001,
        createdAtSeq: 1,
        kind: "turnHeader",
        origin: "userInput",
        state: "running",
        startedAt: 1_700_000_000_001,
      },
      {
        rowId: 2,
        turnId: "turn-1",
        createdAt: 1_700_000_000_002,
        createdAtSeq: 2,
        kind: "userInput",
        text: "review",
        origin: "realUser",
      },
      assistantText(3, directive, "streaming"),
    ]);

    expect(unit?.isRunning).toBe(true);
    expect(unit?.latestAssistantTextRow).toBeUndefined();
    expect(unit?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3]);

    const html = renderTurnWithCodeComments(unit!);
    expect(html).not.toContain("::code-comment");
    expect(html).not.toContain("mock-assistant-code-comment-cards");
  });

  it("灰度关闭时保持既有正文原样且不展示卡片", () => {
    const directive = '::code-comment{title="Review" body="Action" file="src/main.ts"}';
    const html = renderTurn(baseUnit([assistantText(1, directive)]));

    expect(html).toContain("::code-comment");
    expect(html).not.toContain("mock-assistant-code-comment-cards");
  });

  it("灰度开启后隐藏有效指令，只在最新完成态正文下展示一次卡片", () => {
    const directive =
      '::code-comment{title="[P1] Null risk" body="Guard user" file="src/main.ts" start=8 priority=1}';
    const early = assistantText(1, "Checking.");
    const latest = assistantText(2, `Done.\n${directive}`);
    const html = renderTurnWithCodeComments(baseUnit([early, latest]));

    expect(html).toContain("Done.");
    expect(html).not.toContain("::code-comment");
    expect(html.match(/mock-assistant-code-comment-cards/g)).toHaveLength(1);
    expect(html).toContain('data-card-titles="[P1] Null risk"');
  });

  it("streaming 时隐藏协议尾部但不生成卡片，终态才生成卡片", () => {
    const onOpenCodeViewer = vi.fn();
    const completedDirective = '::code-comment{title="Ready" body="Open now" file="src/ready.ts"}';
    const streaming = assistantText(
      1,
      `正文\n${completedDirective}\n::code-comment{title="Partial" body="Still streaming`,
      "streaming",
    );
    const unit = { ...baseUnit([streaming]), isRunning: true };
    const html = renderTurnWithCodeComments(unit, {
      ...rowContext,
      onOpenCodeViewer,
    });

    expect(html).toContain("正文");
    expect(html).not.toContain("::code-comment");
    expect(html).not.toContain("mock-assistant-code-comment-cards");
    expect(html).not.toContain("Still streaming");

    const complete = assistantText(
      2,
      '::code-comment{title="Review" body="Action" file="src/main.ts"}',
    );
    const completeHtml = renderTurnWithCodeComments(baseUnit([complete]), {
      ...rowContext,
      onOpenCodeViewer,
    });
    expect(completeHtml).toContain('data-open-review="true"');
  });

  it("failed turn 不展示卡片并恢复整轮有效 directive 原文，避免早段评论静默丢失", () => {
    const earlyDirective =
      '::code-comment{title="Early review" body="Early action" file="src/early.ts"}';
    const failedDirective =
      '::code-comment{title="Failed review" body="Failed action" file="src/failed.ts"}';
    const early = assistantText(1, earlyDirective);
    const failed = assistantText(2, failedDirective, "failed");
    const html = renderTurnWithCodeComments({
      ...baseUnit([early, failed]),
      flowItems: [
        { kind: "assistantText", row: early, latest: false },
        { kind: "assistantText", row: failed, latest: true },
      ],
    });

    expect(html.match(/::code-comment/g)).toHaveLength(2);
    expect(html).toContain("Early review");
    expect(html).toContain("Failed review");
    expect(html).not.toContain("mock-assistant-code-comment-cards");
  });

  it("interrupted 轮尾仍投影已完整到达的卡片", () => {
    const interrupted = assistantText(
      1,
      'Stopped.\n::code-comment{title="Review" body="Action" file="src/main.ts"}',
      "interrupted",
    );
    const html = renderTurnWithCodeComments(baseUnit([interrupted]));

    expect(html).toContain("Stopped.");
    expect(html).not.toContain("::code-comment");
    expect(html).toContain("mock-assistant-code-comment-cards");
  });
});

describe("ConversationTurnGroup tool handler wiring", () => {
  it("passes file, code viewer, and browser handlers to normal, agent, and explore tool rows", () => {
    const onOpenBrowserUrl = vi.fn();
    const onOpenCodeViewer = vi.fn();
    const onOpenFileLink = vi.fn();
    toolCallBlockCapture.props = [];

    renderTurnWithContext(
      unitWithWorkRows([
        toolCallRow(1),
        toolCallRow(2, {
          toolName: "Agent",
          inputText: '{"prompt":"inspect"}',
          input: { prompt: "inspect" },
        }),
        subagentRow(3),
        toolCallRow(4, {
          inputText: '{"command":"ls -la"}',
          input: { command: "ls -la" },
        }),
      ]),
      {
        ...rowContext,
        onOpenBrowserUrl,
        onOpenCodeViewer,
        onOpenFileLink,
      },
    );

    expect(toolCallBlockCapture.props).toHaveLength(3);
    for (const props of toolCallBlockCapture.props) {
      expect(props.onOpenBrowserUrl).toBe(onOpenBrowserUrl);
      expect(props.onOpenCodeViewer).toBe(onOpenCodeViewer);
      expect(props.onOpenFileLink).toBe(onOpenFileLink);
    }
  });
});

describe("SessionPane assistant preview card handler wiring", () => {
  it("passes file, browser, and code viewer open handlers through rowContext", () => {
    const onOpenBrowserUrl = vi.fn();
    const onOpenCodeViewer = vi.fn();
    const onOpenFileLink = vi.fn();
    timelineCapture.props = [];
    projectionState.current = {
      lastError: null,
      loadingOlder: false,
      optimisticCommands: [],
      snapshot: makeSnapshot(),
      status: "live",
      subscriptionId: "sub-1",
    };

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
          onOpenBrowserUrl,
          onOpenCodeViewer,
          onOpenFileLink,
        }),
      ),
    );

    expect(timelineCapture.props).toHaveLength(1);
    expect(timelineCapture.props[0]?.rowContext).toMatchObject({
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
    });
  });
});
