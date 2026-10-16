import { readFileSync } from "node:fs";
import { createElement, type ContextType } from "react";
import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type {
  ApiRetryState,
  AssistantTextRow,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  TID_CHAT_WORKFLOW_ARTIFACT_CHIP,
  TID_CHAT_WORKFLOW_RUN_DIGEST,
  TID_CRON_CREATE_CARD,
  TID_CRON_CREATE_OPEN,
  testId,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import {
  completeHighspeedTurn,
  markHighspeedTurnMetricsPersisted,
  recordHighspeedTurn,
  setHighspeedCardTps,
} from "@/highspeed/highspeedTurnStore.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({}),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({
    highspeedCardService: { share: vi.fn() },
  }),
}));
const topicInterrupted = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/v4/botGroupDeliveryContext.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/botGroupDeliveryContext.js")>()),
  useBotTopicInterruption: topicInterrupted,
}));

const rowContext: ConversationRowRenderContext = {
  workspacePath: "/workspace",
  theme: "system",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};

const noopPlatform = {} as IPlatformService;

function reasoningRow(): ReasoningRow {
  return {
    rowId: 3,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_003,
    createdAtSeq: 3,
    kind: "reasoning",
    state: "complete",
    text: "完成了",
  };
}

function toolCallRow(
  rowId: number,
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    input,
    inputText: JSON.stringify(input),
    ...overrides,
  };
}

function subagentRow(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    subagentType: "Explore",
    status: "complete",
    summaryText: "完成分析",
    childSessionId: `child-session-${rowId}`,
    ...overrides,
  };
}

function assistantTextRow(
  rowId: number,
  overrides: Partial<AssistantTextRow> = {},
): AssistantTextRow {
  return {
    rowId,
    entityId: `message-assistant-${rowId}`,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    state: "complete",
    text: "完成回复",
    ...overrides,
  };
}

function hookInvocationRow(
  rowId: number,
  overrides: Partial<HookInvocationRow> = {},
): HookInvocationRow {
  return {
    rowId,
    turnId: "turn-complete",
    entityId: `hook-invocation-${rowId}`,
    productTurnId: "turn-complete",
    visibility: "visible",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "hookInvocation",
    hookInvocationId: `hook-invocation-${rowId}`,
    hookEventName: "PreToolUse",
    hookCount: 1,
    state: "completed",
    startedAt: 1_700_000_000_000 + rowId,
    endedAt: 1_700_000_000_010 + rowId,
    durationMs: 10,
    lane: "toolBefore",
    anchorToolCallId: "tool-3",
    executions: [
      {
        hookRunId: `hook-run-${rowId}`,
        hookIndex: 0,
        didExecute: true,
        state: "completed",
        outcome: "success",
        startedAt: 1_700_000_000_000 + rowId,
        endedAt: 1_700_000_000_010 + rowId,
        durationMs: 10,
        displayName: "validate-write",
        sourceKind: "project",
        toolName: "Write",
      },
    ],
    ...overrides,
  };
}

function runningTimelineRow(rowId: number): TimelineMarkerRow {
  return {
    rowId,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: {
      type: "compact",
      origin: "manual",
      status: "running",
    },
  };
}

function runningGoalVerifyTimelineRow(rowId: number): TimelineMarkerRow {
  return {
    rowId,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "goalVerify",
      iteration: 1,
      outcome: "running",
    },
  };
}

function forkNoticeTimelineRow(rowId: number): TimelineMarkerRow {
  return {
    rowId,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: "session-parent",
      parentRowId: 1,
    },
  };
}

function turnHeader(overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return {
    rowId: 1,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function userInputRow(rowId: number, overrides: Partial<UserInputRow> = {}): UserInputRow {
  return {
    rowId,
    turnId: "turn-complete",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    text: "看看项目",
    origin: "realUser",
    ...overrides,
  };
}

function baseUnit(overrides: Partial<ConversationTurnRenderUnit>): ConversationTurnRenderUnit {
  const synthesizedFlowItems: ConversationTurnRenderUnit["flowItems"] = [
    ...(overrides.visibleUserInputs ?? []).map((row) => ({
      kind: "userInput" as const,
      row,
    })),
    ...((overrides.assistantHistoryRows?.length ?? 0) > 0
      ? [
          {
            kind: "assistantHistory" as const,
            rows: overrides.assistantHistoryRows!,
          },
        ]
      : []),
    ...(overrides.latestAssistantTextRow
      ? [
          {
            kind: "assistantText" as const,
            row: overrides.latestAssistantTextRow,
            latest: true,
          },
        ]
      : []),
    ...((overrides.assistantFollowingRows?.length ?? 0) > 0
      ? [
          {
            kind: "assistantWork" as const,
            rows: overrides.assistantFollowingRows!,
          },
        ]
      : []),
  ];
  return {
    key: "turn-1:1",
    turnId: "turn-1",
    visibleUserInputs: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: synthesizedFlowItems,
    renderRows: [],
    isLastTurn: true,
    isRunning: false,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
    ...overrides,
  };
}

function renderUnit(
  unit: ConversationTurnRenderUnit,
  options: {
    locale?: "zh-CN" | "en-US";
    botContext?: ContextType<typeof DeliveryContext>;
    chatLoadingBlockedByActiveWork?: boolean;
    chatLoadingBlockedByInteraction?: boolean;
    compactForRemoteControl?: boolean;
    messageStreamShowReasoning?: boolean;
    messageStreamShowTodos?: boolean;
    apiRetry?: ApiRetryState | null;
    nowMs?: number;
    onFork?: (rowId: number) => void;
    onRetry?: (target: ConversationRowTarget) => void;
    onFeedbackChange?: (target: ConversationRowTarget, feedback: "like" | "dislike" | null) => void;
    /** 覆盖行渲染上下文的若干键（产物 chips 的门就是 `sessionId` + `onOpenWorkflowArtifact`）。 */
    context?: Partial<ConversationRowRenderContext>;
    shareSelection?: {
      eligibleRowIds: ReadonlySet<number>;
      selectedRowIds: ReadonlySet<number>;
      onToggle: (rowId: number) => void;
    };
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      DeliveryContext.Provider,
      { value: options.botContext ?? null },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: options.locale ?? "zh-CN" },
        createElement(
          PlatformProvider,
          { platform: noopPlatform },
          createElement(
            TooltipProvider,
            null,
            createElement(ConversationTurnGroup, {
              unit,
              nowMs: options.nowMs,
              apiRetry: options.apiRetry,
              context: {
                ...rowContext,
                chatLoadingBlockedByActiveWork: options.chatLoadingBlockedByActiveWork,
                chatLoadingBlockedByInteraction: options.chatLoadingBlockedByInteraction,
                compactForRemoteControl: options.compactForRemoteControl,
                messageStreamShowReasoning: options.messageStreamShowReasoning,
                messageStreamShowTodos: options.messageStreamShowTodos,
                ...options.context,
              },
              onFork: options.onFork,
              onRetry: options.onRetry,
              onFeedbackChange: options.onFeedbackChange,
              shareSelection: options.shareSelection,
            }),
          ),
        ),
      ),
    ),
  );
}

describe("ConversationTurnGroup layout", () => {
  it("shows a checked share toggle before a selectable conversation turn", () => {
    const [unit] = buildConversationTurnRenderUnits([turnHeader(), userInputRow(2)]);
    const html = renderUnit(unit!, {
      shareSelection: {
        eligibleRowIds: new Set([2]),
        selectedRowIds: new Set([2]),
        onToggle: vi.fn(),
      },
    });

    expect(html).toContain('data-conversation-share-turn-toggle="true"');
    expect(html).toContain('data-conversation-share-turn-toggle-state="selected"');
    expect(html).toContain("top-1/2");
    expect(html).toContain("-translate-y-1/2");
    expect(html).toContain('data-state="checked"');
  });

  it("marks the share toggle indeterminate when a steered turn is only partially selected", () => {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      userInputRow(3, { text: "顺便看看测试" }),
    ]);
    const html = renderUnit(unit!, {
      shareSelection: {
        eligibleRowIds: new Set([2, 3]),
        selectedRowIds: new Set([2]),
        onToggle: vi.fn(),
      },
    });

    expect(html).toContain('data-conversation-share-turn-toggle-state="partial"');
    expect(html).toContain('data-state="indeterminate"');
    expect(html).not.toContain('data-conversation-share-turn-toggle-state="unselected"');
  });

  it("keeps the share toggle unselected when no row of a steered turn is selected", () => {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      userInputRow(3, { text: "顺便看看测试" }),
    ]);
    const html = renderUnit(unit!, {
      shareSelection: {
        eligibleRowIds: new Set([2, 3]),
        selectedRowIds: new Set(),
        onToggle: vi.fn(),
      },
    });

    expect(html).toContain('data-conversation-share-turn-toggle-state="unselected"');
    expect(html).not.toContain('data-state="indeterminate"');
  });

  it("uses the conversation container for narrow horizontal padding", () => {
    const [unit] = buildConversationTurnRenderUnits([turnHeader(), userInputRow(2)]);
    const html = renderUnit(unit!);

    expect(html).toContain("px-4 @md/conversation:px-6");
    expect(html).not.toContain("@max-md/conversation:px-4");
    expect(html).not.toContain("px-6 max-md:px-2");
  });

  it("removes the complete external assistant container after its response becomes CUA", () => {
    const responseId = "assistant-response-cua";
    const message = assistantTextRow(3, {
      assistantResponseId: responseId,
      text: "我先检查电脑操作权限与应用列表。",
    });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      message,
      toolCallRow(
        4,
        "mcp__computer-use__list_apps",
        {},
        {
          assistantResponseId: responseId,
        },
      ),
    ]);
    const html = renderUnit(unit!);

    expect(unit?.flowItems.map((item) => item.kind)).toContain("cuaGroup");
    expect(unit?.flowItems.some((item) => item.kind === "assistantText")).toBe(false);
    const group = unit?.flowItems.find((item) => item.kind === "cuaGroup");
    expect(
      group?.kind === "cuaGroup"
        ? group.events.some((event) => event.kind === "assistantMessage" && event.row === message)
        : false,
    ).toBe(true);
    expect(html).not.toContain(`data-row-id="${message.rowId}"`);
  });

  it("groups response reasoning and counts only reasoning visible under the existing setting", () => {
    const responseId = "assistant-response-cua-reasoning";
    const firstReasoning: ReasoningRow = {
      ...reasoningRow(),
      rowId: 3,
      assistantResponseId: responseId,
      text: "先确认飞书权限",
    };
    const secondReasoning: ReasoningRow = {
      ...reasoningRow(),
      rowId: 4,
      createdAtSeq: 4,
      assistantResponseId: responseId,
      text: "再观察飞书界面",
    };
    const message = assistantTextRow(5, {
      assistantResponseId: responseId,
      text: "现在观察飞书窗口状态。",
    });
    const rows = [
      turnHeader(),
      userInputRow(2),
      firstReasoning,
      secondReasoning,
      message,
      toolCallRow(
        6,
        "mcp__computer-use__get_app_state",
        {},
        {
          assistantResponseId: responseId,
        },
      ),
    ];
    const [hiddenUnit] = buildConversationTurnRenderUnits(rows);
    const hiddenHtml = renderUnit(hiddenUnit!, { messageStreamShowReasoning: false });
    const visibleHtml = renderUnit(hiddenUnit!, { messageStreamShowReasoning: true });

    expect(hiddenUnit?.flowItems.map((item) => item.kind)).toContain("cuaGroup");
    expect(hiddenHtml).toContain("3 个事件, 1 条消息");
    expect(hiddenHtml).not.toContain("4 个事件");
    expect(visibleHtml).toContain("4 个事件, 1 条消息");
  });

  it("does not mount an empty history collapsible after inner work projection", () => {
    const deferredShell = toolCallRow(3, "Bash", {}, { status: "running" });
    const html = renderUnit(
      baseUnit({
        assistantWorkRows: [deferredShell],
        assistantHistoryRows: [deferredShell],
        assistantHistoryDefaultOpen: true,
        renderRows: [deferredShell],
      }),
    );

    expect(html).not.toContain("chat-assistant-history-content");
    expect(html).not.toContain('<div class="pt-5"><div class="flex flex-col gap-4"></div></div>');
  });
});

