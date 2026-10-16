// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { GitRepositorySummary, ZCodeSessionRunningSubagent } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { getStatusPanelTodoFocusWindow } from "@/v4/ConversationStatusPanel.js";

const statusPanelCapture = vi.hoisted(() => ({
  collapsibles: [] as Array<{
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    section?: string;
  }>,
  radioGroups: [] as Array<{
    onValueChange?: (value: string) => void;
    value?: string;
  }>,
  hoverCards: [] as Array<{
    closeDelay?: number;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    openDelay?: number;
  }>,
  gitBranchSwitchers: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/GitActionMenu.js", () => ({
  GitActionMenu: () => createElement("div", { "data-testid": "mock-git-action-menu" }),
}));

vi.mock("@/GitBranchSwitcher.js", () => ({
  GitBranchSwitcher: (props: Record<string, unknown>) => {
    statusPanelCapture.gitBranchSwitchers.push(props);
    return createElement("div", { "data-testid": "mock-git-branch-switcher" });
  },
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "mock-dropdown" }, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "mock-dropdown-content" }, children),
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
    value?: string;
  }) => {
    statusPanelCapture.radioGroups.push({ onValueChange, value });
    return createElement(
      "div",
      { "data-testid": "mock-radio-group", "data-value": value },
      children,
    );
  },
  DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) =>
    createElement("div", { "data-testid": "mock-radio-item", "data-value": value }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/hover-card.js", () => ({
  HoverCard: ({
    children,
    closeDelay,
    onOpenChange,
    open,
    openDelay,
  }: {
    children: ReactNode;
    closeDelay?: number;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    openDelay?: number;
  }) => {
    statusPanelCapture.hoverCards.push({ closeDelay, onOpenChange, open, openDelay });
    return createElement("div", { "data-slot": "hover-card" }, children);
  },
  HoverCardTrigger: ({ children }: { children: ReactNode }) => children,
  HoverCardContent: ({
    align,
    children,
    side,
    sideOffset,
    ...props
  }: {
    align?: string;
    children: ReactNode;
    side?: string;
    sideOffset?: number;
    [key: string]: unknown;
  }) =>
    createElement(
      "div",
      {
        "data-align": align,
        "data-side": side,
        "data-side-offset": sideOffset,
        "data-slot": "hover-card-content",
        ...props,
      },
      children,
    ),
}));

vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({
    children,
    defaultOpen: _defaultOpen,
    onOpenChange,
    open,
    ...props
  }: {
    children: ReactNode;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    [key: string]: unknown;
  }) => {
    statusPanelCapture.collapsibles.push({
      onOpenChange,
      open,
      section: props["data-status-section"] as string | undefined,
    });
    return createElement("div", { "data-slot": "collapsible", ...props }, children);
  },
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => children,
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-slot": "collapsible-content" }, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => {
        const durationUnits: Record<string, string> = {
          "chat.summaryPanel.duration.hours": "小时",
          "chat.summaryPanel.duration.minutes": "分",
          "chat.summaryPanel.duration.seconds": "秒",
        };
        return durationUnits[descriptor.id] ??
          (values ? `${descriptor.id} ${Object.values(values).join("/")}` : descriptor.id);
      },
    },
    locale: "zh-CN",
  }),
}));

function gitSummary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    workspacePath: "/repo",
    repoRoot: "/repo",
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: "origin/main",
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
    ...overrides,
  };
}

function goalState(overrides: Partial<GoalState> = {}): GoalState {
  return {
    targetId: "goal-1",
    objective: "修好状态面板",
    summaryTitle: null,
    timeUsedSeconds: 0,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
    ...overrides,
  };
}

function planState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    updatedAt: 1_700_000_000_000,
    items: [
      { id: "1", content: "看 z-code-2", status: "completed" },
      { id: "2", content: "复刻浮层", status: "inProgress" },
    ],
    ...overrides,
  };
}

describe("getStatusPanelTodoFocusWindow", () => {
  const items = (count: number, currentIndex: number | null) =>
    planState({
      items: Array.from({ length: count }, (_, index) => ({
        id: String(index + 1),
        content: `Todo ${index + 1}`,
        status:
          index === currentIndex
            ? ("inProgress" as const)
            : index < 2
              ? ("completed" as const)
              : ("pending" as const),
      })),
    }).items;

  it("keeps up to six snapshot items fully visible in original order", () => {
    const snapshot = items(6, 2);
    const window = getStatusPanelTodoFocusWindow(snapshot);

    expect(window.compact).toBe(false);
    expect(window.precedingItems).toEqual([]);
    expect(window.focusItems).toEqual(snapshot);
    expect(window.followingItems).toEqual([]);
  });

  it("focuses the running item and its following context without reordering", () => {
    const window = getStatusPanelTodoFocusWindow(items(8, 3));

    expect(window.compact).toBe(true);
    expect(window.precedingItems.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(window.focusItems.map((item) => item.id)).toEqual(["4", "5", "6"]);
    expect(window.followingItems.map((item) => item.id)).toEqual(["7", "8"]);
  });

  it("backfills the focus window when the running item is near the end", () => {
    const window = getStatusPanelTodoFocusWindow(items(8, 7));

    expect(window.focusItems.map((item) => item.id)).toEqual(["6", "7", "8"]);
    expect(window.followingItems).toEqual([]);
  });

  it("uses the first unfinished item or final three completed items as fallback", () => {
    const pendingWindow = getStatusPanelTodoFocusWindow(items(8, null));
    const completedWindow = getStatusPanelTodoFocusWindow(
      items(8, null).map((item) => ({ ...item, status: "completed" as const })),
    );

    expect(pendingWindow.focusItems.map((item) => item.id)).toEqual(["3", "4", "5"]);
    expect(completedWindow.focusItems.map((item) => item.id)).toEqual(["6", "7", "8"]);
  });
});

function backgroundWork(overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary {
  return {
    workId: "work-1",
    kind: "subagent",
    title: "探索渲染逻辑",
    status: "running",
    startedAt: Date.now() - 8_000,
    anchorRowId: null,
    ...overrides,
  };
}

function runningSubagent(
  overrides: Partial<ZCodeSessionRunningSubagent> = {},
): ZCodeSessionRunningSubagent {
  return {
    childSessionId: "child-session",
    subagentType: "Explore",
    title: "探索渲染逻辑",
    status: "running",
    startedAt: Date.now() - 8_000,
    ...overrides,
  };
}

// 面板自己从 workflowRuns 投影 + backgroundWorks 联接出行（模型层的活儿），所以这里造的是
// 两侧输入，而不是行——行的形状由 v4ConversationStatusPanelModel.test.ts 穷举。
/** 声明了三站（盘点 → 计划 → 构建）、正在「计划」的 run。 */
function phasedRunProjection(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return workflowRunProjection({
    phaseNames: ["盘点", "计划", "构建"],
    phases: [{ name: "盘点", rounds: 1 }],
    currentPhase: "计划",
    ...overrides,
  });
}

function workflowRunProjection(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [
      { siteId: "ask#1", ordinal: 1, phase: "settled" },
      { siteId: "ask#2", ordinal: 2, phase: "dispatched" },
      { siteId: "ask#3", ordinal: 3, phase: "queued" },
    ],
    lastEventSequence: 1,
    ...overrides,
  };
}

function sessionPlan(rowId: number, markdown: string): ToolCallRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `plan-${rowId}`,
    toolName: "ExitPlanMode",
    status: "success",
    input: { plan: markdown },
    inputText: JSON.stringify({ plan: markdown }),
  };
}