describe("ConversationTurnGroup Hook footer", () => {
  it("HK08 renders the Hook action after turn-local content and before the tail boundary", () => {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      toolCallRow(3, "Write", { file_path: "README.md" }),
      assistantTextRow(4),
      hookInvocationRow(5),
      forkNoticeTimelineRow(6),
    ]);
    const html = renderUnit(unit!, { compactForRemoteControl: true });
    const assistantIndex = html.indexOf("完成回复");
    const hookIndex = html.indexOf('data-testid="v4-hook-details-trigger-turn-complete"');
    const boundaryIndex = html.indexOf("从对话中派生");

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(hookIndex).toBeGreaterThan(assistantIndex);
    expect(boundaryIndex).toBeGreaterThan(hookIndex);
    expect(html.match(/data-testid="v4-hook-details-trigger-turn-complete"/g)).toHaveLength(1);
  });

  it.each(
    [false, true].flatMap((compactForRemoteControl) =>
      [false, true].flatMap((highspeed) =>
        [false, true].map((hasAssistantText) => ({
          compactForRemoteControl,
          highspeed,
          hasAssistantText,
        })),
      ),
    ),
  )(
    "HK08/HK11 每轮仅一个 Hook 入口：mobile=$compactForRemoteControl highspeed=$highspeed text=$hasAssistantText",
    ({ compactForRemoteControl, highspeed, hasAssistantText }) => {
      const [unit] = buildConversationTurnRenderUnits([
        turnHeader({ state: hasAssistantText ? "completedSuccess" : "completedInterrupted" }),
        userInputRow(2, {
          ...(highspeed
            ? {
                highspeed: {
                  schemaVersion: 1,
                  cardId: "hsc-hook-footer",
                  taskId: "session-hook-footer",
                  provider: "zai",
                  model: "glm-5",
                  issuedAt: 1_000,
                  expiresAt: 10_000,
                },
              }
            : {}),
        }),
        hookInvocationRow(3),
        ...(hasAssistantText ? [assistantTextRow(4)] : []),
        forkNoticeTimelineRow(5),
      ]);
      const html = renderUnit(
        { ...unit!, showHighspeedOutputFooter: highspeed },
        { compactForRemoteControl },
      );

      // 冲突合并曾把 Hook-only 分支接成 Highspeed footer 的 else：
      // 普通有正文时重复显示，Highspeed 无正文时则完全丢失。
      expect(html.match(/data-testid="v4-hook-details-trigger-turn-complete"/g) ?? []).toHaveLength(
        1,
      );
      expect(html.includes('data-highspeed-output-footer="true"')).toBe(highspeed);
      expect(html.indexOf("v4-hook-details-trigger-turn-complete")).toBeLessThan(
        html.indexOf("从对话中派生"),
      );
      expect(html.includes('data-testid="v4-copy-4"')).toBe(hasAssistantText);
    },
  );

  it("HK11 renders a Hook-only action row for a terminal turn without assistant text", () => {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({ state: "failed" }),
      userInputRow(2),
      hookInvocationRow(3),
    ]);
    const html = renderUnit(unit!, { compactForRemoteControl: true });

    expect(html).toContain('data-testid="v4-hook-details-trigger-turn-complete"');
    expect(html.match(/data-testid="v4-copy-/g)).toHaveLength(1);
    expect(html).not.toContain("v4-feedback-like");
    expect(html).not.toContain("chat-assistant-history-trigger");
  });

  it("HK09 does not render an action when every Hook execution was blocked before start", () => {
    const blocked = hookInvocationRow(3, {
      executions: [
        {
          hookRunId: "blocked-before-start",
          hookIndex: 0,
          didExecute: false,
          state: "completed",
          outcome: "blocked",
          startedAt: 1_700_000_000_003,
          endedAt: 1_700_000_000_003,
          durationMs: 0,
          displayName: "blocked-project-hook",
          sourceKind: "project",
        },
      ],
    });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      blocked,
      assistantTextRow(4),
    ]);

    expect(renderUnit(unit!, { compactForRemoteControl: true })).not.toContain(
      "v4-hook-details-trigger",
    );
  });

  it("HK17 does not render a Hook action on a timeline-only maintenance turn carrying legacy executed Hook rows", () => {
    // Bug 根因：首条输入即 /compact 时 SessionStart Hook 曾被错误挂到 compact 维护 turn；
    // 旧历史/旧投影数据可能仍含 timelineOnly + didExecute=true 组合。维护 turn 与普通
    // assistant action 共用 turn eligibility：timelineOnly 不渲染 Hook 图标或空操作栏。
    const compactMarker = runningTimelineRow(2);
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({ state: "completedSuccess" }),
      compactMarker,
      hookInvocationRow(3),
    ]);
    expect(unit?.timelineOnly).toBe(true);
    expect(unit?.hookInvocations.length).toBe(1);

    const html = renderUnit(unit!, { compactForRemoteControl: true });
    expect(html).not.toContain("v4-hook-details-trigger");
    // 也不得留下只有 Hook 的空操作栏外壳。
    expect(html).not.toContain("v4-copy-");
  });
});

describe("ConversationTurnGroup message stream display settings", () => {
  const reasoning = reasoningRow();
  const todo = toolCallRow(4, "TodoWrite", {
    todos: [
      {
        content: "补齐设置接线",
        status: "in_progress",
        activeForm: "补齐设置接线",
      },
    ],
  });
  const shell = toolCallRow(5, "Bash", { command: "pnpm test" });
  const laterReasoning: ReasoningRow = {
    ...reasoningRow(),
    rowId: 6,
    createdAt: 1_700_000_000_006,
    createdAtSeq: 6,
    text: "后续思考",
  };
  const finalText = assistantTextRow(7);
  const [builtUnit] = buildConversationTurnRenderUnits([
    turnHeader(),
    userInputRow(2),
    reasoning,
    todo,
    shell,
    laterReasoning,
    finalText,
  ]);
  const unit = {
    ...builtUnit!,
    assistantHistoryDefaultOpen: true,
  };

  it.each([
    {
      label: "两个开关都关闭",
      showReasoning: false,
      showTodos: false,
      todoVisible: false,
    },
    {
      label: "只开启显示思考过程",
      showReasoning: true,
      showTodos: false,
      todoVisible: false,
    },
    {
      label: "只开启显示待办",
      showReasoning: false,
      showTodos: true,
      todoVisible: true,
    },
    {
      label: "两个开关都开启",
      showReasoning: true,
      showTodos: true,
      todoVisible: true,
    },
  ])("$label 时独立控制 reasoning 与 Todo", (scenario) => {
    const html = renderUnit(unit, {
      messageStreamShowReasoning: scenario.showReasoning,
      messageStreamShowTodos: scenario.showTodos,
    });

    // 每轮第一条 reasoning 不受开关影响；后续 reasoning 只在开关开启时展示。
    expect(html).toContain('data-row-id="3"');
    expect(html.includes('data-row-id="6"')).toBe(scenario.showReasoning);
    expect(html.includes('data-tool-call-id="tool-4"')).toBe(scenario.todoVisible);
    // 单个 Execute 不创建父分组，仍直接展示原始工具。
    expect(html).toContain("tool-summary-trigger-tool-5");
  });

  it("关闭思考时跨隐藏 reasoning 合并 Explore，开启时保持原始边界", () => {
    const firstReasoning = reasoningRow();
    const firstExplore = toolCallRow(4, "Read", { file_path: "package.json" });
    const hiddenReasoning: ReasoningRow = {
      ...reasoningRow(),
      rowId: 5,
      createdAt: 1_700_000_000_005,
      createdAtSeq: 5,
      text: "检查下一处",
    };
    const secondExplore = toolCallRow(6, "Bash", {
      command: "rg test packages/ui",
    });
    const finalText = assistantTextRow(7);
    const [builtUnit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      firstReasoning,
      firstExplore,
      hiddenReasoning,
      secondExplore,
      finalText,
    ]);
    const exploreUnit = {
      ...builtUnit!,
      assistantHistoryDefaultOpen: true,
    };

    const hiddenReasoningHtml = renderUnit(exploreUnit, {
      messageStreamShowReasoning: false,
    });
    expect(hiddenReasoningHtml).toContain('data-tool-call-id="explore:tool-4"');
    expect(hiddenReasoningHtml).not.toContain('data-row-id="5"');

    const visibleReasoningHtml = renderUnit(exploreUnit, {
      messageStreamShowReasoning: true,
    });
    expect(visibleReasoningHtml).toContain('data-tool-call-id="tool-4"');
    expect(visibleReasoningHtml).toContain('data-tool-call-id="tool-6"');
    expect(visibleReasoningHtml).toContain('data-row-id="5"');
  });
});

describe("ConversationTurnGroup assistant history status", () => {
  it("会话内分享只打开本地卡片，不再调用后端分享接口", () => {
    const source = readFileSync("packages/ui/src/v4/ConversationTurnGroup.tsx", "utf8");

    expect(source).toContain("setHighspeedShareDialogOpen(true)");
    expect(source).toContain("<HighspeedShareDialog");
    expect(source).not.toContain("highspeedCardService.share");
  });

  it("冷恢复后从 userInput metadata 保留 accelerated output 的紫色工时", () => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-cold-history",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-cold-history",
        taskId: "session-highspeed-cold-history",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        regularTps: 73,
        highspeedTps: 136,
        outputTokens: 120_000,
        durationMs: 881_000,
        savedDurationMs: 763_000,
      },
    });
    const work = reasoningRow();

    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        workStatus: { state: "completed", durationMs: 881_000 },
        assistantWorkRows: [work],
        assistantHistoryRows: [work],
        renderRows: [input, work],
        showHighspeedOutputFooter: true,
      }),
    );

    expect(html).toContain("已工作 14 分 41 秒");
    expect(html).toContain('data-highspeed-duration="true"');
    expect(html).toContain("text-icon-purple");
    expect(html).toContain("节省约 12 分 43 秒");
    expect(html).toContain('data-highspeed-saved-duration="true"');
    expect(html).toContain('data-highspeed-status-tag="true"');
    expect(html).not.toContain('data-highspeed-gradient="true"');
    expect(html).toContain("HighSpeed");
    expect(html).toContain('data-highspeed-output-footer="true"');
    expect(html).toContain("以上由 Highspeed 生成");
    expect(html).toContain('data-highspeed-output-share="true"');
    expect(html).toContain("查看");
    const shareButton = html.match(/<button[^>]*data-highspeed-output-share="true"[^>]*>/)?.[0];
    expect(shareButton).toBeDefined();
    expect(shareButton).not.toMatch(/\sdisabled(?:=""|(?=[\s>]))/);
    expect(shareButton).toContain("h-7");
    expect(shareButton).toContain("gap-1");
    expect(shareButton).toContain("rounded-[8px]");
    expect(shareButton).toContain("px-2");
    expect(shareButton).toContain("py-1");
    expect(shareButton).toContain("font-medium");
    expect(html).toContain('data-highspeed-output-share-icon="true"');
    expect(html).not.toContain('data-highspeed="true"');
  });

  it("卡失效降级后仍允许分享当前 Turn 的完整统计", () => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-fallback-share",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-fallback-share",
        taskId: "session-fallback-share",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        regularTps: 73,
        highspeedTps: 136,
        outputTokens: 120_000,
        durationMs: 881_000,
        savedDurationMs: 763_000,
        fallbackAt: 10_001,
      },
    });
    const work = reasoningRow();

    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        workStatus: { state: "completed", durationMs: 881_000 },
        assistantWorkRows: [work],
        assistantHistoryRows: [work],
        renderRows: [input, work],
        showHighspeedOutputFooter: true,
      }),
    );

    const shareButton = html.match(/<button[^>]*data-highspeed-output-share="true"[^>]*>/)?.[0];
    expect(shareButton).toBeDefined();
    expect(shareButton).not.toMatch(/\sdisabled(?:=""|(?=[\s>]))/);
  });

  it("缺少 durationMs 仍允许按 token 与 TPS 分享", () => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-share-without-duration",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-share-without-duration",
        taskId: "session-share-without-duration",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        outputTokens: 120_000,
        regularTps: 73,
        highspeedTps: 136,
      },
    });

    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        workStatus: { state: "completed", durationMs: 881_000 },
        assistantWorkRows: [reasoningRow()],
        assistantHistoryRows: [reasoningRow()],
        renderRows: [input, reasoningRow()],
        showHighspeedOutputFooter: true,
      }),
    );

    const shareButton = html.match(/<button[^>]*data-highspeed-output-share="true"[^>]*>/)?.[0];
    expect(shareButton).toBeUndefined();
  });

  it("总体加速倍率不大于 1.2x 时保留 footer 但隐藏分享入口", () => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-low-speedup",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-low-speedup",
        taskId: "session-low-speedup",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        regularTps: 73,
        highspeedTps: 100,
        outputTokens: 120_000,
        durationMs: 881_000,
        savedDurationMs: 100_000,
      },
    });
    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        workStatus: { state: "completed", durationMs: 881_000 },
        assistantWorkRows: [reasoningRow()],
        assistantHistoryRows: [reasoningRow()],
        renderRows: [input, reasoningRow()],
        showHighspeedOutputFooter: true,
      }),
    );

    expect(html).toContain('data-highspeed-output-footer="true"');
    expect(html).not.toContain('data-highspeed-output-share="true"');
  });

  it("Highspeed 生成期间只显示标签，不提前显示持久化的节省时间", () => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-running",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-running",
        taskId: "session-highspeed-running",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        regularTps: 73,
        outputTokens: 120_000,
        durationMs: 881_000,
        savedDurationMs: 763_000,
      },
    });
    const work = reasoningRow();

    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        // 多段输出中，前段可已完成但整轮仍在生成；节省时间必须服从整轮终态。
        workStatus: { state: "completed", durationMs: 5_000 },
        assistantWorkRows: [work],
        assistantHistoryRows: [work],
        renderRows: [input, work],
        isRunning: true,
      }),
      { nowMs: 9_999 },
    );

    expect(html).toContain('data-highspeed-status-tag="true"');
    expect(html).toContain('data-highspeed-gradient="true"');
    expect(html).toContain("highspeed-animated-gradient-text");
    expect(html).toContain("HighSpeed");
    expect(html).not.toContain('data-highspeed-saved-duration="true"');
    expect(html).not.toContain("节省约");
  });

  it("Highspeed 卡过期后执行中的 Tool 恢复普通流光样式", () => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-expired-running-tool",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-expired-running-tool",
        taskId: "session-expired-running-tool",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
      },
    });
    const runningTool = toolCallRow(3, "Bash", { command: "pnpm test" }, { status: "running" });

    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        assistantWorkRows: [runningTool],
        assistantHistoryRows: [runningTool],
        renderRows: [input, runningTool],
        isRunning: true,
      }),
      { nowMs: 10_001 },
    );

    expect(html).not.toContain('data-highspeed-gradient="true"');
    expect(html).not.toContain("highspeed-animated-gradient-text");
  });

  it("普通 output 和仍在运行的 accelerated output 不显示 Highspeed 来源 footer", () => {
    const work = reasoningRow();
    const ordinaryHtml = renderUnit(
      baseUnit({
        visibleUserInputs: [userInputRow(2, { sourceCommandId: "command-ordinary-footer" })],
        workStatus: { state: "completed", durationMs: 5_000 },
        assistantWorkRows: [work],
        assistantHistoryRows: [work],
        renderRows: [work],
      }),
    );
    const runningHtml = renderUnit(
      baseUnit({
        visibleUserInputs: [
          userInputRow(2, {
            sourceCommandId: "command-highspeed-running-footer",
            highspeed: {
              schemaVersion: 1,
              cardId: "hsc-running-footer",
              taskId: "session-running-footer",
              provider: "zai",
              model: "glm-5",
              issuedAt: 1_000,
              expiresAt: 10_000,
            },
          }),
        ],
        workStatus: { state: "running", durationMs: 5_000 },
        assistantWorkRows: [work],
        assistantHistoryRows: [work],
        renderRows: [work],
        isRunning: true,
        showHighspeedOutputFooter: true,
      }),
      { nowMs: 9_999 },
    );

    expect(ordinaryHtml).not.toContain('data-highspeed-output-footer="true"');
    expect(ordinaryHtml).not.toContain('data-highspeed-gradient="true"');
    expect(runningHtml).not.toContain('data-highspeed-output-footer="true"');
    expect(runningHtml).toContain('data-highspeed-gradient="true"');
  });

  it.each([
    { label: "中断", workStatus: { state: "interrupted" as const, durationMs: 100 } },
    { label: "异常", workStatus: undefined },
  ])("Highspeed 组尾$label且自身无输出时仍展示可用分享入口", ({ workStatus }) => {
    const input = userInputRow(2, {
      sourceCommandId: "command-highspeed-terminal-footer",
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-terminal-footer",
        taskId: "session-terminal-footer",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        regularTps: 20,
        highspeedTps: 50,
        outputTokens: 0,
        durationMs: 100,
      },
    });
    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        ...(workStatus ? { workStatus } : {}),
        showHighspeedOutputFooter: true,
        highspeedOutputFooterTarget: {
          cardId: "hsc-terminal-footer",
          metrics: {
            outputTokens: 10,
            durationMs: 300,
            regularTps: 20,
            highspeedTps: 50,
          },
        },
      }),
    );

    expect(html).toContain('data-highspeed-output-footer="true"');
    const shareButton = html.match(/<button[^>]*data-highspeed-output-share="true"[^>]*>/)?.[0];
    expect(shareButton).toBeDefined();
    expect(shareButton).not.toMatch(/\sdisabled(?:=""|(?=[\s>]))/);
  });

  it("只用紫色工时标识 accelerated output，input 保持普通样式", () => {
    const sourceCommandId = "command-highspeed-output-duration";
    const input = userInputRow(2, { sourceCommandId });
    const work = reasoningRow();
    recordHighspeedTurn({
      sessionId: "session-highspeed-output-duration",
      sourceCommandId,
      card: {
        cardId: "hsc-output-duration",
        taskId: "session-highspeed-output-duration",
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
        regularTps: 73,
      },
      createdAt: 1_000,
    });
    completeHighspeedTurn({
      sourceCommandId,
      outputTokens: 120_000,
      durationMs: 881_000,
      completedAt: 882_000,
    });
    setHighspeedCardTps("hsc-output-duration", 136);
    markHighspeedTurnMetricsPersisted(sourceCommandId, 763_000, 882_001);

    const html = renderUnit(
      baseUnit({
        visibleUserInputs: [input],
        workStatus: { state: "completed", durationMs: 881_000 },
        assistantWorkRows: [work],
        assistantHistoryRows: [work],
        renderRows: [input, work],
        showHighspeedOutputFooter: true,
      }),
    );

    expect(html).toContain("已工作 14 分 41 秒");
    expect(html).toContain('data-highspeed-duration="true"');
    expect(html).toContain("text-icon-purple");
    expect(html).toContain('data-highspeed-status-tag="true"');
    expect(html).toContain("HighSpeed");
    const shareButton = html.match(/<button[^>]*data-highspeed-output-share="true"[^>]*>/)?.[0];
    expect(shareButton).toBeDefined();
    expect(shareButton).not.toMatch(/\sdisabled(?:=""|(?=[\s>]))/);
    expect(html).not.toContain('data-highspeed="true"');
  });

  it("H17：切模型后的 /goal query 与 continuation 合计只显示一个工作状态", () => {
    const startedAt = 1_700_000_000_000;
    const units = buildConversationTurnRenderUnits(
      [
        {
          rowId: 1,
          turnId: "turn-goal",
          createdAt: startedAt,
          createdAtSeq: 1,
          kind: "timelineMarker",
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            fromProvider: "zhipu",
            fromModel: "glm-5.2-highspeed",
            toProvider: "deepseek",
            toModel: "deepseek-v4-flash",
            toThought: "max",
          },
        },
        turnHeader({
          rowId: 2,
          turnId: "turn-goal",
          executionKind: "controlOnly",
          activeMs: 0,
        }),
        userInputRow(3, {
          turnId: "turn-goal",
          text: "/Goal 开发一个招投标管理系统",
        }),
        turnHeader({
          rowId: 4,
          turnId: "turn-continuation",
          origin: "goalContinuation",
          executionKind: "agent",
          state: "running",
          startedAt,
        }),
      ],
      { nowMs: startedAt + 3_000 },
    );

    const html = units.map((unit) => renderUnit(unit)).join("");
    expect(html).not.toContain("/Goal");
    expect(html).toContain("Goal");
    expect(html).toContain("开发一个招投标管理系统");
    expect(html).not.toContain("已工作 1 秒");
    expect(html.match(/工作中 3 秒/g)).toHaveLength(1);
    expect(html.match(/chat-assistant-history-trigger/g)).toHaveLength(1);
  });

  it("labels a running turn as working with the elapsed duration", () => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
        workStatus: { state: "running", durationMs: 5_000 },
      }),
    );

    expect(html).toContain("工作中 5 秒");
  });

  it("ETS01/ETS03：运行工作段尾部的单个 Explore 工具不创建父分组", () => {
    const explore = toolCallRow(10, "Read", { file_path: "AGENTS.md" });
    const text = assistantTextRow(11);
    const tailHtml = renderUnit(
      baseUnit({
        isRunning: true,
        workStatus: { state: "running", durationMs: 5_000 },
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [explore],
        assistantHistoryRows: [explore],
        renderRows: [explore],
      }),
    );
    const boundedHtml = renderUnit(
      baseUnit({
        isRunning: true,
        workStatus: { state: "running", durationMs: 5_000 },
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [explore, text],
        assistantHistoryRows: [explore],
        latestAssistantTextRow: text,
        assistantTextRows: [text],
        renderRows: [explore, text],
      }),
    );

    expect(tailHtml).toContain('data-tool-call-id="tool-10"');
    expect(tailHtml).not.toContain('data-tool-call-id="explore:tool-10"');
    expect(tailHtml).not.toContain("animated-gradient-text");
    expect(boundedHtml).not.toContain("animated-gradient-text");
  });

  it("labels a completed turn as worked with the final duration", () => {
    const row = reasoningRow();
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:1",
        turnId: "turn-complete",
        isLastTurn: false,
        workStatus: { state: "completed", durationMs: 5_000 },
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        renderRows: [row],
      }),
    );

    expect(html).toContain("已工作 5 秒");
    expect(html).not.toContain("工作中 5 秒");
  });

  it("labels an authoritative topic interruption separately from a manual stop", () => {
    topicInterrupted.mockReturnValue(true);
    try {
      const row = reasoningRow();
      const unit = baseUnit({
        workStatus: { state: "interrupted", durationMs: 1000 },
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        renderRows: [row],
      });
      expect(renderUnit(unit, { locale: "zh-CN" })).toContain("已被新消息中断");
      expect(renderUnit(unit, { locale: "en-US" })).toContain("Interrupted by a new message");
    } finally {
      topicInterrupted.mockReturnValue(false);
    }
  });

  it("labels an interrupted turn as stopped without duration", () => {
    const row = reasoningRow();
    const interruptedUnit = baseUnit({
      key: "turn-interrupted:1",
      turnId: "turn-interrupted",
      assistantHistoryDefaultOpen: true,
      workStatus: { state: "interrupted", durationMs: 5_000 },
      assistantWorkRows: [row],
      assistantHistoryRows: [row],
      renderRows: [row],
    });

    expect(renderUnit(interruptedUnit, { locale: "en-US" })).toContain("Stopped");
    expect(renderUnit(interruptedUnit, { locale: "en-US" })).not.toContain("Worked for 5s");
    expect(renderUnit(interruptedUnit, { locale: "zh-CN" })).toContain("已停止");
    expect(renderUnit(interruptedUnit, { locale: "zh-CN" })).not.toContain("已工作 5 秒");
  });

  it("按语言格式化工作时长的单位间距", () => {
    const row = reasoningRow();
    const completedUnit = baseUnit({
      key: "turn-complete:localized-duration",
      turnId: "turn-complete",
      isLastTurn: false,
      workStatus: { state: "completed", durationMs: 450_000 },
      assistantWorkRows: [row],
      assistantHistoryRows: [row],
      renderRows: [row],
    });

    expect(renderUnit(completedUnit, { locale: "en-US" })).toContain("Worked for 7m 30s");
    expect(renderUnit(completedUnit, { locale: "zh-CN" })).toContain("已工作 7 分 30 秒");
  });

  it.each([
    ["subagent", "Review the projection chain"],
    ["bash", "pnpm typecheck"],
    // 回归：dwf run 的终态回合也走后台结果头。标题由 CLI 的 workflowTaskSubject 铸造并经
    // originMeta.title 送上来（rows.ts 的 backgroundResultOriginMetaSchema 要求 min(1)），
    // UI 侧不本地化——与 bash / subagent 完全同构。漏掉这一支的表现是整条 run 完成之后
    // 那一轮既没有标题、也退化成普通 assistant 的工时折叠。
    ["workflow", "Fan out the review across three actors"],
  ] as const)(
    "BG27/BG28：%s background result 用任务标题永久展开历史",
    (backgroundSource, title) => {
      const earlyText = assistantTextRow(4, { text: "后台总结第一段" });
      const tool = toolCallRow(5, "Read", { file_path: "AGENTS.md" });
      const finalText = assistantTextRow(6, { text: "后台总结最终段" });
      const [unit] = buildConversationTurnRenderUnits([
        turnHeader({
          origin: "backgroundResult",
          originMeta: {
            backgroundSource,
            title,
            workId: `${backgroundSource}-work`,
          },
          activeMs: 12_000,
        }),
        earlyText,
        tool,
        finalText,
      ]);
      const html = renderUnit(unit!);

      expect(html).toContain(`data-testid="chat-background-result-title-${unit!.key}"`);
      expect(html).toContain(title);
      expect(html).toContain("后台总结第一段");
      expect(html).toContain("tool-5");
      expect(html).toContain("后台总结最终段");
      expect(html.indexOf("后台总结第一段")).toBeLessThan(html.indexOf("tool-5"));
      expect(html.indexOf("tool-5")).toBeLessThan(html.indexOf("后台总结最终段"));
      expect(html).not.toContain("已工作 12 秒");
      expect(html).not.toContain("chat-assistant-history-trigger");
      expect(html).not.toContain("chat-assistant-history-content");
      expect(html).not.toContain("data-history-open");
    },
  );

  it("workflow 通知带载荷时渲染工具卡语法的通知行，替换裸标题行", () => {
    // docs/dynamic-workflow/transcript-and-notifications.md「The notification row」：backgroundSource==="workflow"
    // 且 workflowNotification 在场 → ToolLayout 通知行（自带 testid），不再走裸标题行。
    const finalText = assistantTextRow(6, { text: "后台总结最终段" });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        origin: "backgroundResult",
        originMeta: {
          backgroundSource: "workflow",
          title: "flaky-test-triage",
          workId: "run-abc",
          workflowNotification: {
            kind: "terminal",
            status: "completed",
            summary: "Workflow run completed: 3 flaky tests triaged.",
            durationMs: 252_000,
          },
        },
      }),
      finalText,
    ]);
    const html = renderUnit(unit!, { locale: "en-US" });

    expect(html).toContain(`data-testid="chat-workflow-notification-row-${unit!.key}"`);
    // 裸标题行的 testid 缺席——通知行取而代之。
    expect(html).not.toContain(`data-testid="chat-background-result-title-${unit!.key}"`);
    expect(html).toContain("flaky-test-triage");
    // kindLabel 承载状态（不再是 run 详情页的 Completed）。
    expect(html).toContain("Workflow completed");
    // 通知行之下的 assistant 反应行不受影响。
    expect(html).toContain("后台总结最终段");
    // 2026-09-03 tweak：通知卡是轮内第一个节点，轮容器去掉 pt-14（只贴上一轮 pb-5）。
    expect(html).toMatch(/<section[^>]*class="[^"]*\bpt-0\b/u);
    expect(html).not.toMatch(/<section[^>]*class="[^"]*\bpt-14\b/u);
  });

  it("裸标题行（bash / subagent / 无载荷 workflow）保留轮顶 pt-14", () => {
    // 范围裁决：只有通知卡去留白；标题行带底 rule，是分节头语义，轮顶间距照旧。
    for (const backgroundSource of ["bash", "subagent", "workflow"] as const) {
      const [unit] = buildConversationTurnRenderUnits([
        turnHeader({
          origin: "backgroundResult",
          originMeta: { backgroundSource, title: "bare-title", workId: `${backgroundSource}-1` },
        }),
        assistantTextRow(6, { text: "后台总结最终段" }),
      ]);
      const html = renderUnit(unit!);
      expect(html).toMatch(/<section[^>]*class="[^"]*\bpt-14\b/u);
      expect(html).not.toMatch(/<section[^>]*class="[^"]*\bpt-0\b/u);
    }
  });

  // ── 终态通知行的产物 chips（docs/dynamic-workflow/authoring.md「How the user sees them」）──
  // ⚠ 术语：chip 上的 artifact 是脚本经 `artifact.*` 交付给用户的产出，与同一条通知里的
  // `result`（脚本顶层返回值）不是一回事。
  function workflowNotificationUnit(
    artifacts: readonly { id: string; kind: string; title?: string; version: number }[] | undefined,
    extra: Record<string, unknown> = {},
  ) {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        origin: "backgroundResult",
        originMeta: {
          backgroundSource: "workflow",
          title: "flaky-test-triage",
          workId: "run-abc",
          workflowNotification: {
            kind: "terminal",
            status: "completed",
            summary: "Workflow run completed.",
            durationMs: 1000,
            ...(artifacts === undefined ? {} : { artifacts }),
            ...extra,
          },
        },
      }),
      assistantTextRow(6, { text: "后台总结最终段" }),
    ]);
    return unit!;
  }

  const artifactContext = {
    sessionId: "parent-a",
    onOpenWorkflowArtifact: () => {},
  } as const;

  it("终态通知行的折叠头部尾部挂产物 chips（≤ 3 枚），每枚带 kind 词与标题", () => {
    const html = renderUnit(
      workflowNotificationUnit([
        { id: "book", kind: "file", title: "审计报告", version: 2 },
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1 },
      ]),
      { context: artifactContext, locale: "zh-CN" },
    );

    expect(html).toContain('data-testid="workflow-notification-artifacts"');
    expect(
      (html.match(new RegExp(`data-testid="${TID_CHAT_WORKFLOW_ARTIFACT_CHIP}"`, "gu")) ?? [])
        .length,
    ).toBe(2);
    expect(html).toContain("审计报告");
    expect(html).toContain("每轮耗时");
    // 药丸的尾槽从 v2 起带紧凑版号（追记「产物药丸」推翻了「chip 不放版本」的旧规则）：
    // 「这次跑的是第 2 版」是一件值得在收据上看到的事；长写在 tooltip 里。
    expect(html).toContain('data-testid="workflow-run-artifact-version"');
    expect(html).toContain(">v2<");
    expect(html).toContain('title="第 2 版"');
  });

  it("超过 3 件时只摆 3 枚，其余折进「+N」", () => {
    const html = renderUnit(
      workflowNotificationUnit(
        Array.from({ length: 5 }, (_unused, index) => ({
          id: `a${index}`,
          kind: "file",
          title: `产物 ${index}`,
          version: 1,
        })),
      ),
      { context: artifactContext, locale: "zh-CN" },
    );

    expect(
      (html.match(new RegExp(`data-testid="${TID_CHAT_WORKFLOW_ARTIFACT_CHIP}"`, "gu")) ?? [])
        .length,
    ).toBe(3);
    expect(html).toContain('data-testid="workflow-notification-artifacts-more"');
    expect(html).toContain("+2");
  });

  it("发射侧砍过（artifactsTruncated）时「+N」用省略号，不报一个会骗人的数字", () => {
    const html = renderUnit(
      workflowNotificationUnit([{ id: "a", kind: "file", title: "只剩一件", version: 1 }], {
        artifactsTruncated: true,
      }),
      { context: artifactContext, locale: "zh-CN" },
    );

    expect(html).toContain('data-testid="workflow-notification-artifacts-more"');
    expect(html).toContain("+…");
  });

  it("载荷缺席（批量轮 / 旧 CLI / 旧 transcript）⇒ 无 chips，通知行其余部分逐字不变", () => {
    const withoutArtifacts = renderUnit(workflowNotificationUnit(undefined), {
      context: artifactContext,
      locale: "zh-CN",
    });
    expect(withoutArtifacts).not.toContain('data-testid="workflow-notification-artifacts"');
    expect(withoutArtifacts).toContain("flaky-test-triage");
    expect(withoutArtifacts).toContain("后台总结最终段");

    // 与「一件产物都没有」的空数组同构：两者都不该长出 chips。
    const emptyArtifacts = renderUnit(workflowNotificationUnit([]), {
      context: artifactContext,
      locale: "zh-CN",
    });
    expect(emptyArtifacts).not.toContain('data-testid="workflow-notification-artifacts"');
  });

  it("宿主没注入打开能力时 chips 仍在场，只是不可点——交付了什么是事实，能不能打开是能力", () => {
    const html = renderUnit(
      workflowNotificationUnit([{ id: "book", kind: "file", title: "审计报告", version: 1 }]),
      { locale: "zh-CN" },
    );

    expect(html).toContain(`data-testid="${TID_CHAT_WORKFLOW_ARTIFACT_CHIP}"`);
    expect(html).toMatch(
      new RegExp(
        `<button(?=[^>]*data-testid="${TID_CHAT_WORKFLOW_ARTIFACT_CHIP}")(?=[^>]*disabled)`,
        "u",
      ),
    );
  });

  it("升级（escalation）通知不长 chips——产物只在终态载荷上", () => {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        origin: "backgroundResult",
        originMeta: {
          backgroundSource: "workflow",
          title: "flaky-test-triage",
          workId: "run-abc",
          workflowNotification: {
            kind: "escalation",
            qid: "q1",
            question: "要不要继续？",
            actorName: "planner",
          },
        },
      }),
      assistantTextRow(6, { text: "后台总结最终段" }),
    ]);
    const html = renderUnit(unit!, { context: artifactContext, locale: "zh-CN" });
    expect(html).not.toContain('data-testid="workflow-notification-artifacts"');
  });

  it("workflow 通知无载荷时（批量轮 / 旧 transcript）原样退回裸标题行", () => {
    const finalText = assistantTextRow(6, { text: "后台总结最终段" });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        origin: "backgroundResult",
        originMeta: {
          backgroundSource: "workflow",
          title: "flaky-test-triage",
          workId: "run-abc",
        },
      }),
      finalText,
    ]);
    const html = renderUnit(unit!, { locale: "en-US" });

    expect(html).toContain(`data-testid="chat-background-result-title-${unit!.key}"`);
    expect(html).not.toContain(`data-testid="chat-workflow-notification-row-${unit!.key}"`);
    expect(html).toContain("flaky-test-triage");
  });

  it("在 background result 的 history 兼容路径保留 CUA Group 内 Assistant message 事件", () => {
    const responseId = "background-cua-response";
    const reasoning = {
      ...reasoningRow(),
      assistantResponseId: responseId,
      text: "我需要先检查后台电脑状态。",
    };
    const message = assistantTextRow(4, {
      assistantResponseId: responseId,
      text: "我先检查电脑操作权限与应用列表。",
    });
    const cua = toolCallRow(
      5,
      "mcp__computer-use__list_apps",
      {},
      {
        assistantResponseId: responseId,
      },
    );
    const html = renderUnit(
      baseUnit({
        key: "turn-background:cua-events",
        header: turnHeader({
          origin: "backgroundResult",
          originMeta: { backgroundSource: "bash", title: "后台 Computer Use", workId: "cua" },
        }),
        assistantWorkRows: [reasoning, message, cua],
        assistantHistoryRows: [reasoning, message, cua],
        renderRows: [reasoning, message, cua],
      }),
    );

    // 折叠态不挂载详情正文；计数同时包含 reasoning 与 message，证明兼容路径没有退化为仅 child tools。
    // CuaGroupToolCallBlock 的 forceOpen 测试另行覆盖详情正文渲染。
    expect(html).toContain("3 个事件, 1 条消息");
    expect(html).not.toContain("1 个事件");
  });

  it("旧 background result 缺少结构化标题时保持耗时折叠兼容分支", () => {
    const row = reasoningRow();
    const html = renderUnit(
      baseUnit({
        header: turnHeader({ origin: "backgroundResult" }),
        workStatus: { state: "completed", durationMs: 5_000 },
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        renderRows: [row],
      }),
    );

    expect(html).toContain("已工作 5 秒");
    expect(html).toContain("chat-assistant-history-trigger");
    expect(html).not.toContain("chat-background-result-title");
  });

  it("does not add extra horizontal padding around grouped assistant work rows", () => {
    const exploreRow = toolCallRow(10, "Read", { file_path: "AGENTS.md" });
    const agentRow = toolCallRow(20, "Agent", {
      prompt: "检查 Swift 入口",
      subagent_type: "Explore",
    });
    const childRow = subagentRow(21);
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:padding",
        turnId: "turn-complete",
        isLastTurn: false,
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [exploreRow, agentRow, childRow],
        assistantHistoryRows: [exploreRow, agentRow, childRow],
        renderRows: [exploreRow, agentRow, childRow],
      }),
    );

    expect(html).not.toMatch(/data-row-id="10"[^>]*class="px-4"/);
    expect(html).not.toMatch(/data-row-id="20"[^>]*class="px-4"/);
  });

  it("uses the paired subagent row type while the Agent input preview is incomplete", () => {
    const agentRow = toolCallRow(20, "Agent", undefined, {
      status: "inputStreaming",
      inputText: '{"description":"检查投影","prompt":"继续等待',
    });
    const childRow = subagentRow(21, {
      parentToolCallId: agentRow.toolCallId,
      subagentType: "Review",
      status: "running",
    });
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:streaming-agent-type",
        turnId: "turn-complete",
        isRunning: true,
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [agentRow, childRow],
        assistantHistoryRows: [],
        assistantFollowingRows: [agentRow, childRow],
        renderRows: [agentRow, childRow],
      }),
    );

    expect(html).toContain("Review");
    expect(html).not.toContain("general-purpose");
  });

  it("renders ExitPlanMode at its original row before later tool and assistant output", () => {
    const middleText = assistantTextRow(3, { text: "计划前正文" });
    const plan = toolCallRow(4, "ExitPlanMode", {
      plan: "# PLAN_ROW_ORDER_TITLE",
    });
    const write = toolCallRow(5, "Write", {
      file_path: "/workspace/plan.md",
      content: "done",
    });
    const finalText = assistantTextRow(6, { text: "写入后的最终正文" });
    const [builtUnit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      middleText,
      plan,
      write,
      finalText,
    ]);
    const html = renderUnit({
      ...builtUnit!,
      assistantHistoryDefaultOpen: true,
    });

    const indexes = [
      html.indexOf("计划前正文"),
      html.indexOf("PLAN_ROW_ORDER_TITLE"),
      html.indexOf('data-tool-name="Write"'),
      html.indexOf("写入后的最终正文"),
    ];
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });

  it("renders per-turn file change summary when the header has fileChanges", () => {
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:file-summary",
        turnId: "turn-complete",
        isLastTurn: false,
        header: turnHeader({
          fileChanges: {
            files: 1,
            additions: 2,
            deletions: 1,
            state: "active",
          },
        }),
      }),
    );

    expect(html).toContain("1 个文件已更改");
    expect(html).toContain("+2");
    expect(html).toContain("-1");
  });

  it("passes visualize references from the whole turn to the summary before details load", () => {
    const reference = assistantTextRow(3, {
      text: '::visualize{"path":"/workspace/calendar.html"}',
    });
    const finalText = assistantTextRow(4, { text: "可视化已完成" });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        entityId: "header-1",
        fileChanges: { files: 1, additions: 70, deletions: 0, state: "active" },
      }),
      userInputRow(2),
      reference,
      finalText,
    ]);
    const html = renderUnit(unit!, { context: { fetchFileChanges: async () => ({ items: [] }) } });
    expect(html).not.toContain("1 个文件已更改");
    expect(html).not.toContain("+70");
    expect(html).toContain("可视化已完成");
  });

  it("renders the completed assistant action toolbar after the file change summary", () => {
    const createdAt = new Date();
    createdAt.setHours(7, 15, 0, 0);
    const timeLabel = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(createdAt);
    const row = assistantTextRow(20, { createdAt: createdAt.getTime() });
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:action-order",
        turnId: "turn-complete",
        isLastTurn: true,
        header: turnHeader({
          fileChanges: {
            files: 1,
            additions: 2,
            deletions: 1,
            state: "active",
          },
        }),
        assistantWorkRows: [row],
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        renderRows: [row],
      }),
    );

    const summaryIndex = html.indexOf("1 个文件已更改");
    const actionIndex = html.indexOf('data-testid="v4-copy-20"');
    const timeIndex = html.indexOf(`>${timeLabel}</span>`);

    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(timeIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(actionIndex);
    expect(actionIndex).toBeLessThan(timeIndex);
  });

  it("P07：在定时任务卡片、文件 summary 和操作栏之后渲染 fork 轮尾分割线", () => {
    const cronTool = toolCallRow(
      5,
      "CronCreate",
      { title: "5分钟后提醒去干活" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              automationId: "automation-p07",
              title: "5分钟后提醒去干活",
              cronExpr: "*/5 * * * *",
            },
          }),
        },
      },
    );
    const finalText = assistantTextRow(6, {
      text: "已设置好提醒。",
      actions: { canFork: true },
    });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        fileChanges: {
          files: 1,
          additions: 2,
          deletions: 1,
          state: "active",
        },
      }),
      userInputRow(2),
      cronTool,
      finalText,
      forkNoticeTimelineRow(7),
    ]);
    const html = renderUnit(unit!, {
      compactForRemoteControl: true,
      onFork: vi.fn(),
      onFeedbackChange: vi.fn(),
    });

    const cardIndex = html.indexOf(`data-testid="${TID_CRON_CREATE_CARD}"`);
    const summaryIndex = html.indexOf("1 个文件已更改");
    const dislikeIndex = html.indexOf('data-testid="v4-feedback-dislike-6"');
    const forkActionIndex = html.indexOf('data-testid="v4-fork-6"');
    const boundaryIndex = html.indexOf("从对话中派生");

    expect(cardIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(cardIndex);
    expect(dislikeIndex).toBeGreaterThan(summaryIndex);
    expect(forkActionIndex).toBeGreaterThan(dislikeIndex);
    expect(boundaryIndex).toBeGreaterThan(forkActionIndex);
  });

  it("P07：goalVerify 共用 turnTailBoundary 并在操作栏之后收尾", () => {
    const finalText = assistantTextRow(6, { text: "目标执行结果。" });
    const goalVerify = runningGoalVerifyTimelineRow(7);
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      finalText,
      goalVerify,
    ]);
    const html = renderUnit(unit!);

    expect(html.indexOf('data-testid="v4-copy-6"')).toBeLessThan(html.indexOf("目标校验中"));
  });

  it("renders CronCreate success card after the assistant reply while keeping the tool row ordinary", () => {
    const cronTool = toolCallRow(
      5,
      "CronCreate",
      { title: "每2小时站起来走走提醒" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              title: "每2小时站起来走走提醒",
              cronExpr: "0 9/2 * * *",
            },
          }),
        },
      },
    );
    const finalText = assistantTextRow(6, {
      text: "已设置：每2小时提醒你站起来走走。",
    });
    const [builtUnit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      cronTool,
      finalText,
    ]);
    const html = renderUnit({
      ...builtUnit!,
      assistantHistoryDefaultOpen: true,
    });

    const toolIndex = html.indexOf('data-tool-call-id="tool-5"');
    const replyIndex = html.indexOf("已设置：每2小时提醒你站起来走走。");
    const cardIndex = html.indexOf(`data-testid="${TID_CRON_CREATE_CARD}"`);
    const actionIndex = html.indexOf('data-testid="v4-copy-6"');
    const cardMatches = html.match(new RegExp(`data-testid="${TID_CRON_CREATE_CARD}"`, "g")) ?? [];

    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(cardMatches).toHaveLength(1);
    expect(toolIndex).toBeLessThan(replyIndex);
    expect(replyIndex).toBeLessThan(cardIndex);
    expect(cardIndex).toBeLessThan(actionIndex);
  });

  it("renders the updated automation card after a successful CronUpdate", () => {
    const cronTool = toolCallRow(
      5,
      "CronUpdate",
      { id: "automation-a", title: "工作日晨会提醒" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              automationId: "automation-a",
              title: "工作日晨会提醒",
              cronExpr: "0 9 * * 1-5",
            },
          }),
        },
      },
    );
    const finalText = assistantTextRow(6, { text: "已修改定时任务。" });
    const [builtUnit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      cronTool,
      finalText,
    ]);
    const html = renderUnit({
      ...builtUnit!,
      assistantHistoryDefaultOpen: true,
    });

    const replyIndex = html.indexOf("已修改定时任务。");
    const cardIndex = html.indexOf(`data-testid="${TID_CRON_CREATE_CARD}"`);
    const actionIndex = html.indexOf('data-testid="v4-copy-6"');
    const cardSummary = html.slice(cardIndex, actionIndex);

    expect(html).toContain('data-tool-call-id="tool-5"');
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThan(replyIndex);
    expect(cardIndex).toBeLessThan(actionIndex);
    expect(cardSummary).toContain("工作日晨会提醒");
    expect(cardSummary).toContain("工作日");
    expect(cardSummary).toContain(`data-testid="${TID_CRON_CREATE_OPEN}"`);
  });

  it("只在轮尾展示同轮 Create/Delete 归并后仍存在的 CronCreate 卡片", () => {
    const firstCreate = toolCallRow(
      5,
      "CronCreate",
      { title: "错误的一分钟提醒" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              automationId: "automation-a",
              title: "错误的一分钟提醒",
              cronExpr: "54 14 17 7 *",
            },
          }),
        },
      },
    );
    const deleteFirst = toolCallRow(
      6,
      "CronDelete",
      { id: "automation-a" },
      {
        output: {
          text: JSON.stringify({ deleted: true, id: "automation-a" }),
        },
      },
    );
    const secondCreate = toolCallRow(
      7,
      "CronCreate",
      { title: "一分钟后开嗓提醒" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              automationId: "automation-b",
              title: "一分钟后开嗓提醒",
              cronExpr: "55 14 17 7 *",
            },
          }),
        },
      },
    );
    const finalText = assistantTextRow(8, { text: "已经修正并重新设置。" });
    const [builtUnit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      firstCreate,
      deleteFirst,
      secondCreate,
      finalText,
    ]);
    const html = renderUnit({
      ...builtUnit!,
      assistantHistoryDefaultOpen: true,
    });
    const cardMatches = html.match(new RegExp(`data-testid="${TID_CRON_CREATE_CARD}"`, "g")) ?? [];
    const cardSummary = html.slice(
      html.indexOf(`data-testid="${TID_CRON_CREATE_CARD}"`),
      html.indexOf('data-testid="v4-copy-8"'),
    );

    expect(cardMatches).toHaveLength(1);
    expect(cardSummary).toContain("一分钟后开嗓提醒");
    expect(cardSummary).not.toContain("错误的一分钟提醒");
    expect(html).toContain('data-tool-call-id="tool-5"');
    expect(html).toContain('data-tool-call-id="tool-6"');
    expect(html).toContain('data-tool-call-id="tool-7"');
  });

  it("CronDelete 失败时保留对应的 CronCreate 轮尾卡片", () => {
    const create = toolCallRow(
      5,
      "CronCreate",
      { title: "仍然有效的提醒" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              automationId: "automation-a",
              title: "仍然有效的提醒",
              cronExpr: "0 9 * * *",
            },
          }),
        },
      },
    );
    const failedDelete = toolCallRow(
      6,
      "CronDelete",
      { id: "automation-a" },
      {
        status: "error",
        error: { code: "DELETE_FAILED", message: "删除失败" },
      },
    );
    const finalText = assistantTextRow(7, { text: "删除没有成功。" });
    const [builtUnit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      create,
      failedDelete,
      finalText,
    ]);
    const html = renderUnit({
      ...builtUnit!,
      assistantHistoryDefaultOpen: true,
    });
    const cardMatches = html.match(new RegExp(`data-testid="${TID_CRON_CREATE_CARD}"`, "g")) ?? [];

    expect(cardMatches).toHaveLength(1);
    expect(html.slice(html.indexOf(`data-testid="${TID_CRON_CREATE_CARD}"`))).toContain(
      "仍然有效的提醒",
    );
  });

  it("does not render CronCreate success card until the assistant turn finishes", () => {
    const cronTool = toolCallRow(
      5,
      "CronCreate",
      { title: "每2小时站起来走走提醒" },
      {
        output: {
          text: JSON.stringify({
            automation: {
              title: "每2小时站起来走走提醒",
              cronExpr: "0 9/2 * * *",
            },
          }),
        },
      },
    );
    const streamingText = assistantTextRow(6, {
      state: "streaming",
      text: "已设置：",
    });
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:cron-running-card",
        turnId: "turn-complete",
        header: turnHeader({ state: "running" }),
        isRunning: true,
        workStatus: { state: "running", durationMs: 5_000 },
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [cronTool, streamingText],
        assistantHistoryRows: [cronTool, streamingText],
        assistantTextRows: [streamingText],
        renderRows: [cronTool, streamingText],
      }),
    );

    expect(html).toContain('data-tool-call-id="tool-5"');
    expect(html).toContain("已设置：");
    expect(html).not.toContain(`data-testid="${TID_CRON_CREATE_CARD}"`);
  });

  it("BTA09：renders the browser turn-end screenshot after preview cards and file summary", () => {
    const finalRow = assistantTextRow(20, {
      text: "网站已启动：http://localhost:3000",
    });
    const screenshotRow = toolCallRow(
      21,
      "mcp__node_repl__js",
      { source: "browser_turn_end" },
      {
        display: {
          kind: "node_repl_images",
          source: "browser_turn_end",
          images: [{ base64: "AAAA", mimeType: "image/png" }],
        },
      },
    );
    const units = buildConversationTurnRenderUnits([
      turnHeader({
        fileChanges: {
          files: 1,
          additions: 38,
          deletions: 5,
          state: "active",
        },
      }),
      userInputRow(2),
      finalRow,
      screenshotRow,
    ]);
    const html = renderUnit(units[0]!);

    // lastIndexOf 取 Website 卡片标题，避开正文中更早出现的同一 URL。
    const previewIndex = html.lastIndexOf("localhost:3000");
    const summaryIndex = html.indexOf("1 个文件已更改");
    const screenshotIndex = html.indexOf("data:image/png;base64,AAAA");
    const actionIndex = html.indexOf('data-testid="v4-copy-20"');

    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(previewIndex);
    expect(screenshotIndex).toBeGreaterThan(summaryIndex);
    expect(actionIndex).toBeGreaterThan(screenshotIndex);
  });

  it("PV4-08：fork action 只读取 row.actions.canFork，不按 completed/数组位置猜测", () => {
    const onFork = vi.fn();
    const withoutAuthority = assistantTextRow(20);
    const withAuthority = assistantTextRow(21, { actions: { canFork: true } });
    const unit = (row: AssistantTextRow) =>
      baseUnit({
        key: `turn-complete:fork-${row.rowId}`,
        turnId: "turn-complete",
        isLastTurn: true,
        header: turnHeader(),
        assistantWorkRows: [row],
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        renderRows: [row],
      });

    expect(renderUnit(unit(withoutAuthority), { onFork })).not.toContain("v4-fork-");
    expect(renderUnit(unit(withAuthority), { onFork })).toContain("v4-fork-21");
  });

  it("BG33：普通 assistant retry capability 保留但 UI 入口统一隐藏", () => {
    const onFork = vi.fn();
    const onRetry = vi.fn();
    const backgroundRow = assistantTextRow(30, { actions: { canFork: true } });
    const backgroundHtml = renderUnit(
      baseUnit({
        key: "turn-background:retry-boundary",
        turnId: "turn-complete",
        isLastTurn: true,
        header: turnHeader({
          origin: "backgroundResult",
          originMeta: {
            backgroundSource: "subagent",
            title: "Review retry projection",
            workId: "agent-retry-review",
          },
        }),
        assistantWorkRows: [backgroundRow],
        assistantTextRows: [backgroundRow],
        latestAssistantTextRow: backgroundRow,
        renderRows: [backgroundRow],
      }),
      { onFork, onRetry },
    );
    expect(backgroundHtml).toContain("v4-fork-30");
    expect(backgroundHtml).not.toContain("v4-retry-30");

    const realUserRow = assistantTextRow(31, {
      actions: { canFork: true, canRetry: true },
    });
    const realUserHtml = renderUnit(
      baseUnit({
        key: "turn-real-user:retry-boundary",
        turnId: "turn-complete",
        isLastTurn: true,
        header: turnHeader(),
        assistantWorkRows: [realUserRow],
        assistantTextRows: [realUserRow],
        latestAssistantTextRow: realUserRow,
        renderRows: [realUserRow],
      }),
      { onFork, onRetry },
    );
    expect(realUserHtml).not.toContain("v4-retry-31");
  });

  it("按复制、赞、踩、分叉顺序渲染反馈工具栏，手机远控常显", () => {
    const createdAt = new Date();
    createdAt.setHours(7, 15, 0, 0);
    const timeLabel = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(createdAt);
    const row = assistantTextRow(22, {
      actions: { canFork: true },
      createdAt: createdAt.getTime(),
    });
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:feedback",
        turnId: "turn-complete",
        isLastTurn: true,
        header: turnHeader(),
        assistantWorkRows: [row],
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        renderRows: [row],
      }),
      {
        compactForRemoteControl: true,
        onFork: vi.fn(),
        onFeedbackChange: vi.fn(),
      },
    );

    const copyIndex = html.indexOf('data-testid="v4-copy-22"');
    const likeIndex = html.indexOf('data-testid="v4-feedback-like-22"');
    const dislikeIndex = html.indexOf('data-testid="v4-feedback-dislike-22"');
    const forkIndex = html.indexOf('data-testid="v4-fork-22"');
    const timeIndex = html.indexOf(`>${timeLabel}</span>`);
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(copyIndex).toBeLessThan(likeIndex);
    expect(likeIndex).toBeLessThan(dislikeIndex);
    expect(dislikeIndex).toBeLessThan(forkIndex);
    expect(forkIndex).toBeLessThan(timeIndex);
    expect(html).toContain("select-none text-ui-sm text-foreground-subtlest");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("opacity-100");
    expect(html).not.toContain("group-hover/assistant-turn:opacity-100");
  });

  it("带 CLI action 的 assistant 后面仍有 work row 时也渲染 action", () => {
    const onFork = vi.fn();
    const actionRow = assistantTextRow(4, { actions: { canFork: true } });
    const units = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      actionRow,
      reasoningRow(),
    ]);

    expect(renderUnit(units[0]!, { onFork })).toContain("v4-fork-4");
  });

  it("reveals the completed assistant action toolbar from the assistant turn hover area", () => {
    const row = assistantTextRow(20);
    const html = renderUnit(
      baseUnit({
        key: "turn-complete:action-hover",
        turnId: "turn-complete",
        isLastTurn: true,
        header: turnHeader({
          fileChanges: {
            files: 1,
            additions: 2,
            deletions: 1,
            state: "active",
          },
        }),
        assistantWorkRows: [row],
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        renderRows: [row],
      }),
    );

    expect(html).toContain("group/assistant-turn");
    expect(html).toContain("group-hover/assistant-turn:opacity-100");
    expect(html).not.toMatch(
      /class="[^"]*group\/assistant-row[^"]*"[^>]*><div class="[^"]*group-hover\/assistant-row:opacity-100/,
    );
  });

  it("preserves text tool text order inside the single assistant history group", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      reasoningRow(),
      assistantTextRow(4, { text: "Let me看看这个项目里有什么。" }),
      toolCallRow(5, "Bash", {
        command: "ls -la /workspace",
        description: "List project files",
      }),
      assistantTextRow(6, { text: "最终回答" }),
    ]);
    const html = renderUnit({
      ...units[0]!,
      assistantHistoryDefaultOpen: true,
    });

    const historyTriggerMatches = html.match(/data-testid="chat-assistant-history-trigger/g) ?? [];
    const earlyTextIndex = html.indexOf("Let me看看这个项目里有什么。");
    const toolIndex = html.indexOf("tool-5");
    const finalTextIndex = html.indexOf("最终回答");

    expect(historyTriggerMatches).toHaveLength(1);
    expect(earlyTextIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(finalTextIndex).toBeGreaterThanOrEqual(0);
    expect(earlyTextIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(finalTextIndex);
    expect(html).not.toContain('data-testid="v4-copy-4"');
    expect(html).toContain('data-testid="v4-copy-6"');
  });

  it("P08：折叠间距进入 history 动画高度，普通兄弟仍保持 20px 节奏", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      reasoningRow(),
      assistantTextRow(4, { text: "最终回答" }),
    ]);
    const html = renderUnit({
      ...units[0]!,
      assistantHistoryDefaultOpen: true,
    });
    const segmentClass = html.match(/class="([^"]*history-message[^"]*\[data-slot=[^"]*)"/)?.[1];

    expect(segmentClass).toBeDefined();
    expect(segmentClass).toContain("flex flex-col");
    expect(segmentClass).not.toContain("gap-5");
    expect(segmentClass).toContain("*+*:not([data-slot=&#x27;collapsible-content&#x27;])");
    expect(segmentClass).toContain(":mt-5");
    expect(html).toMatch(
      /data-testid="chat-assistant-history-content-[^"]+"[^>]*>.*?<div class="pt-5">/s,
    );
  });

  it("P06：每条 guided user 开独立工作段，且只展开目标段不影响其它段", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader({
        workSegments: [
          {
            segmentId: "initial",
            startedAt: 1_700_000_000_000,
            endedAt: 1_700_000_000_005,
            activeMs: 5_000,
          },
          {
            segmentId: "guide-1",
            triggerEntityId: "guide-1",
            startedAt: 1_700_000_000_005,
            endedAt: 1_700_000_000_007,
            activeMs: 2_000,
          },
          {
            segmentId: "guide-2",
            triggerEntityId: "guide-2",
            startedAt: 1_700_000_000_007,
            endedAt: 1_700_000_000_008,
            activeMs: 1_000,
          },
        ],
      }),
      userInputRow(2, { text: "这是个啥项目" }),
      reasoningRow(),
      toolCallRow(4, "Read", { file_path: "AGENTS.md" }),
      userInputRow(5, { text: "111", guided: true, entityId: "guide-1" }),
      assistantTextRow(6, { text: "这是项目介绍" }),
      userInputRow(7, { text: "11", guided: true, entityId: "guide-2" }),
      assistantTextRow(8, { text: "还需要我做什么？" }),
    ]);

    expect(units[0]?.workStatus).toBeDefined();
    const collapsedHtml = renderUnit(units[0]!);
    const collapsedIndexes = [
      collapsedHtml.indexOf('data-row-id="2"'),
      collapsedHtml.indexOf("chat-assistant-history-trigger"),
      collapsedHtml.indexOf('data-row-id="5"'),
      collapsedHtml.indexOf('data-row-id="6"'),
      collapsedHtml.indexOf('data-row-id="7"'),
      collapsedHtml.indexOf('data-row-id="8"'),
    ];
    expect(
      collapsedIndexes.every((index) => index >= 0),
      JSON.stringify(collapsedIndexes),
    ).toBe(true);
    expect(collapsedIndexes).toEqual([...collapsedIndexes].sort((left, right) => left - right));
    expect(collapsedHtml).not.toContain('data-row-id="4"');
    expect(collapsedHtml.match(/chat-assistant-history-trigger/g)).toHaveLength(3);
    expect(collapsedHtml).toContain("已工作 5 秒");
    expect(collapsedHtml).toContain("已工作 2 秒");
    expect(collapsedHtml).toContain("已工作 1 秒");

    const expandedHtml = renderUnit({
      ...units[0]!,
      workSegments: units[0]!.workSegments!.map((segment, index) => ({
        ...segment,
        assistantHistoryDefaultOpen: index === 0,
      })),
    });
    const expandedIndexes = [
      expandedHtml.indexOf('data-row-id="2"'),
      expandedHtml.indexOf('data-row-id="4"'),
      expandedHtml.indexOf('data-row-id="5"'),
      expandedHtml.indexOf('data-row-id="6"'),
      expandedHtml.indexOf('data-row-id="7"'),
      expandedHtml.indexOf('data-row-id="8"'),
    ];
    expect(expandedIndexes.every((index) => index >= 0)).toBe(true);
    expect(expandedIndexes).toEqual([...expandedIndexes].sort((left, right) => left - right));
    expect(expandedHtml.match(/chat-assistant-history-trigger/g)).toHaveLength(3);
    expect(expandedHtml).toContain(
      'data-testid="chat-assistant-history-trigger-turn-complete" data-history-open="true"',
    );
    expect(expandedHtml).toContain(
      'data-testid="chat-assistant-history-trigger-turn-complete:guide:guide-1" data-history-open="false"',
    );
    expect(expandedHtml).not.toContain('data-testid="v4-copy-6"');
    expect(expandedHtml).toContain('data-testid="v4-copy-8"');
  });
});