async function renderStatusPanel(props: Record<string, unknown>) {
  const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
  return renderToStaticMarkup(
    createElement(ConversationStatusPanel, {
      workspacePath: "/repo",
      gitSummary: gitSummary(),
      gitDirtyFileCount: 2,
      gitWorktreeChangeSummary: { added: 12, removed: 3 },
      onRefreshGit: vi.fn(),
      ...props,
    }),
  );
}

describe("ConversationStatusPanel", () => {
  it("uses vertical viewport-bound overlays only on mobile Web remote control", async () => {
    const longPlan = planState({
      items: Array.from({ length: 9 }, (_, index) => ({
        id: String(index + 1),
        content: `Todo ${index + 1}`,
        status: index === 4 ? ("inProgress" as const) : ("pending" as const),
      })),
    });

    statusPanelCapture.gitBranchSwitchers = [];
    const mobileHtml = await renderStatusPanel({
      isMobileViewport: true,
      isWebRemoteControl: true,
      plan: longPlan,
      summaryPanelVariantOverride: "panel",
    });
    expect(statusPanelCapture.gitBranchSwitchers.at(-1)?.popoverSide).toBe("bottom");
    expect(statusPanelCapture.gitBranchSwitchers.at(-1)?.popoverClassName).toContain(
      "max-w-[calc(100vw-2rem)]",
    );
    expect(mobileHtml).toContain('data-side="bottom"');

    statusPanelCapture.gitBranchSwitchers = [];
    const desktopHtml = await renderStatusPanel({
      isMobileViewport: false,
      isWebRemoteControl: false,
      plan: longPlan,
      summaryPanelVariantOverride: "panel",
    });
    expect(statusPanelCapture.gitBranchSwitchers.at(-1)?.popoverSide).toBe("left");
    expect(desktopHtml).toContain('data-side="left"');
  });

  it("goal 计时器只在活动态起一次：投影换一个等值的 goal 对象不重建 interval，暂停即拆掉", async () => {
    // 修订 2026-09-12：此前 effect 以整个 goal 对象为依赖，每个 goal 事件都同步 setNow 并重建
    // interval——落在投影帧的同步提交里，给 React 的嵌套更新计数记一笔（与工作流卡崩溃同形）。
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
      const renderGoal = (goal: GoalState) =>
        createElement(ConversationStatusPanel, {
          workspacePath: "/repo",
          gitSummary: null,
          summaryPanelVariantOverride: "panel",
          goal,
          onPauseGoal: vi.fn(),
          onResumeGoal: vi.fn(),
        });
      const view = render(renderGoal(goalState({ activeRunStartedAtMs: 10_000 })));
      const intervalsAfterMount = setIntervalSpy.mock.calls.length;
      expect(intervalsAfterMount).toBeGreaterThan(0);

      // 同值、不同对象的 goal 帧 ×3：不再有新的 interval。
      for (let i = 0; i < 3; i += 1) {
        view.rerender(renderGoal(goalState({ activeRunStartedAtMs: 10_000, iteration: 1 + i })));
      }
      expect(setIntervalSpy.mock.calls.length).toBe(intervalsAfterMount);

      // 秒针仍在走：过 2 秒后用时文案跟着变。
      const before = view.container.textContent;
      act(() => vi.advanceTimersByTime(2_000));
      expect(view.container.textContent).not.toBe(before);

      // 暂停：interval 拆掉，不再起新的。
      const clearsBefore = clearIntervalSpy.mock.calls.length;
      view.rerender(renderGoal(goalState({ status: "paused", activeRunStartedAtMs: null })));
      expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBefore);
      expect(setIntervalSpy.mock.calls.length).toBe(intervalsAfterMount);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses neutral labels for mixed position buckets and keeps previews mutually exclusive", async () => {
    statusPanelCapture.hoverCards = [];
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        plan: planState({
          items: [
            { id: "1", content: "Todo 1", status: "completed" },
            { id: "2", content: "Todo 2", status: "completed" },
            { id: "3", content: "Todo 3", status: "pending" },
            { id: "4", content: "Todo 4", status: "pending" },
            { id: "5", content: "Todo 5", status: "inProgress" },
            { id: "6", content: "Todo 6", status: "pending" },
            { id: "7", content: "Todo 7", status: "pending" },
            { id: "8", content: "Todo 8", status: "pending" },
            { id: "9", content: "Todo 9", status: "completed" },
          ],
        }),
      }),
    );

    expect(view.container.textContent).toContain("chat.statusPanel.todoEarlierFold 4");
    expect(view.container.textContent).toContain("chat.statusPanel.todoLaterFold 2");
    let previews = statusPanelCapture.hoverCards.slice(-2);
    expect(previews.map((preview) => preview.open)).toEqual([false, false]);

    await act(async () => previews[0]?.onOpenChange?.(true));
    previews = statusPanelCapture.hoverCards.slice(-2);
    expect(previews.map((preview) => preview.open)).toEqual([true, false]);

    await act(async () => previews[1]?.onOpenChange?.(true));
    previews = statusPanelCapture.hoverCards.slice(-2);
    expect(previews.map((preview) => preview.open)).toEqual([false, true]);
    view.unmount();
  });

  it("renders all six Todos without fold controls at the compact threshold", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      plan: planState({
        items: Array.from({ length: 6 }, (_, index) => ({
          id: String(index + 1),
          content: `Todo ${index + 1}`,
          status: index === 0 ? "completed" : "pending",
        })),
      }),
    });

    expect(html).toContain("Todo 1");
    expect(html).toContain("Todo 6");
    expect(html).not.toContain("data-status-todo-preview-trigger");
  });

  it("clamps each Todo label to two lines without truncating its content", async () => {
    const content =
      "检查包含多个测试项目的目录，逐项核对配置文件、依赖安装状态、测试入口和输出目录是否完整";
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "panel",
      plan: planState({
        items: [{ id: "long-todo", content, status: "inProgress" }],
      }),
    });

    expect(html).toContain("line-clamp-2 min-w-0 flex-1 break-words leading-5");
    expect(html).toContain(`title="${content}"`);
    expect(html).toContain(content);
  });

  it("renders terminal plans newest-first and maps a row to the plan detail tab", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      parentSessionId: "parent-session",
      sessionPlans: [sessionPlan(3, "# 较早计划"), sessionPlan(9, "# 最新计划")],
      onOpenPlanDetail: vi.fn(),
    });
    const { buildSessionPlanOpenRequest } = await import("@/v4/ConversationStatusPanel.js");

    expect(html).toContain('data-status-section="sessionPlans"');
    expect(html).toContain('data-status-section-scroll="sessionPlans"');
    expect(html.indexOf("最新计划")).toBeLessThan(html.indexOf("较早计划"));
    expect(html).not.toContain("78 行");
    expect(
      buildSessionPlanOpenRequest("parent-session", {
        rowId: 9,
        toolCallId: "plan-9",
        markdown: "# 最新计划",
        title: "最新计划",
        planFilePath: "/repo/.zcode/plans/latest.md",
      }),
    ).toEqual({
      parentSessionId: "parent-session",
      toolCallId: "plan-9",
      markdown: "# 最新计划",
      planFilePath: "/repo/.zcode/plans/latest.md",
    });
  });

  it("keeps the shell mounted for plan-only mini state", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      sessionPlans: [sessionPlan(4, "# 唯一计划")],
    });

    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain("唯一计划");
    expect(html).toContain("chat.summaryPanel.showPanel");
  });

  it("orders expanded sections as Git, Goal, plans, Todo, terminals, workflows, and Agents", async () => {
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "panel",
      goal: goalState(),
      sessionPlans: [sessionPlan(4, "# 会话计划")],
      plan: planState(),
      backgroundWorks: [
        backgroundWork({ kind: "bash" }),
        backgroundWork({ workId: "dwfrun-1", kind: "workflow" }),
      ],
      workflowRuns: [workflowRunProjection()],
      runningSubagents: [runningSubagent()],
    });
    const indexes = [
      "environment",
      "goal",
      "sessionPlans",
      "plan",
      "terminal",
      "workflow",
      "agent",
    ].map((section) => html.indexOf(`data-status-section="${section}"`));

    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });

  it("renders the mini shell with one-line git summary", async () => {
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "mini",
    });

    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain("chat.summaryPanel.showPanel");
    expect(html).toContain("chat.statusPanel.changes");
    expect(html).toContain("+12");
    expect(html).toContain("-3");
    expect(html).not.toContain("mock-git-action-menu");
  });

  it("keeps goal and running background authority on the mini shell", async () => {
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "mini",
      goal: goalState(),
      runningSubagents: [runningSubagent()],
    });

    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain('data-goal-status="active"');
    expect(html).toContain('data-goal-objective="修好状态面板"');
    expect(html).toContain('data-running-background-count="1"');
    expect(html).toContain("修好状态面板");
    expect(html).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValue 1");
    expect(html).not.toContain("lucide-bot");
  });

  it("uses Bot for Subagent-only mini summaries and reserves Activity for mixed work", async () => {
    const subagentOnly = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      runningSubagents: [runningSubagent()],
    });
    expect(subagentOnly).toContain("chat.statusPanel.runningAgentsValue 1");
    expect(subagentOnly).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValue 1");
    expect(subagentOnly).not.toMatch(/\d+秒/u);
    expect(subagentOnly).toContain("lucide-bot");
    expect(subagentOnly).not.toContain("lucide-activity");
    expect(subagentOnly).not.toContain("lucide-square-terminal");

    const bashOnly = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      backgroundWorks: [backgroundWork({ kind: "bash" })],
    });
    expect(bashOnly).toContain("chat.summaryPanel.runningBackgroundTasksMiniValue 1");
    expect(bashOnly).not.toContain("chat.statusPanel.runningAgentsValue 1");
    expect(bashOnly).toContain("lucide-square-terminal");
    expect(bashOnly).not.toContain("lucide-bot");
    expect(bashOnly).not.toContain("lucide-activity");

    const mixed = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      backgroundWorks: [backgroundWork({ workId: "bash-1", kind: "bash" })],
      runningSubagents: [runningSubagent()],
    });
    expect(mixed).toContain("chat.statusPanel.runningAgentsValuePlural 2");
    expect(mixed).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValuePlural 2");
    expect(mixed).toContain("lucide-activity");
    expect(mixed).not.toContain("lucide-bot");
    expect(mixed).not.toContain("lucide-square-terminal");
  });

  // ── Workflows 分区（docs/dynamic-workflow/presentation.md「Other places a run appears」）──
  // 一行两行高：第一行 名称 + 时长，第二行 侧栏同款轨道 + phase 词。状态词不再可见（灯和 phase
  // 已经说了），但仍进打开按钮的无障碍名。步数只在没有 phase 表时出现。
  it("renders a run as name and time over the sidebar rail and its phase words", async () => {
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: [phasedRunProjection()],
        backgroundWorks: [
          backgroundWork({
            workId: "dwfrun-1",
            kind: "workflow",
            title: "重构状态胶囊",
            startedAt: Date.now() - 194_000,
          }),
        ],
        workflowSectionOpen: true,
        onCancelBackgroundWork: vi.fn(),
        onOpenWorkflowRun: vi.fn(),
      }),
    );
    const row = view.container.querySelector<HTMLElement>('[data-workflow-run-id="dwfrun-1"]');
    const lineOne = row?.querySelector<HTMLElement>("[data-workflow-island-line='name']");
    const lineTwo = row?.querySelector<HTMLElement>("[data-workflow-island-line='phase']");

    expect(lineOne?.textContent).toContain("重构状态胶囊");
    expect(lineOne?.querySelector("[data-workflow-run-elapsed]")?.textContent).toBe("3分 14秒");
    // 轨道就是侧栏那一条：done / running / pending 三种灯按声明序排开。
    expect(
      [...(lineTwo?.querySelectorAll("[data-rail-station]") ?? [])].map((lamp) =>
        lamp.getAttribute("data-rail-station"),
      ),
    ).toEqual(["done", "running", "pending"]);
    expect(lineTwo?.textContent).toContain("计划");
    // 可见文字里没有状态词、没有步数、没有「已运行」前缀。
    expect(row?.textContent).not.toContain("chat.toolCall.workflow.run.status.running");
    expect(row?.textContent).not.toContain("chat.toolCall.workflow.card.steps");
    expect(row?.textContent).not.toContain("chat.longRunning");
    // 状态词挪进打开按钮的无障碍名：名称 · 状态 · phase。
    expect(
      row?.querySelector('[data-workflow-run-details-trigger="true"]')?.getAttribute("aria-label"),
    ).toBe(
      "chat.toolCall.workflow.openRunDetails · 重构状态胶囊 · chat.toolCall.workflow.run.status.running · 计划",
    );
    // Stop 叠在时长上（悬停 / 键盘焦点时出现），无障碍名与卡片的「停止运行」同一个 key。
    const stop = row?.querySelector<HTMLElement>(
      '[data-testid="v4-background-work-cancel-dwfrun-1"]',
    );
    expect(stop?.getAttribute("aria-label")).toBe("chat.toolCall.workflow.run.cancel");
    expect(stop?.textContent).toContain("chat.statusPanel.runningStop");
    view.unmount();
    expect(zhCN["chat.statusPanel.workflows"]).toBe("工作流");
    expect(enUS["chat.statusPanel.workflows"]).toBe("Workflows");
  });

  it("joins parallel burning phases with ∥ and draws the twin segment", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [
        phasedRunProjection({
          phaseNames: ["准备", "安全", "性能"],
          phaseAlongside: [[], [], [1]],
          phases: [
            { name: "准备", rounds: 1 },
            { name: "安全", rounds: 1 },
          ],
          currentPhase: "性能",
          nodes: [
            { siteId: "ask#1", ordinal: 1, phase: "settled", phaseName: "准备" },
            { siteId: "ask#2", ordinal: 2, phase: "executing", phaseName: "安全" },
            { siteId: "ask#3", ordinal: 3, phase: "executing", phaseName: "性能" },
          ],
        }),
      ],
      workflowSectionOpen: true,
    });

    expect(html).toContain("安全 ∥ 性能");
    expect(html).toContain('data-rail-twin="true"');
  });

  it("falls back to one lamp and steps when the script declared no phases", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      workflowSectionOpen: true,
    });

    expect(html).toContain('data-workflow-island-line="phase"');
    expect(html).toContain('data-workflow-run-lamp="running"');
    expect(html).toContain("chat.toolCall.workflow.card.steps 1/3");
    expect(html).not.toContain("data-rail-station");
  });

  it("shows a pending run as a hollow lamp and the status word, with no time", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection({ status: "pending" })],
      backgroundWorks: [backgroundWork({ workId: "dwfrun-1", kind: "workflow", title: "迁移" })],
      workflowSectionOpen: true,
    });

    expect(html).toContain('data-workflow-run-lamp="pending"');
    expect(html).toContain("chat.toolCall.workflow.run.status.pending");
    expect(html).not.toContain("data-workflow-run-elapsed");
    expect(html).not.toContain("chat.toolCall.workflow.card.steps");
  });

  it("drops seconds from the elapsed time past an hour", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      backgroundWorks: [
        backgroundWork({
          workId: "dwfrun-1",
          kind: "workflow",
          title: "长跑",
          startedAt: Date.now() - 3_727_000,
        }),
      ],
      workflowSectionOpen: true,
    });

    expect(html).toMatch(/data-workflow-run-elapsed="true"[^>]*>1小时 2分</u);
    expect(html).not.toContain("1小时 2分 7秒");
  });

  // 头部右侧开合一个样：灯 + 「{n} 个运行中」。折叠时不再换成「所有 run 里最长的时长」——那不是
  // 任何一条 run 的时间。
  it("reads the same live count in the section header open or folded", async () => {
    const works = [
      backgroundWork({ workId: "dwfrun-1", kind: "workflow", startedAt: Date.now() - 3_727_000 }),
      backgroundWork({ workId: "dwfrun-2", kind: "workflow", startedAt: Date.now() - 5_000 }),
    ];
    const runs = [workflowRunProjection(), workflowRunProjection({ runId: "dwfrun-2" })];
    for (const open of [true, false]) {
      const html = await renderStatusPanel({
        gitSummary: null,
        gitWorktreeChangeSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: runs,
        backgroundWorks: works,
        workflowSectionOpen: open,
      });
      const header = html.slice(
        html.indexOf('data-status-section-trigger="workflow"'),
        html.indexOf(
          'data-slot="collapsible-content"',
          html.indexOf('data-status-section="workflow"'),
        ),
      );
      expect(header).toContain("chat.statusPanel.workflowsLive 2");
      expect(header).not.toMatch(/\d+秒/u);
    }
    expect(zhCN["chat.statusPanel.workflowsLive"]).toBe("{count} 个运行中");
    expect(enUS["chat.statusPanel.workflowsLive"]).toBe("{count} running");
  });

  // 已结束入口在滚动区之外：runs 多到要滚时它也不会被滚出视野。
  it("keeps the ended-runs entry below the scrolling run list", async () => {
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: [workflowRunProjection()],
        endedWorkflowRunCount: 3,
        parentSessionId: "parent-a",
        workflowSectionOpen: true,
        onOpenWorkflowRunDirectory: vi.fn(),
      }),
    );
    const scroll = view.container.querySelector('[data-status-section-scroll="workflow"]');
    const trigger = view.container.querySelector('[data-testid="workflow-run-directory-trigger"]');
    const row = view.container.querySelector('[data-workflow-run-id="dwfrun-1"]');

    expect(scroll?.contains(row)).toBe(true);
    expect(trigger).not.toBeNull();
    expect(scroll?.contains(trigger)).toBe(false);
    view.unmount();
  });

  // 未命名规则：core 的 workflowTaskSubject 兜底链落到 taskId（≡ runId ≡ workId），投影再把
  // 非空 description 原样抄进 title——所以「题名恰好等于 id」是唯一可靠的未命名信号。
  it("substitutes the shared fallback name when the title is just the run id", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      backgroundWorks: [
        backgroundWork({ workId: "dwfrun-1", kind: "workflow", title: "dwfrun-1" }),
      ],
      workflowSectionOpen: true,
    });

    expect(html).toContain("chat.toolCall.workflow.fallbackName");
    expect(html).not.toContain(">dwfrun-1<");
  });

  it("keeps a degraded skew row without status or steps but with its Stop control", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      // 旧 CLI：只有 workflow work，没有 workflowRuns 投影键。
      backgroundWorks: [
        backgroundWork({ workId: "dwfrun-skew", kind: "workflow", title: "旧 CLI 的 run" }),
      ],
      workflowSectionOpen: true,
      onCancelBackgroundWork: vi.fn(),
    });

    expect(html).toContain('data-status-section="workflow"');
    expect(html).toContain("旧 CLI 的 run");
    expect(html).toContain('data-testid="v4-background-work-cancel-dwfrun-skew"');
    expect(html).not.toContain("chat.toolCall.workflow.run.status.");
    expect(html).not.toContain("chat.toolCall.workflow.card.steps");
    expect(html).not.toContain('data-workflow-island-line="phase"');
    expect(html).toContain("data-workflow-run-elapsed");
  });

  it("drops elapsed and Stop for a run whose background work is gone", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      workflowSectionOpen: true,
      onCancelBackgroundWork: vi.fn(),
    });

    expect(html).toContain("chat.toolCall.workflow.card.steps 1/3");
    expect(html).not.toContain("data-workflow-run-elapsed");
    // 无 work → 无 workId → 停不了；Stop 的两个前提字段在模型层就一起缺席。
    expect(html).not.toContain("v4-background-work-cancel");
    expect(html).not.toContain("chat.statusPanel.runningStop");
  });

  it("opens the run details tab through a transparent sibling button", async () => {
    const onOpenWorkflowRun = vi.fn();
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: [workflowRunProjection()],
        workflowSectionOpen: true,
        onOpenWorkflowRun,
      }),
    );
    const trigger = view.container.querySelector<HTMLButtonElement>(
      '[data-workflow-run-details-trigger="true"]',
    );

    expect(trigger).not.toBeNull();
    // Stop 是行内嵌套交互，所以详情入口不能是整行 button——透明同级按钮，与 Agent 行同款。
    expect(trigger?.getAttribute("aria-label")).toBe(
      "chat.toolCall.workflow.openRunDetails · chat.toolCall.workflow.fallbackName · chat.toolCall.workflow.run.status.running · chat.toolCall.workflow.card.steps 1/3",
    );
    await act(async () => trigger?.click());
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
    });
    view.unmount();
  });

  it("carries the workflow name into the target for a named run", async () => {
    // 任务岛入口曾只交出 runId + toolCallId，详情页标签因此兜底成通用名，而工具卡入口显示真名。
    // 行的题名由 workflowRuns 投影按 workId ≡ runId 联接 workflow 后台任务的 title 得到。
    const onOpenWorkflowRun = vi.fn();
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: [workflowRunProjection()],
        backgroundWorks: [
          backgroundWork({ workId: "dwfrun-1", kind: "workflow", title: "Ship the release" }),
        ],
        workflowSectionOpen: true,
        onOpenWorkflowRun,
      }),
    );
    const trigger = view.container.querySelector<HTMLButtonElement>(
      '[data-workflow-run-details-trigger="true"]',
    );
    await act(async () => trigger?.click());
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
      workflowName: "Ship the release",
    });
    view.unmount();
  });

  it("omits the workflow name for an unnamed run (title ≡ runId)", async () => {
    // `title ≡ runId` 是未命名 run 的兜底样子；把 runId 冻进标签比通用兜底名更糟，所以不带出去。
    const onOpenWorkflowRun = vi.fn();
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: [workflowRunProjection()],
        backgroundWorks: [
          backgroundWork({ workId: "dwfrun-1", kind: "workflow", title: "dwfrun-1" }),
        ],
        workflowSectionOpen: true,
        onOpenWorkflowRun,
      }),
    );
    const trigger = view.container.querySelector<HTMLButtonElement>(
      '[data-workflow-run-details-trigger="true"]',
    );
    await act(async () => trigger?.click());
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
    });
    view.unmount();
  });

  it("leaves a row without toolCallId or host callback unclickable", async () => {
    const withoutToolCallId = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection({ toolCallId: undefined })],
      workflowSectionOpen: true,
      onOpenWorkflowRun: vi.fn(),
    });
    expect(withoutToolCallId).toContain('data-workflow-run-id="dwfrun-1"');
    expect(withoutToolCallId).not.toContain("data-workflow-run-details-trigger");

    const withoutHostCallback = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      workflowSectionOpen: true,
    });
    expect(withoutHostCallback).toContain('data-workflow-run-id="dwfrun-1"');
    expect(withoutHostCallback).not.toContain("data-workflow-run-details-trigger");
  });

  it("keeps the projection order of active runs instead of sorting by start time", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      // 投影序即启动序；后启动的 run 反而 startedAt 更早也不许把它排到前面。
      workflowRuns: [
        workflowRunProjection({ runId: "dwfrun-late", toolCallId: "tool-late" }),
        workflowRunProjection({ runId: "dwfrun-early", toolCallId: "tool-early" }),
      ],
      backgroundWorks: [
        backgroundWork({
          workId: "dwfrun-late",
          kind: "workflow",
          title: "后启动",
          startedAt: Date.now() - 1_000,
        }),
        backgroundWork({
          workId: "dwfrun-early",
          kind: "workflow",
          title: "先启动",
          startedAt: Date.now() - 60_000,
        }),
      ],
      workflowSectionOpen: true,
    });

    expect(html.indexOf('data-workflow-run-id="dwfrun-late"')).toBeLessThan(
      html.indexOf('data-workflow-run-id="dwfrun-early"'),
    );
  });

  // ── 已结束的 run 折进页脚行（docs/dynamic-workflow/presentation.md「Other places a run appears」）──

  it("folds ended runs into a footer row that opens the run directory", async () => {
    const onOpenWorkflowRunDirectory = vi.fn();
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "panel",
        workflowRuns: [workflowRunProjection()],
        endedWorkflowRunCount: 3,
        parentSessionId: "parent-a",
        workflowSectionOpen: true,
        onOpenWorkflowRunDirectory,
      }),
    );
    const trigger = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-run-directory-trigger"]',
    );

    expect(trigger).not.toBeNull();
    // 桶名刻意不是「已完成」：这个桶里也有失败与取消的 run。
    expect(trigger?.textContent).toContain("chat.statusPanel.endedWorkflows");
    expect(trigger?.textContent).toContain("3");
    await act(async () => trigger?.click());
    expect(onOpenWorkflowRunDirectory).toHaveBeenCalledWith({ parentSessionId: "parent-a" });
    view.unmount();

    expect(zhCN["chat.statusPanel.endedWorkflows"]).toBe("已结束的工作流");
    expect(enUS["chat.statusPanel.endedWorkflows"]).toBe("Ended workflows");
  });

  it("keeps the Workflows section when nothing is active but history exists (the restart entry)", async () => {
    // 重启后 workflowRuns 投影为空（memory-only）。只按活动数开门的那一版在这里整块消失，
    // 于是通往 run 目录的唯一入口也没了——这条用例就是钉住那个失效。
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      endedWorkflowRunCount: 2,
      parentSessionId: "parent-a",
      workflowSectionOpen: true,
      onOpenWorkflowRunDirectory: vi.fn(),
    });

    expect(html).toContain('data-status-section="workflow"');
    expect(html).toContain('data-testid="workflow-run-directory-trigger"');
    expect(html).toContain('data-ended-workflow-count="2"');
    // 一行活动 run 都没有，所以不该出现任何 run 行。
    expect(html).not.toContain("data-workflow-run-id");
  });

  it("hides the footer row when there is no history, no session, or no host callback", async () => {
    const noHistory = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      endedWorkflowRunCount: 0,
      parentSessionId: "parent-a",
      workflowSectionOpen: true,
      onOpenWorkflowRunDirectory: vi.fn(),
    });
    expect(noHistory).toContain('data-workflow-run-id="dwfrun-1"');
    expect(noHistory).not.toContain("workflow-run-directory-trigger");

    // 点了没反应的入口比没有入口更糟：缺会话或缺回调时整行缺席。
    const noCallback = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      endedWorkflowRunCount: 5,
      parentSessionId: "parent-a",
      workflowSectionOpen: true,
    });
    expect(noCallback).not.toContain("workflow-run-directory-trigger");

    const noSession = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      endedWorkflowRunCount: 5,
      workflowSectionOpen: true,
      onOpenWorkflowRunDirectory: vi.fn(),
    });
    expect(noSession).not.toContain("workflow-run-directory-trigger");
  });

  it("names the live run in the mini capsule instead of counting it (an ended run is not activity)", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      workflowRuns: [workflowRunProjection()],
      endedWorkflowRunCount: 7,
      parentSessionId: "parent-a",
      onOpenWorkflowRunDirectory: vi.fn(),
    });

    expect(html).toContain('data-running-workflow-count="1"');
    expect(html).toContain('data-running-background-count="1"');
    expect(html).toContain('data-workflow-pill="dwfrun-1"');
    expect(html).toContain("chat.toolCall.workflow.fallbackName");
    expect(html).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValue");
    expect(html).not.toContain("chat.statusPanel.endedWorkflows");
  });

  // 活的工作流排在胶囊最前：它在跑时就是会话在做的事；todo / goal / git 都让位。
  it("puts a live workflow ahead of the to-do, goal and git summaries in the pill", async () => {
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "mini",
      plan: planState(),
      goal: goalState(),
      workflowRuns: [
        phasedRunProjection(),
        workflowRunProjection({ runId: "dwfrun-2", status: "pending" }),
      ],
      backgroundWorks: [
        backgroundWork({ workId: "dwfrun-1", kind: "workflow", title: "重构状态胶囊" }),
        backgroundWork({ workId: "dwfrun-2", kind: "workflow", title: "第二条" }),
      ],
    });
    const pill = html.slice(html.indexOf("data-workflow-pill"));

    expect(pill).toContain("重构状态胶囊");
    expect(pill).toContain('data-workflow-run-lamp="running"');
    expect(pill).toContain("计划");
    expect(pill).toContain("+1");
    expect(pill).not.toContain("第二条");
    expect(html).not.toContain("复刻浮层");
    expect(html).not.toContain("chat.statusPanel.changes");
  });

  // 展开后看到的不能比胶囊还少：胶囊显示着工作流时，点它展开面板并同时打开「工作流」分区——
  // 哪怕读者先前手动折过它。胶囊显示别的（todo / git …）时不碰这个分区。
  it("opens the Workflows section when the clicked pill was showing a workflow", async () => {
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
    const onVariantChange = vi.fn();
    const onWorkflowSectionOpenChange = vi.fn();
    const view = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "mini",
        workflowRuns: [workflowRunProjection()],
        workflowSectionOpen: false,
        onVariantChange,
        onWorkflowSectionOpenChange,
      }),
    );
    const pill = view.container.querySelector("[data-workflow-pill]")?.closest("button");
    await act(async () => pill?.click());
    expect(onVariantChange).toHaveBeenCalledWith("panel");
    expect(onWorkflowSectionOpenChange).toHaveBeenCalledWith(true);
    view.unmount();

    const onOtherSectionOpenChange = vi.fn();
    const todoView = render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: null,
        summaryPanelVariantOverride: "mini",
        plan: planState(),
        onVariantChange: vi.fn(),
        onWorkflowSectionOpenChange: onOtherSectionOpenChange,
      }),
    );
    const todoPill = todoView.container.querySelector<HTMLButtonElement>(
      'button[aria-label="chat.summaryPanel.showPanel"]',
    );
    await act(async () => todoPill?.click());
    expect(onOtherSectionOpenChange).not.toHaveBeenCalled();
    todoView.unmount();
  });

  it("shows a degraded run in the pill by name alone, without a lamp", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      backgroundWorks: [
        backgroundWork({ workId: "dwfrun-skew", kind: "workflow", title: "旧 CLI 的 run" }),
      ],
    });

    expect(html).toContain('data-workflow-pill="dwfrun-skew"');
    expect(html).toContain("旧 CLI 的 run");
    expect(html).not.toContain("data-workflow-run-lamp");
  });

  // 胶囊宽度只由 CSS 决定（w-max + 以 conversation 容器为基准的上限）：不再有 JS 量出来的
  // 宽度变量。测量值会晚内容一次渲染、上限又按窗口宽度算，两者都能让文字落到胶囊外面。
  it("sizes the pill with CSS alone, capped by the conversation column", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      workflowRuns: [workflowRunProjection()],
    });

    expect(html).not.toContain("--chat-summary-panel-mini-width");
    expect(html).toContain("max-w-[min(20rem,calc(100cqw-2rem))]");
    expect(html).not.toContain("100vw");
  });

  it("shows the ended-runs metric in the mini capsule when nothing else is alive", async () => {
    // Bug 复现：工作区无 Git 变更、workflow 跑完的瞬间——卸载闸门为了 run 目录入口保留
    // 壳（canRenderEndedWorkflows），但胶囊兜底链没有终态分支，渲染成一条 2px 空壳线。
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      workflowRuns: [],
      endedWorkflowRunCount: 3,
      parentSessionId: "parent-a",
      onOpenWorkflowRunDirectory: vi.fn(),
    });

    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain("chat.statusPanel.endedWorkflows");
    expect(html).toContain("3");
  });

  it("keeps the ended-runs metric behind the directory gate (no session or callback → no capsule text)", async () => {
    // 与页脚同一条规则：目录打不开时，报数就是一个点了没反应的入口。此时 hasContent 也是
    // false，整个壳按既有闸门卸载。
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      workflowRuns: [],
      endedWorkflowRunCount: 3,
      parentSessionId: "parent-a",
    });

    expect(html).not.toContain("chat.statusPanel.endedWorkflows");
    expect(html).not.toContain('data-state="collapsed"');
  });

  it("shows the workflow pill even when terminals run beside it", async () => {
    const mixedWithWorkflow = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      workflowRuns: [workflowRunProjection()],
      backgroundWorks: [backgroundWork({ workId: "bash-1", kind: "bash" })],
    });
    expect(mixedWithWorkflow).toContain('data-running-background-count="2"');
    expect(mixedWithWorkflow).toContain('data-workflow-pill="dwfrun-1"');
    expect(mixedWithWorkflow).toContain("lucide-workflow");
    expect(mixedWithWorkflow).not.toContain("lucide-activity");
    expect(mixedWithWorkflow).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValue");
  });

  it("keeps the capsule alive for a workflow run as the only content", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      workflowRuns: [workflowRunProjection()],
    });

    expect(html).toContain('data-testid="chat-summary-panel"');
    expect(html).toContain('data-state="collapsed"');
  });

  it("controls the workflow section open state and forwards manual collapse", async () => {
    const onWorkflowSectionOpenChange = vi.fn();
    statusPanelCapture.collapsibles = [];
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      workflowRuns: [workflowRunProjection()],
      workflowSectionOpen: true,
      onWorkflowSectionOpenChange,
    });

    expect(html).toContain('data-status-section-trigger="workflow"');
    const workflow = statusPanelCapture.collapsibles.find(
      (entry) => entry.section === "workflow",
    );
    expect(workflow?.open).toBe(true);
    workflow?.onOpenChange?.(false);
    expect(onWorkflowSectionOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows realtime activity only when the capsule has no primary status", async () => {
    const gitPrimary = await renderStatusPanel({
      summaryPanelVariantOverride: "mini",
      runningSubagents: [runningSubagent()],
    });
    expect(gitPrimary).toContain("chat.statusPanel.changes");
    expect(gitPrimary).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValue 1");
    expect(gitPrimary).not.toContain("lucide-bot");

    const completedGoalPrimary = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      goal: goalState({ status: "verified", summaryTitle: "已完成主目标" }),
      backgroundWorks: [backgroundWork({ kind: "bash" })],
    });
    expect(completedGoalPrimary).toContain("已完成主目标");
    expect(completedGoalPrimary).not.toContain(
      "chat.summaryPanel.runningBackgroundTasksMiniValue 1",
    );
    expect(completedGoalPrimary).not.toContain("lucide-square-terminal");
  });

  it("keeps a notSatisfied goal visible in mini with its summary title", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      goal: goalState({
        objective: "复现用目标：总共完成 4 个 checkpoint",
        summaryTitle: "四步Checkpoint复现",
        status: "notSatisfied",
      }),
    });

    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain('data-goal-status="notSatisfied"');
    expect(html).toContain("chat.summaryPanel.showPanel");
    expect(html).toContain("四步Checkpoint复现");
    expect(html).not.toContain(">复现用目标：总共完成 4 个 checkpoint<");
  });

  // Bug 原因：状态面板里 goal 语义曾混用两种图标——展开迭代行用 GoalIcon（球门），
  // 折叠 mini 摘要用 TargetIcon（靶心）。展开/折叠时图标跳变，且与项目里其他
  // goal 入口（消息行、用户输入、工具调用）用的 GoalIcon 不一致。
  // 固化约定：面板内所有 goal 图标统一为 GoalIcon，禁止出现 TargetIcon。
  it("uses GoalIcon consistently for goal across expanded section and mini summary", async () => {
    const miniActive = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      goal: goalState({ status: "active" }),
    });
    expect(miniActive).toContain("lucide-goal");
    expect(miniActive).not.toContain("lucide-target");

    const miniVerified = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      goal: goalState({ status: "verified", summaryTitle: "已完成主目标" }),
    });
    expect(miniVerified).toContain("lucide-goal");
    expect(miniVerified).not.toContain("lucide-target");
  });

  it("does not keep a mini capsule alive for ended Agents alone", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "mini",
      endedSubagentCount: 3,
      parentSessionId: "parent-session",
      onOpenSubagentDirectory: vi.fn(),
    });

    expect(html).toBe("");
  });

  it("nests the ended directory row inside the Agent section", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      plan: planState(),
      runningSubagents: [runningSubagent()],
      endedSubagentCount: 3,
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      onOpenSubagentDirectory: vi.fn(),
    });

    const agentSectionStart = html.indexOf('data-status-section="agent"');
    const agentSectionEnd = html.indexOf("</section>", agentSectionStart);
    const endedDirectoryRow = html.indexOf("chat.statusPanel.endedAgents");
    expect(agentSectionStart).toBeGreaterThanOrEqual(0);
    expect(endedDirectoryRow).toBeGreaterThan(agentSectionStart);
    expect(endedDirectoryRow).toBeLessThan(agentSectionEnd);
    expect(html).toContain("chat.statusPanel.endedAgents");
    expect(html).toContain(">3<");
  });

  it("keeps ended-only content inside an Agent section when another summary keeps the panel", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      plan: planState(),
      endedSubagentCount: 3,
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      onOpenSubagentDirectory: vi.fn(),
    });

    const agentSectionStart = html.indexOf('data-status-section="agent"');
    const agentSectionEnd = html.indexOf("</section>", agentSectionStart);
    const endedDirectoryRow = html.indexOf("chat.statusPanel.endedAgents");
    expect(agentSectionStart).toBeGreaterThanOrEqual(0);
    expect(endedDirectoryRow).toBeGreaterThan(agentSectionStart);
    expect(endedDirectoryRow).toBeLessThan(agentSectionEnd);
  });

  it("renders the expanded z-code-2 panel controls and sections", async () => {
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "panel",
      goal: goalState(),
      plan: planState(),
      runningSubagents: [runningSubagent()],
    });

    expect(html).toContain('data-state="expanded"');
    expect(html).toContain("chat.summaryPanel.displayMode");
    expect(html).toContain("chat.summaryPanel.displayModeAuto");
    expect(html).not.toContain("chat.summaryPanel.displayModeExpanded");
    expect(html).not.toContain("chat.summaryPanel.displayModeCollapsed");
    expect(html).toContain("mock-git-branch-switcher");
    expect(html).toContain("mock-git-action-menu");
    expect(html).toContain("修好状态面板");
    expect(html).toContain("复刻浮层");
    expect(html).toContain("chat.statusPanel.agents");
    expect(html).toContain('data-goal-status="active"');
    expect(html).toContain('data-goal-objective="修好状态面板"');
    expect(html).toContain('data-running-background-count="1"');
    expect(html).toContain('data-status-section="agent"');
    expect(html).toContain('data-status-section-trigger="agent"');
    expect(html).toContain("shrink-0 text-ui-base text-[var(--color-foreground-subtle)]");
    expect(html).toContain("gap-1.5 text-ui-sm text-[var(--color-foreground-subtlest)]");
    expect(html).toContain("line-clamp-2 text-ui-base leading-5");
    expect(html).toContain("pl-2 pr-3 text-ui-base text-[var(--color-foreground)]");
  });

  it("uses the conversation container query for automatic responsive mode", async () => {
    const html = await renderStatusPanel({
      layoutMode: "auto",
      summaryPanelVariantOverride: null,
    });

    expect(html).toContain('data-display-mode="auto"');
    expect(html).toContain("@min-[1280px]/conversation:flex");
    expect(html).toContain("@min-[1280px]/conversation:hidden");
    expect(html).toContain("@min-[1280px]/conversation:right-4");
    expect(html).toContain("inset-x-0 flex justify-end px-4");
  });

  it("controls the Agent section open state and forwards manual collapse", async () => {
    const onAgentSectionOpenChange = vi.fn();
    statusPanelCapture.collapsibles = [];
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      runningSubagents: [runningSubagent()],
      agentSectionOpen: true,
      onAgentSectionOpenChange,
    });

    expect(html).toContain('data-status-section-trigger="agent"');
    expect(html).toContain('aria-expanded="true"');
    const agent = statusPanelCapture.collapsibles.find((entry) => entry.section === "agent");
    expect(agent?.open).toBe(true);
    agent?.onOpenChange?.(false);
    expect(onAgentSectionOpenChange).toHaveBeenCalledWith(false);
  });

  it("labels the Agent section count as running instead of background", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      runningSubagents: [
        runningSubagent({ childSessionId: "agent-1" }),
        runningSubagent({ childSessionId: "agent-2" }),
      ],
      agentSectionOpen: true,
    });
    const agentSectionStart = html.indexOf('data-status-section="agent"');
    const agentSection = html.slice(
      agentSectionStart,
      html.indexOf("</section>", agentSectionStart),
    );

    expect(agentSection).toContain("chat.statusPanel.runningAgentsValuePlural 2");
    expect(agentSection).not.toContain("chat.summaryPanel.runningBackgroundTasksMiniValuePlural 2");
    expect(zhCN["chat.statusPanel.runningAgentsValuePlural"]).toBe("{count} 运行");
    expect(enUS["chat.statusPanel.runningAgentsValuePlural"]).toBe("{count} running");
  });

  it("renders active elapsed, pause control, and every iteration action/status", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      onPauseGoal: vi.fn(),
      goal: goalState({
        summaryTitle: "第一轮：恢复摘要",
        timeUsedSeconds: 9,
        iteration: 1,
        verifications: [
          {
            iteration: 1,
            outcome: "notSatisfied",
            at: 1_700_000_000_000,
            anchorRowId: null,
            reason: "还缺状态",
            nextAction: "第二轮：补暂停和完成态",
          },
        ],
        iterations: [
          {
            iteration: 1,
            updatedAt: 1_700_000_000_000,
            items: [{ id: "one", content: "恢复计时", status: "completed" }],
          },
          {
            iteration: 2,
            updatedAt: 1_700_000_001_000,
            items: [
              { id: "two", content: "恢复按钮", status: "inProgress" },
              { id: "three", content: "验证状态", status: "pending" },
            ],
          },
        ],
      }),
    });

    expect(html).toContain("9秒");
    expect(html).toContain('data-goal-action="pause"');
    expect(html).toContain("第一轮：恢复摘要");
    expect(html).toContain("第二轮：补暂停和完成态");
    expect(html).toContain('data-goal-iteration="1"');
    expect(html).toContain('data-goal-iteration-completed="true"');
    expect(html).toContain("0/2");
  });

  it("renders paused play and verified green check as mutually exclusive controls", async () => {
    const paused = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      onResumeGoal: vi.fn(),
      goal: goalState({ status: "paused", timeUsedSeconds: 12 }),
    });
    expect(paused).toContain('data-goal-action="resume"');
    expect(paused).not.toContain('data-goal-action="pause"');

    const verified = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      goal: goalState({ status: "verified", timeUsedSeconds: 18 }),
    });
    expect(verified).toContain("chat.goalVerification.complete");
    expect(verified).not.toContain("data-goal-action=");
  });

  it("does not append verifier reason cards after visible iteration actions", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      goal: goalState({
        iteration: 1,
        verifications: [
          {
            iteration: 1,
            outcome: "notSatisfied",
            at: 1_700_000_000_000,
            anchorRowId: null,
            reason: "这段 verifier reason 不应出现在右上角灰卡",
            nextAction: "继续第二轮 action",
          },
        ],
      }),
    });

    expect(html).toContain("继续第二轮 action");
    expect(html).not.toContain("这段 verifier reason 不应出现在右上角灰卡");
  });

  it("restores Stop only for projected Agents with an exact background control match", async () => {
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      onCancelBackgroundWork: vi.fn(),
      backgroundWorks: [
        backgroundWork({
          workId: "bash-newer",
          kind: "bash",
          title: "启动开发服务器",
          startedAt: Date.now() - 3_000,
          cancellable: false,
        }),
        backgroundWork({
          workId: "agent-control-work",
          kind: "subagent",
          childSessionId: "agent-older",
          title: "packages结构分析",
          cancellable: true,
        }),
        backgroundWork({
          workId: "agent-disabled-work",
          kind: "subagent",
          childSessionId: "agent-disabled",
          title: "不可停止的 Agent",
          cancellable: false,
        }),
      ],
      runningSubagents: [
        runningSubagent({
          childSessionId: "agent-older",
          title: "packages结构分析",
          startedAt: Date.now() - 9_000,
        }),
        runningSubagent({
          childSessionId: "agent-disabled",
          title: "不可停止的 Agent",
        }),
        runningSubagent({
          childSessionId: "foreground-agent",
          title: "同名但无 background control",
        }),
      ],
    });

    expect(html).toContain('data-background-task-kind="bash"');
    expect(html).toContain('data-background-task-kind="agent"');
    expect(html).toContain('data-child-session-id="agent-older"');
    expect(html).toContain('data-work-id="agent-control-work"');
    expect(html).toContain('data-work-status="running"');
    expect(html).toContain(
      'data-testid="v4-background-work-item-agent-control-work"',
    );
    expect(html).toContain('data-status-section="terminal"');
    expect(html).toContain('data-status-section="agent"');
    expect(html).toContain("chat.statusPanel.terminals");
    expect(html).toContain("chat.statusPanel.agents");
    expect(html).toContain("lucide-bot");
    expect(html).toContain("lucide-square-terminal");
    expect(html).not.toContain("subagent · packages结构分析");
    expect(html).not.toContain("bash · 启动开发服务器");
    expect(html).toContain("chat.longRunning.elapsedSeconds 9");
    expect(html).toContain("flex-wrap");
    expect(html).toContain('data-testid="v4-background-work-cancel-agent-control-work"');
    expect(html).not.toContain('data-testid="v4-background-work-cancel-agent-older"');
    expect(html).not.toContain('data-testid="v4-background-work-cancel-agent-disabled-work"');
    expect(html).not.toContain('data-testid="v4-background-work-cancel-foreground-agent"');
    expect(html).not.toContain('data-testid="v4-background-work-cancel-bash-newer"');
    const terminalSection = html.slice(
      html.indexOf('data-status-section="terminal"'),
      html.indexOf('data-status-section="agent"'),
    );
    expect(terminalSection).toContain("启动开发服务器");
    expect(terminalSection).not.toContain("packages结构分析");
    const agentSection = html.slice(html.indexOf('data-status-section="agent"'));
    expect(agentSection).toContain("packages结构分析");
    expect(agentSection).not.toContain("启动开发服务器");
  });

  it("turns projected running Agents into child-session triggers", async () => {
    const addressableSubagent = runningSubagent({
      childSessionId: "child-addressable",
    });
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      parentSessionId: "parent-session",
      rootSessionId: "root-session",
      onOpenSubagentSession: vi.fn(),
      runningSubagents: [
        addressableSubagent,
        runningSubagent({ childSessionId: "child-second", title: "第二个 Agent" }),
      ],
    });
    const { buildRunningSubagentOpenRequest } = await import("@/v4/ConversationStatusPanel.js");

    expect(html.match(/data-running-subagent-session-trigger="true"/g)).toHaveLength(2);
    expect(html).toContain('data-child-session-id="child-addressable"');
    expect(
      buildRunningSubagentOpenRequest({
        parentSessionId: "parent-session",
        rootSessionId: "root-session",
        subagent: addressableSubagent,
      }),
    ).toEqual({
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      childSessionId: "child-addressable",
      subagentType: "Explore",
      title: "探索渲染逻辑",
    });
  });

  it("bounds all six long status section types and keeps long Todos behind expansion", async () => {
    const todoItems = Array.from({ length: 8 }, (_, index) => ({
      id: `todo-${index + 1}`,
      content: `Todo 第 ${index + 1} 项`,
      status: index === 0 ? ("inProgress" as const) : ("pending" as const),
    }));
    const html = await renderStatusPanel({
      summaryPanelVariantOverride: "panel",
      goal: goalState({
        iterations: Array.from({ length: 8 }, (_, index) => ({
          iteration: index + 1,
          updatedAt: 1_700_000_000_000 + index,
          items: [],
        })),
      }),
      sessionPlans: Array.from({ length: 8 }, (_, index) =>
        sessionPlan(index + 1, `# 计划第 ${index + 1} 项`),
      ),
      plan: planState({ items: todoItems }),
      backgroundWorks: [
        backgroundWork({ workId: "bash-1", kind: "bash", title: "终端任务一" }),
        backgroundWork({ workId: "bash-2", kind: "bash", title: "终端任务二" }),
        backgroundWork({ workId: "dwfrun-1", kind: "workflow", title: "工作流一" }),
      ],
      workflowRuns: [workflowRunProjection()],
      runningSubagents: [
        runningSubagent({ childSessionId: "agent-1", title: "智能体一" }),
        runningSubagent({ childSessionId: "agent-2", title: "智能体二" }),
      ],
      terminalSectionOpen: true,
      workflowSectionOpen: true,
      agentSectionOpen: true,
    });

    for (const section of ["goal", "sessionPlans", "plan", "terminal", "workflow", "agent"]) {
      expect(html).toContain(`data-status-section-scroll="${section}"`);
    }
    expect(html).not.toContain('data-status-section-scroll="environment"');
    expect(html).toContain("max-h-80 min-h-0 overflow-x-hidden overflow-y-auto pr-1");
    expect(html).toContain("max-h-48 min-h-0 overflow-x-hidden overflow-y-auto pr-1");
    expect(html).toContain("max-h-[min(64dvh,32rem)]");
    expect(html).toContain(
      "min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2 flex",
    );
    for (const item of todoItems) {
      expect(html).toContain(item.content);
    }
    expect(html).toContain('data-status-todo-preview-trigger="following"');
    expect(html).toContain('data-status-todo-preview-content="following"');
    expect(html).toContain('data-side="left"');
    expect(html).toContain('data-align="start"');
    expect(html).toContain('data-side-offset="4"');
    expect(html).toContain(
      "flex max-h-[min(24rem,calc(100dvh-2rem))] min-w-0 flex-col",
    );
    expect(html).toContain("min-h-0 space-y-0 overflow-y-auto pr-1");
    expect(html).toContain("chat.statusPanel.todoWaitingFold 5");
    expect(html).toContain(
      "rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground-subtle)]",
    );
    expect(statusPanelCapture.hoverCards).toContainEqual(
      expect.objectContaining({
        closeDelay: 80,
        open: false,
        openDelay: 120,
      }),
    );
  });

  it("keeps a long Agent viewport bounded beside short Progress and Plans sections", async () => {
    const agents = Array.from({ length: 5 }, (_, index) =>
      runningSubagent({
        childSessionId: `mixed-agent-${index + 1}`,
        title: `Background sleep agent ${index + 1}`,
      }),
    );
    const html = await renderStatusPanel({
      gitSummary: null,
      gitWorktreeChangeSummary: null,
      summaryPanelVariantOverride: "panel",
      sessionPlans: [sessionPlan(1, "# 组合场景计划")],
      plan: planState({
        items: [{ id: "short-progress", content: "你好", status: "inProgress" }],
      }),
      runningSubagents: agents,
      agentSectionOpen: true,
    });

    for (const section of ["sessionPlans", "plan", "agent"]) {
      expect(html).toContain(`data-status-section-scroll="${section}"`);
    }
    for (const agent of agents) {
      expect(html).toContain(agent.title);
    }
    expect(html).toContain("max-h-80 min-h-0 overflow-x-hidden overflow-y-auto pr-1");
    expect(html).toContain("max-h-48 min-h-0 overflow-x-hidden overflow-y-auto pr-1");
  });

  it("pins the expanded shell to the right edge when inline with the conversation", async () => {
    const html = await renderStatusPanel({
      layoutMode: "inline",
      summaryPanelVariantOverride: "panel",
      goal: goalState(),
    });

    expect(html).toMatch(/^<div class="pointer-events-none absolute top-0 z-20 pt-4 right-4"/);
    expect(html).not.toMatch(/^<div class="[^"]*inset-x-0[^"]*justify-end/);
  });

  it("maps the display mode menu back to nullable shell override", async () => {
    statusPanelCapture.radioGroups = [];
    const onVariantChange = vi.fn();
    vi.stubGlobal("window", {
      innerWidth: 1200,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    try {
      await renderStatusPanel({
        summaryPanelVariantOverride: null,
        onVariantChange,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(statusPanelCapture.radioGroups).toHaveLength(1);
    expect(statusPanelCapture.radioGroups[0]?.value).toBe("auto");

    statusPanelCapture.radioGroups[0]?.onValueChange?.("mini");
    expect(onVariantChange).toHaveBeenLastCalledWith("mini");

    statusPanelCapture.radioGroups[0]?.onValueChange?.("auto");
    expect(onVariantChange).toHaveBeenLastCalledWith(null);
  });
});