describe("ConversationTurnGroup ChatLoading lifecycle", () => {
  it("Highspeed 运行态作用域用语义紫色覆盖所有呼吸渐变", () => {
    const styles = readFileSync("packages/ui/src/styles.css", "utf8");
    const modifier =
      styles.match(
        /\.highspeed-animated-gradient-text\s+\.animated-gradient-text\s*\{([^}]*)\}/,
      )?.[1] ?? "";

    expect(modifier).toContain("--animated-gradient-text-strong: var(--color-icon-purple);");
    expect(modifier).toContain("--animated-gradient-text-soft:");
    expect(modifier).toContain("var(--color-icon-purple)");
  });

  it("Retry 只降低 shimmer 峰值并保留全局低透明度扫光低谷", () => {
    const styles = readFileSync("packages/ui/src/styles.css", "utf8");
    const modifier = styles.match(/\.animated-gradient-text-subtle\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(modifier).toContain("--animated-gradient-text-strong: var(--color-foreground-subtle);");
    expect(modifier).not.toContain("--animated-gradient-text-soft");
  });

  it("第三次 retry 才替换当前 turn 底部的通用 loading，并保留 3/10 计数口径", () => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
      {
        apiRetry: {
          attempt: 3,
          maxAttempts: 11,
          nextRetryAt: 1_700_000_001_000,
          reasonCode: "fault.provider.rateLimited",
        },
      },
    );

    expect(html).toContain("重新连接中... 3/10");
    expect(html).toContain(
      'class="inline-flex h-7 items-center whitespace-nowrap px-1 text-ui-base"',
    );
    expect(html).toContain(
      'class="animated-gradient-text animated-gradient-text-subtle font-medium">重新连接中... 3/10</span>',
    );
    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it.each([1, 2])("attempt=%d 时隐藏 retry 文案并继续显示通用 loading", (attempt) => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
      {
        apiRetry: {
          attempt,
          maxAttempts: 11,
          nextRetryAt: 1_700_000_001_000,
          reasonCode: "fault.provider.rateLimited",
        },
      },
    );

    expect(html).not.toContain("重新连接中...");
    expect(html).toContain('data-testid="chat-loading"');
    expect(html).toContain('data-zcode-chat-loading-slot="true"');
  });

  it("attempt<=2 时仍遵守阻塞交互的 loading gate", () => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
      {
        chatLoadingBlockedByInteraction: true,
        apiRetry: {
          attempt: 2,
          maxAttempts: 11,
          nextRetryAt: 1_700_000_001_000,
          reasonCode: "fault.provider.rateLimited",
        },
      },
    );

    expect(html).not.toContain("重新连接中...");
    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it("retry 清除后恢复当前 running turn 的通用 loading", () => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
      { apiRetry: null },
    );

    expect(html).not.toContain("重新连接中...");
    expect(html).toContain('data-testid="chat-loading"');
  });

  it.each([
    ["assistant text", assistantTextRow(10, { state: "streaming" })],
    ["reasoning", { ...reasoningRow(), state: "streaming" }],
    ["tool", toolCallRow(11, "Bash", { command: "pnpm test" }, { status: "running" })],
    ["subagent", subagentRow(12, { status: "running" })],
  ] as const)("shows loading immediately while a running turn contains %s", (_label, row) => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        renderRows: [row],
      }),
    );

    expect(html).toContain('data-testid="chat-loading"');
  });

  it.each([
    ["compact", runningTimelineRow(20)],
    ["goal verifier", runningGoalVerifyTimelineRow(21)],
  ] as const)("hides loading for a running %s timeline-only turn", (_label, row) => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        timelineOnly: true,
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        renderRows: [row],
      }),
    );

    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it("keeps loading visible for a running structured background-result turn", () => {
    const row = assistantTextRow(30, { state: "streaming" });
    const html = renderUnit(
      baseUnit({
        header: turnHeader({
          origin: "backgroundResult",
          originMeta: {
            backgroundSource: "subagent",
            title: "Review projection",
            workId: "agent-work",
          },
          state: "running",
        }),
        isRunning: true,
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        assistantTextRows: [row],
        renderRows: [row],
      }),
    );

    expect(html).toContain('data-testid="chat-loading"');
  });

  it("hides loading after the latest turn reaches a terminal state", () => {
    const row = assistantTextRow(40);
    const html = renderUnit(
      baseUnit({
        assistantWorkRows: [row],
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        renderRows: [row],
      }),
    );

    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it("hides loading while the session projection is waiting for user interaction", () => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
      { chatLoadingBlockedByInteraction: true },
    );

    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it("hides loading while compact or goal verifier is active", () => {
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
      { chatLoadingBlockedByActiveWork: true },
    );

    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it("hides loading when a pendingApproval row arrives before interaction state", () => {
    const row = toolCallRow(
      41,
      "Bash",
      { command: "touch output.txt" },
      { status: "pendingApproval" },
    );
    const html = renderUnit(
      baseUnit({
        isRunning: true,
        assistantHistoryDefaultOpen: true,
        assistantWorkRows: [row],
        assistantHistoryRows: [row],
        renderRows: [row],
      }),
    );

    expect(html).not.toContain('data-testid="chat-loading"');
  });

  it("does not show loading for a stale running historical turn", () => {
    const html = renderUnit(
      baseUnit({
        isLastTurn: false,
        isRunning: true,
        assistantHistoryDefaultOpen: true,
      }),
    );

    expect(html).not.toContain('data-testid="chat-loading"');
  });
});

const LAUNCH_META: WorkflowLaunchMeta = {
  runId: "run-42",
  toolCallId: "launch-abc",
  name: "deep-research",
  scope: "global",
  path: "/home/u/.zcode/workflows/deep-research.dwf.ts",
  description: "跨网深挖一个话题并写简报。",
  args: { topic: "adaptive concurrency" },
};

// agent 铸造的规范英文句（进 userInput.text，旧客户端 / TUI 的降级呈现）；启动卡不显示它。
const LAUNCH_CANONICAL =
  'Started the saved workflow "deep-research" (global) from the workflows hub as run run-42.';

describe("ConversationTurnGroup — 直接启动轮（workflowLaunch）", () => {
  const LAUNCH_GRAPH = {
    steps: [{ id: "ask#1", kind: "ask", label: "a", line: 1, column: 21, lane: "actor#1" }],
    lanes: [{ id: "actor#1", name: "researcher", line: 1, column: 11 }],
    participants: [
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [],
  };
  const LAUNCH_RUN: WorkflowRunState = {
    runId: "run-42",
    toolCallId: "launch-abc",
    status: "running",
    usage: { spentTokens: 12, nodesUsed: 1 },
    actors: [{ siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "running" }],
    nodes: [
      { siteId: "ask#1", ordinal: 1, phase: "executing", actorSiteId: "actor#1", actorOrdinal: 1 },
    ] as WorkflowRunState["nodes"],
    lastEventSequence: 3,
  };
  const LAUNCH_JOIN: Partial<ConversationRowRenderContext> = {
    sessionId: "session-main",
    workflowRunByRunId: new Map([
      [
        "run-42",
        {
          runId: "run-42",
          toolCallId: "launch-abc",
          status: "running",
          nodesSettled: 0,
          nodesTotal: 1,
          run: LAUNCH_RUN,
        },
      ],
    ]),
    workflowGraphByToolCallId: new Map([["launch-abc", LAUNCH_GRAPH]]),
  };
  function launchRows(meta: WorkflowLaunchMeta | undefined, turnId = "turn-complete") {
    return [
      turnHeader({
        turnId,
        origin: "workflowLaunch",
        executionKind: "controlOnly",
        ...(meta === undefined ? {} : { workflowLaunch: meta }),
      }),
      userInputRow(2, {
        turnId,
        origin: "workflowLaunch",
        text: LAUNCH_CANONICAL,
        ...(meta === undefined ? {} : { workflowLaunch: meta }),
      }),
    ];
  }

  it("启动轮就是一张 run 卡：与工具路径同一张 WorkflowRunDigest（时间线、子代理药丸），没有用户气泡", () => {
    const [unit] = buildConversationTurnRenderUnits(launchRows(LAUNCH_META));
    expect(unit!.workflowLaunch).toEqual(LAUNCH_META);
    expect(unit!.visibleUserInputs).toEqual([]);
    const html = renderUnit(unit!, { context: LAUNCH_JOIN });

    expect(html).toContain(
      `data-testid="${testId(TID_CHAT_WORKFLOW_RUN_DIGEST, `${unit!.key}-launch-abc`)}"`,
    );
    expect(html).toContain('data-workflow-run-id="run-42"');
    expect(html).toContain('data-workflow-run-status="running"');
    expect(html).toContain("deep-research");
    expect(html).toContain('data-testid="workflow-timeline-station"');
    expect(html).toContain('data-testid="workflow-agent-pill"');
    // 卡就是这一轮的全部呈现：不落那句规范英文气泡，也没有实参表（来龙去脉在详情侧板）。
    expect(html).not.toContain(LAUNCH_CANONICAL);
    expect(html).not.toContain("adaptive concurrency");
    expect(html.match(/data-workflow-run-digest="true"/g)).toHaveLength(1);
  });

  it("run 不在活投影里（淘汰 / 冷恢复）：中性单行卡「Workflow ended」，无灯无轨道，仍不落气泡", () => {
    const [unit] = buildConversationTurnRenderUnits(launchRows(LAUNCH_META));
    const html = renderUnit(unit!, { context: { sessionId: "session-main" }, locale: "en-US" });

    expect(html).toContain('data-workflow-run-digest="true"');
    expect(html).toContain('data-workflow-run-status="absent"');
    expect(html).toContain("Workflow ended");
    expect(html).toContain("deep-research");
    expect(html).not.toContain('data-testid="workflow-timeline-station"');
    expect(html).not.toContain('data-testid="workflow-digest-cancel"');
    expect(html).not.toContain(LAUNCH_CANONICAL);
  });

  it("元数据缺席时落穿到普通渲染（降级为规范句气泡）", () => {
    const [unit] = buildConversationTurnRenderUnits(launchRows(undefined));
    expect(unit!.workflowLaunch).toBeUndefined();
    const html = renderUnit(unit!);

    expect(html).not.toContain('data-workflow-run-digest="true"');
    // 规范句进气泡（引号在 HTML 里转义，断言无引号片段）。
    expect(html).toContain("from the workflows hub as run run-42.");
  });

  it("后续普通轮不受影响", () => {
    const units = buildConversationTurnRenderUnits([
      ...launchRows(LAUNCH_META, "turn-launch"),
      turnHeader({ rowId: 3, createdAtSeq: 3, turnId: "turn-next" }),
      userInputRow(4, { turnId: "turn-next", text: "看看下一步" }),
    ]);

    const launchUnit = units.find((unit) => unit.turnId === "turn-launch");
    const nextUnit = units.find((unit) => unit.turnId === "turn-next");
    expect(launchUnit).toBeDefined();
    expect(nextUnit).toBeDefined();

    expect(renderUnit(launchUnit!, { context: LAUNCH_JOIN })).toContain(
      'data-workflow-run-digest="true"',
    );

    const nextHtml = renderUnit(nextUnit!, { context: LAUNCH_JOIN });
    expect(nextHtml).not.toContain('data-workflow-run-digest="true"');
    expect(nextHtml).toContain("看看下一步");
  });

  it("没有用户气泡的轮去掉轮顶 pt-14：卡 / 行只贴上一轮 pb-5 的常规流内间距", () => {
    // Bug 根因：pt-14 是给用户气泡留的呼吸；启动轮与「配置」的设置轮都把用户行裁掉了
    // （conversationTurnRenderUnits），轮内第一个节点直接是卡或那一行，56px 于是叠在
    // 上一轮 pb-5 之上成了约 76px 空白。通知轮早已按同一条规则去过留白。
    const [launchUnit] = buildConversationTurnRenderUnits(launchRows(LAUNCH_META));
    const launchHtml = renderUnit(launchUnit!, { context: LAUNCH_JOIN });
    expect(launchHtml).toMatch(/<section[^>]*class="[^"]*\bpt-0\b/u);
    expect(launchHtml).not.toMatch(/<section[^>]*class="[^"]*\bpt-14\b/u);

    // 设置轮：同一份元数据多一个 amend 块，呈现是「已调整设置」那一行加新 run 的卡。
    const settingsMeta: WorkflowLaunchMeta = {
      ...LAUNCH_META,
      amend: { predecessorRunId: "run-41", maxConcurrency: { from: 2, to: 5 } },
    };
    const [settingsUnit] = buildConversationTurnRenderUnits(launchRows(settingsMeta));
    const settingsHtml = renderUnit(settingsUnit!, { context: LAUNCH_JOIN });
    expect(settingsHtml).toContain('data-testid="workflow-settings-change-row"');
    expect(settingsHtml).toMatch(/<section[^>]*class="[^"]*\bpt-0\b/u);
    expect(settingsHtml).not.toMatch(/<section[^>]*class="[^"]*\bpt-14\b/u);

    // 元数据缺席即退回普通渲染（那句规范英文成气泡）——有气泡的轮照旧留呼吸。
    const [plainUnit] = buildConversationTurnRenderUnits(launchRows(undefined));
    const plainHtml = renderUnit(plainUnit!, { context: LAUNCH_JOIN });
    expect(plainHtml).toMatch(/<section[^>]*class="[^"]*\bpt-14\b/u);
    expect(plainHtml).not.toMatch(/<section[^>]*class="[^"]*\bpt-0\b/u);
  });
});

// ── 轮尾摘要（docs/dynamic-workflow/presentation.md「The run card」）──
const DIGEST_GRAPH = {
  steps: [{ id: "ask#1", kind: "ask", label: "a", line: 1, column: 21, lane: "actor#1" }],
  lanes: [{ id: "actor#1", name: "planner", line: 1, column: 11 }],
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
};

function workflowToolRow(rowId: number, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return toolCallRow(
    rowId,
    "CreateWorkflow",
    { name: "implement-verify", script: "const p = agent('planner');" },
    {
      output: {
        text: "ok",
        display: {
          kind: "create_workflow",
          ok: true,
          errorCount: 0,
          diagnostics: [],
          causalityGraph: DIGEST_GRAPH,
        },
      } as ToolCallRow["output"],
      ...overrides,
    },
  );
}

const DIGEST_RUN: WorkflowRunState = {
  runId: "run-7",
  toolCallId: "tool-5",
  status: "running",
  usage: { spentTokens: 12, nodesUsed: 1 },
  actors: [{ siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "running" }],
  nodes: [
    { siteId: "ask#1", ordinal: 1, phase: "executing", actorSiteId: "actor#1", actorOrdinal: 1 },
  ] as WorkflowRunState["nodes"],
  lastEventSequence: 3,
};

const DIGEST_JOIN: Partial<ConversationRowRenderContext> = {
  sessionId: "session-main",
  // 图按发起 toolCallId 到图表取（docs/dynamic-workflow/presentation.md「The run card」）。
  workflowGraphByToolCallId: new Map([["tool-5", DIGEST_GRAPH]]),
  workflowRunByToolCallId: new Map([
    [
      "tool-5",
      {
        runId: "run-7",
        toolCallId: "tool-5",
        status: "running",
        nodesSettled: 0,
        nodesTotal: 1,
        run: DIGEST_RUN,
      },
    ],
  ]),
};

describe("ConversationTurnGroup — 轮尾摘要（workflow run digest）", () => {
  it("轮结束后，联接到 run 的 CreateWorkflow 行在最后一段正文之后、操作栏之前多出一张摘要；工具卡本身仍在折叠里", () => {
    const tool = workflowToolRow(5);
    const finalText = assistantTextRow(6, { text: "已启动，跑完我会汇报。" });
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      tool,
      finalText,
    ]);
    const html = renderUnit(
      { ...unit!, assistantHistoryDefaultOpen: true },
      { context: DIGEST_JOIN },
    );

    const toolIndex = html.indexOf('data-tool-call-id="tool-5"');
    const replyIndex = html.indexOf("已启动，跑完我会汇报。");
    const digestIndex = html.indexOf('data-workflow-run-digest="true"');
    const actionIndex = html.indexOf('data-testid="v4-copy-6"');
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(digestIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeLessThan(replyIndex);
    expect(replyIndex).toBeLessThan(digestIndex);
    expect(digestIndex).toBeLessThan(actionIndex);
    expect(html.match(/data-workflow-run-digest="true"/g)).toHaveLength(1);
    // 收起态：阶段线在、药丸不在（折叠里的卡照旧画药丸，只看摘要那一段）；名字与运行状态在表头。
    const digestHtml = html.slice(digestIndex, actionIndex);
    expect(digestHtml).toContain('data-testid="workflow-timeline-station"');
    expect(digestHtml).toContain("implement-verify");
    expect(digestHtml).toContain('data-workflow-run-status="running"');
    expect(digestHtml).toContain('data-testid="workflow-agent-pill"');
    // sessionId + onOpenWorkflowRun 都在场才有 ⤢；这里没注入回调，就没有。
    expect(digestHtml).not.toContain('data-testid="workflow-card-open-details"');
  });

  it("主轮仍在运行时，有 run 立即显示摘要；没联接到 run 的行没有", () => {
    const tool = workflowToolRow(5);
    const streaming = assistantTextRow(6, { state: "streaming", text: "正在…" });
    const running = baseUnit({
      key: "turn-complete:digest-running",
      turnId: "turn-complete",
      header: turnHeader({ state: "running" }),
      isRunning: true,
      workStatus: { state: "running", durationMs: 5_000 },
      assistantHistoryDefaultOpen: true,
      assistantWorkRows: [tool, streaming],
      assistantHistoryRows: [tool, streaming],
      assistantTextRows: [streaming],
      renderRows: [tool, streaming],
    });
    const runningHtml = renderUnit(running, { context: DIGEST_JOIN });
    expect(runningHtml).toContain('data-tool-call-id="tool-5"');
    expect(runningHtml.match(/data-workflow-run-digest="true"/g)).toHaveLength(1);
    expect(runningHtml).toContain('data-testid="workflow-tool-summary"');
    expect(runningHtml).not.toContain('data-testid="workflow-card"');
    expect(runningHtml).toContain('data-testid="workflow-timeline-station"');

    const [finished] = buildConversationTurnRenderUnits([
      turnHeader(),
      userInputRow(2),
      tool,
      assistantTextRow(6),
    ]);
    expect(renderUnit(finished!)).not.toContain('data-workflow-run-digest="true"');
  });
});

// 完成卡（docs/dynamic-workflow/transcript-and-notifications.md）：主代理消化 completed 通知的那一轮，轮尾落卡。
// 这里没有会话上下文（静态渲染），卡画的是冷态那一层：通知载荷的产物（纸页字形）+ 联接到的数字。
const COMPLETION_RUN: WorkflowRunState = {
  ...DIGEST_RUN,
  runId: "run-done",
  status: "completed",
  usage: { spentTokens: 386_412, nodesUsed: 16 },
  phases: [{ name: "plan", rounds: 1 }],
  artifacts: [
    { id: "brief", kind: "markdown", title: "research-brief.md", version: 1, bytes: 12_288 },
  ],
};

function completionUnit(status: "completed" | "failed" | "cancelled", withArtifacts = true) {
  const [unit] = buildConversationTurnRenderUnits([
    turnHeader({
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "workflow",
        title: "deep-research",
        workId: "run-done",
        workflowNotification: {
          kind: "terminal",
          status,
          summary: "Workflow run completed.",
          durationMs: 708_000,
          ...(withArtifacts
            ? {
                artifacts: [
                  { id: "brief", kind: "markdown", title: "research-brief.md", version: 1 },
                  { id: "sources", kind: "file", title: "sources.csv", version: 2 },
                ],
              }
            : {}),
        },
      },
    }),
    assistantTextRow(6, { text: "研究跑完了，摘要如下。" }),
  ]);
  return unit!;
}

const COMPLETION_JOIN: Partial<ConversationRowRenderContext> = {
  sessionId: "session-main",
  onOpenWorkflowRun: () => {},
  onOpenWorkflowArtifact: () => {},
  workflowRunByRunId: new Map([
    [
      "run-done",
      {
        runId: "run-done",
        toolCallId: "tool-launch",
        status: "completed",
        nodesSettled: 16,
        nodesTotal: 16,
        run: COMPLETION_RUN,
      },
    ],
  ]),
};

describe("ConversationTurnGroup — 完成卡（workflow completion card）", () => {
  it("completed 通知轮：卡在最后一段正文之后、操作栏之前，且只一张；通知行仍在最前", () => {
    const unit = completionUnit("completed");
    const html = renderUnit(unit, { context: COMPLETION_JOIN, locale: "en-US" });

    const rowIndex = html.indexOf(`data-testid="chat-workflow-notification-row-${unit.key}"`);
    const replyIndex = html.indexOf("研究跑完了，摘要如下。");
    const cardIndex = html.indexOf('data-workflow-completion-card="true"');
    const actionIndex = html.indexOf('data-testid="v4-copy-6"');
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    expect(rowIndex).toBeLessThan(replyIndex);
    expect(replyIndex).toBeLessThan(cardIndex);
    expect(cardIndex).toBeLessThan(actionIndex);
    expect(html.match(/data-workflow-completion-card="true"/g)).toHaveLength(1);

    const card = html.slice(cardIndex, actionIndex);
    // 表头：种类词 + 名字 + 状态词 + ⤢（sessionId + 回调 + 联接到的 toolCallId 都在）。
    expect(card).toContain("Workflow completed");
    expect(card).toContain("deep-research");
    expect(card).toContain('data-testid="workflow-completion-status"');
    expect(card).toContain('data-testid="workflow-card-open-details"');
    // 产物索引：没有交付物 ⇒ 两行、没有框（索引不画预览，也就没有纸页字形）；v2 尾槽在；可点。
    expect(card.match(/data-testid="workflow-completion-line"/g)).toHaveLength(2);
    expect(card).toContain('data-testid="workflow-completion-index"');
    expect(card).not.toContain('data-testid="workflow-artifact-sheet"');
    expect(card).toContain(">v2<");
    expect(card).toContain('data-artifact-open="true"');
    // 四格：时间来自通知，其余三格来自联接到的投影。
    expect(card).toContain('data-value="11m 48s"');
    expect(card).toContain('data-value="386.4k"');
    // 夹具里一个子代理、一个进过的阶段；卡上不说「步」（2026-09-09）。
    expect(card).toMatch(/workflow-completion-figure-subagents" data-value="1"/u);
    expect(card).toMatch(/workflow-completion-figure-phases" data-value="1"/u);
    expect(card).not.toContain("figure-steps");
  });

  it("联接不到 run（冷恢复）：时间与产物照画，其余三格 `—`，无 ⤢；零产物没有索引", () => {
    const html = renderUnit(completionUnit("completed"), { locale: "en-US" });
    const cardIndex = html.indexOf('data-workflow-completion-card="true"');
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    const card = html.slice(cardIndex);
    expect(card).toContain('data-value="11m 48s"');
    expect(card).not.toContain('data-value="386.4k"');
    expect(card).toContain("—");
    expect(card).not.toContain('data-testid="workflow-card-open-details"');
    expect(card.match(/data-testid="workflow-completion-line"/g)).toHaveLength(2);

    const bare = renderUnit(completionUnit("completed", false), { locale: "en-US" });
    expect(bare).toContain('data-workflow-completion-card="true"');
    expect(bare).not.toContain('data-testid="workflow-completion-index"');
  });

  // 交付物（docs/dynamic-workflow/transcript-and-notifications.md「Artifact tiles」）：载荷上的 primary + description
  // 让冷态卡（没有会话上下文）也画得出交付物行——冷 transcript 上只有这份载荷可读。
  it("载荷带 primary：冷态卡画交付物行（说明来自载荷）+ 索引行；没有「primary」字样", () => {
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader({
        origin: "backgroundResult",
        originMeta: {
          backgroundSource: "workflow",
          title: "deep-research",
          workId: "run-done",
          workflowNotification: {
            kind: "terminal",
            status: "completed",
            summary: "Workflow run completed.",
            durationMs: 708_000,
            artifacts: [
              {
                id: "report",
                kind: "markdown",
                title: "Research report",
                version: 2,
                primary: true,
                description: "Twelve sources compared; three claims confirmed.",
              },
              { id: "sources", kind: "file", title: "sources.csv", version: 1 },
            ],
          },
        },
      }),
      assistantTextRow(6, { text: "研究跑完了，摘要如下。" }),
    ]);
    const html = renderUnit(unit!, { locale: "en-US" });
    const card = html.slice(html.indexOf('data-workflow-completion-card="true"'));
    expect(card).toContain('data-testid="workflow-completion-row"');
    expect(card).toContain("Twelve sources compared; three claims confirmed.");
    expect(card.match(/data-testid="workflow-completion-line"/g)).toHaveLength(1);
    expect(card).toContain('data-variant="line"');
    expect(card).toContain('data-testid="workflow-completion-index"');
    expect(card).not.toMatch(/>\s*primary\s*</iu);
  });

  it.each(["failed", "cancelled"] as const)("%s 的通知轮不画卡", (status) => {
    const html = renderUnit(completionUnit(status), { context: COMPLETION_JOIN });
    expect(html).not.toContain('data-workflow-completion-card="true"');
    expect(html).toContain("deep-research");
  });

  it("主轮还在跑时没有卡", () => {
    const finished = completionUnit("completed");
    const running = baseUnit({
      ...finished,
      key: "turn-complete:completion-running",
      isRunning: true,
      workStatus: { state: "running", durationMs: 5_000 },
    });
    expect(renderUnit(running, { context: COMPLETION_JOIN })).not.toContain(
      'data-workflow-completion-card="true"',
    );
  });
});

describe("topic preparation flow membership", () => {
  it("renders preparing messages inside the conversation turn with a source loading indicator", () => {
    const items = [
      {
        messageId: "pending-a",
        senderName: "Alice",
        text: "weather",
        status: "preparing" as const,
      },
    ];
    const unit = withTopicPreparationMessages([], [], items)[0]!;
    const botContext = {
      taskId: "task",
      context: { activeTaskId: "task", group: { threadId: "topic" } },
      busyId: null,
      retryPreparation: async () => {},
    } as NonNullable<ContextType<typeof DeliveryContext>>;
    for (const compactForRemoteControl of [false, true]) {
      const html = renderUnit(unit, { botContext, compactForRemoteControl });
      expect(html).toContain('data-topic-preparation="pending-a"');
      const preparation = html.indexOf('data-topic-preparation="pending-a"');
      expect(html.indexOf("<section")).toBeLessThan(preparation);
      expect(html.indexOf("</section>")).toBeGreaterThan(preparation);
      expect(html).toContain('data-v4-user-input-collapsible-content="true"');
      expect(html).toContain('aria-label="正在准备材料"');
    }
  });
});
