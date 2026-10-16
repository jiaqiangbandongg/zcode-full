// @vitest-environment jsdom

// dwf run 详情页（docs/dynamic-workflow/presentation.md「The run pane」）：状态头 / 用量行 / Cancel /
// 结果与失败面板 / 待答问题 / 产物 / 空态，双语言。
//
// 2026-09-04 用户指令：Results（`report` 条目）、事件日志、Script 三节已从面板撤走（技术细节，
// 不给用户看），对应的用例整段删除；journal 的读面没有变化，只是这块面板不再显示它们。
//
// 纯规则（Cancel 可用性、结果判定、事件摘要）在 workflowRunPanel.test.ts 里穷举；
// 这里只钉「那些结果真的接到了 DOM 上」以及交互（点击 Cancel 发出哪条命令）。
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACTS_SECTION, TID_WORKFLOW_ARTIFACT_CARD } from "@zcode/shared";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

// 提示只渲染 children（不改 DOM 形状），但把 title / description 记下来：Stop 钮的第二行
// 「停下的运行可以恢复」只活在提示里。
const tooltips = vi.hoisted(() => ({
  calls: [] as Array<{ title: unknown; description?: string }>,
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
    description,
  }: {
    children?: ReactNode;
    title?: unknown;
    description?: string;
  }) => {
    tooltips.calls.push({ title, ...(description === undefined ? {} : { description }) });
    return children;
  },
}));

const sendCommand = vi.fn(async () => ({ status: "accepted" }) as never);
const release = vi.fn();
// layer 必须是**稳定引用**：组件的租约 effect 以 layer 为依赖，每次渲染换一个新对象
// 会让 acquire → setLease → 重渲染 → 新 layer 无限循环（生产里 useV4Conversation
// 返回的是 useMemo 过的 bundle，本来就稳定）。
const layer = { acquire: vi.fn(() => ({ release })) };
const workflowRunsQuery = vi.fn<() => Promise<{ runs: unknown[] }>>(async () => ({ runs: [] }));
// 产物（docs/dynamic-workflow/authoring.md）：清单走 journal 查询，看板条目走取数查询。
// 两条都在这里桩掉——面板挂载时无条件问一次清单（活投影不带 spec 与版本历史）。
const workflowRunArtifactsQuery = vi.fn<() => Promise<{ artifacts: unknown[] }>>(async () => ({
  artifacts: [],
}));
const workflowRunArtifactDataQuery = vi.fn<() => Promise<{ items: unknown[]; hasMore: boolean }>>(
  async () => ({ items: [], hasMore: false }),
);
const conversation = {
  layer,
  sendCommand,
  workflowRuns: workflowRunsQuery,
  workflowRunArtifacts: workflowRunArtifactsQuery,
  workflowRunArtifactData: workflowRunArtifactDataQuery,
};

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => conversation,
}));

let snapshot: unknown = null;
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({ snapshot }),
}));

// 「配置」弹层的模型清单（docs/dynamic-workflow/presentation.md「The settings popover」）：面板本身不读它，
// 只有弹层打开时才订阅；给一份空清单即可（字段本身在 workflowRunSettingsPopover.test.ts 里钉）。
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({
    state: { status: "ready", view: { revision: 1, providers: [] } },
    reload: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first -- 必须在全部 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
// eslint-disable-next-line import/first
import { useDynamicWorkflowAvailabilityStore } from "@/store/dynamicWorkflowAvailabilityStore.js";

/** 灰度快照（docs/dynamic-workflow/launch.md「Gray release」）：默认命中，面板与改动前一致。 */
function setDynamicWorkflowEnabled(enabled: boolean): void {
  useDynamicWorkflowAvailabilityStore.setState({
    status: "ready",
    enabled,
    config: { mode: enabled ? "alwaysOn" : "disabled", enabled, source: "remote" },
  });
}

const tab: WorkflowRunSidePaneTab = {
  id: "workflow-run:%2Fworkspace:parent-a:dwfrun-1",
  type: "workflow-run",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
  toolCallId: "tool-wf-1",
  runId: "dwfrun-1",
  workflowName: "Fan-out review",
};

interface GraphStep {
  id: string;
  kind: "ask" | "world-read";
  label: string;
  lane: string;
  line?: number;
  phase?: string;
}

const STEPS: GraphStep[] = [
  {
    id: "ask#1",
    kind: "ask",
    label: "plan",
    lane: "actor#1",
    // 检视器 SOURCE 区的 `L{n}` 需要一个落点：车道没有行号时退回它第一步的行。
    line: 4,
  },
  // 检视用的另外几张卡：workspace 车道（合成，无会话）与两条匿名车道。
  {
    id: "world-read#1",
    kind: "world-read",
    label: "read files",
    lane: "workspace",
  },
  {
    id: "ask#2",
    kind: "ask",
    label: "review",
    lane: "actor#2",
  },
  {
    id: "ask#3",
    kind: "ask",
    label: "audit",
    lane: "actor#3",
  },
];

const LANES = [
  { id: "actor#1", name: "planner" },
  // 两条匿名车道：编号必须出现（Anonymous Subagent 1 / 2），且与图里那份同源。
  { id: "actor#2" },
  { id: "actor#3" },
  { id: "workspace" },
];

/** 参与者 = 每阶段每车道一张卡，id 按分析器的 `${phase}:${lane}`；无标记脚本归 `unphased`。 */
function participantsOf(steps: readonly GraphStep[]) {
  const byId = new Map<string, { id: string; phase: string; lane: string; steps: string[] }>();
  for (const step of steps) {
    const phase = step.phase ?? "unphased";
    const id = `${phase}:${step.lane}`;
    const existing = byId.get(id);
    if (existing) existing.steps.push(step.id);
    else byId.set(id, { id, lane: step.lane, phase, steps: [step.id] });
  }
  return [...byId.values()];
}

const graphRow = {
  kind: "toolCall" as const,
  rowId: "row-1",
  toolCallId: "tool-wf-1",
  toolName: "CreateWorkflow",
  status: "success" as const,
  inputText: "",
  display: {
    kind: "create_workflow" as const,
    ok: true,
    errorCount: 0,
    diagnostics: [],
    causalityGraph: {
      steps: STEPS,
      lanes: LANES,
      participants: participantsOf(STEPS),
      handoffs: [],
    },
  },
};

/**
 * 阶段词汇表在场的变体：单开手风琴与阶段选择需要真的有两个阶段可开。
 * 基础图刻意**没有**阶段——绝大多数用例与阶段无关，给它们平白加一层商图只会让
 * 「这条用例在验什么」变模糊。
 */
const PHASES = [
  { id: "phase#a", name: "plan", line: 3 },
  { id: "phase#b", name: "review", line: 9 },
];
const PHASE_OF: Record<string, string> = {
  "ask#1": "phase#a",
  "ask#2": "phase#b",
  "ask#3": "phase#b",
  "world-read#1": "phase#a",
};

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

function setSnapshot(
  options: {
    run?: WorkflowRunState;
    withGraphRow?: boolean;
    /** 换成带 `phase()` 词汇表的图（模块板面）；缺省是今天的 step/车道图。 */
    phased?: boolean;
  } = {},
) {
  const phasedSteps = STEPS.map((step) => ({ ...step, phase: PHASE_OF[step.id]! }));
  const causalityGraph =
    options.phased === true
      ? {
          ...graphRow.display.causalityGraph,
          participants: participantsOf(phasedSteps),
          phases: PHASES,
          // 相邻两站之间的边：脊线只在有边的相邻两站之间画轨道段（与卡同一条规则）。
          phaseEdges: [{ from: "phase#a", to: "phase#b" }],
          steps: phasedSteps,
        }
      : graphRow.display.causalityGraph;
  const row = { ...graphRow, display: { ...graphRow.display, causalityGraph } };
  snapshot = {
    rows: { window: options.withGraphRow === false ? [] : [row] },
    ...(options.run ? { workflowRuns: { revision: 1, runs: [options.run] } } : {}),
  };
}

const onOpenWorkflowActorSession = vi.fn();
const onOpenWorkflowArtifact = vi.fn();
const onOpenWorkflowWorkspace = vi.fn();
const onOpenWorkflowRun = vi.fn();

function renderPane(
  locale: "en-US" | "zh-CN" = "en-US",
  options: {
    withActorCallback?: boolean;
    withArtifactCallback?: boolean;
    withWorkspaceCallback?: boolean;
    /** 「已被 run X 替代」的链接要宿主给开 run 的回调；缺省不给（多数用例与 lineage 无关）。 */
    withOpenRunCallback?: boolean;
  } = {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunSidePane, {
        tab,
        ...(options.withActorCallback === false ? {} : { onOpenWorkflowActorSession }),
        ...(options.withArtifactCallback === false ? {} : { onOpenWorkflowArtifact }),
        ...(options.withWorkspaceCallback === false ? {} : { onOpenWorkflowWorkspace }),
        ...(options.withOpenRunCallback === true ? { onOpenWorkflowRun } : {}),
      }),
    ),
  );
}

// 待答问题区默认收起，所以任何**条目级**断言都要先点开。这个小助手让「先展开」在用例里
// 只占一行，读者的注意力留给真正被钉的东西。
type Pane = ReturnType<typeof renderPane>;
/**
 * 换了投影之后重渲染同一棵树（行是活的，不是打开那一刻的快照）。面板是 memo 组件，投影在
 * 真实应用里经由 context 订阅推进；这里的投影是 mock 出来的模块变量，所以给一个新的 tab
 * 对象让 memo 放行。
 */
function rerenderPane(view: Pane, locale: "en-US" | "zh-CN" = "en-US"): Pane {
  view.rerender(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunSidePane, { tab: { ...tab }, onOpenWorkflowActorSession }),
    ),
  );
  return view;
}

beforeEach(() => {
  // 本仓 vitest 没开 globals，所以 @testing-library 的自动 cleanup 不会注册；
  // 不显式清理，上一条用例的 DOM 会留下来，getByTestId 随即报「找到多个」。
  cleanup();
  sendCommand.mockClear();
  workflowRunsQuery.mockClear();
  workflowRunsQuery.mockImplementation(async () => ({ runs: [] }));
  workflowRunArtifactsQuery.mockClear();
  workflowRunArtifactsQuery.mockImplementation(async () => ({ artifacts: [] }));
  workflowRunArtifactDataQuery.mockClear();
  workflowRunArtifactDataQuery.mockImplementation(async () => ({ items: [], hasMore: false }));
  onOpenWorkflowActorSession.mockClear();
  onOpenWorkflowArtifact.mockClear();
  onOpenWorkflowWorkspace.mockClear();
  setDynamicWorkflowEnabled(true);
  setSnapshot({ run: run() });
});

describe("WorkflowRunSidePane 状态头与阶段清单", () => {
  it("阶段清单按声明序一节一阶段，正在运行的阶段自己展开", () => {
    // docs/dynamic-workflow/presentation.md「The spine」：时间线读作一份纵向清单。
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    const view = renderPane();

    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-id"))).toEqual([
      "phase#a",
      "phase#b",
    ]);
    expect(phases.map((phase) => phase.textContent)).toEqual([
      expect.stringContaining("plan"),
      expect.stringContaining("review"),
    ]);
    expect(phases[1]!.getAttribute("data-phase-status")).toBe("running");
    expect(phases[1]!.getAttribute("data-phase-open")).toBe("true");
    expect(phases[0]!.getAttribute("data-phase-status")).toBe("pending");
    expect(phases[0]!.getAttribute("data-phase-open")).toBe("false");
  });

  it("运行阶段变化时把新的那一节打开，已展开的不动", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    const view = renderPane();
    expect(view.getAllByTestId("workflow-run-phase")[0]!.getAttribute("data-phase-open")).toBe(
      "true",
    );

    setSnapshot({
      run: run({
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "ask#2", ordinal: 1, phase: "executing" },
        ],
      }),
      phased: true,
    });
    rerenderPane(view);
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-open"))).toEqual(["true", "true"]);
    expect(phases[0]!.getAttribute("data-phase-status")).toBe("done");
  });

  it("脊线：轨道段按模型的墨迹分两截画在相邻两站上，灯带状态，行进段在进入运行站的那一段", () => {
    // docs/dynamic-workflow/presentation.md「The spine」。plan 已结算、review 在跑：
    // a→b 那段轨道是行进；plan 的灯绿、review 的灯琥珀带搏动。
    setSnapshot({
      run: run({
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "ask#2", ordinal: 1, phase: "executing" },
        ],
      }),
      phased: true,
    });
    const view = renderPane();
    const rails = view.getAllByTestId("workflow-run-spine-rail");
    // 两截都得带着 `data-rail-position`：样式表按它选行进段的渐变（下半截淡入、上半截涨到满）。
    expect(rails.map((rail) => rail.getAttribute("data-rail-position"))).toEqual([
      "below",
      "above",
    ]);
    expect(rails.map((rail) => rail.getAttribute("data-rail-ink"))).toEqual(["march", "march"]);
    expect(rails[0]!.className).toContain("wf-spine-march");
    expect(rails[0]!.className).toContain("w-[1.5px]");
    const lamps = view.getAllByTestId("workflow-run-phase-lamp");
    expect(lamps.map((lamp) => lamp.getAttribute("data-lamp"))).toEqual(["done", "running"]);
    expect(lamps[1]!.className).toContain("wf-lamp-running");
    // 灯在节头按钮里：悬停节头时既有的 `.wf-station-open:hover .wf-lamp` 光环规则接得上。
    expect(lamps[0]!.closest('[data-testid="workflow-run-phase-toggle"]')).toBeTruthy();
  });

  it("脊线：没有边的相邻两站之间不画轨道段；折起的阶段在节头带头像串，展开后头像串让位给药丸", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    const view = renderPane();
    // plan 折着：头像串在场（planner + workspace = 2 枚，无 +n）；review 展开：没有头像串。
    const [plan, review] = view.getAllByTestId("workflow-run-phase");
    const cluster = within(plan!).getByTestId("workflow-run-phase-cluster");
    expect(cluster.querySelectorAll("[title]")).toHaveLength(2);
    expect(cluster.className).toContain("gap-1");
    expect(cluster.querySelector(".rounded-full")).toBeNull();
    expect(cluster.querySelectorAll("img.size-4, svg.size-4")).toHaveLength(2);
    expect(cluster.textContent).not.toContain("+");
    expect(within(review!).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    // 展开 plan 后头像串消失，药丸出现。
    fireEvent.click(within(plan!).getByTestId("workflow-run-phase-toggle"));
    expect(within(plan!).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    expect(within(plan!).getAllByTestId("workflow-agent-pill").length).toBeGreaterThan(0);
  });

  it("脊线：无边的图没有轨道段；轮次写成 ⟳ n 而不是灯串", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    // 把边拿掉：轨道段整个缺席（相邻无边留空，与卡同一条规则）。
    snapshot = {
      ...(snapshot as { rows: { window: { display: { causalityGraph: object } }[] } }),
      rows: {
        window: (
          snapshot as { rows: { window: { display: { causalityGraph: object } }[] } }
        ).rows.window.map((row) => ({
          ...row,
          display: {
            ...row.display,
            causalityGraph: { ...row.display.causalityGraph, phaseEdges: [] },
          },
        })),
      },
    };
    const view = renderPane();
    expect(view.queryAllByTestId("workflow-run-spine-rail")).toHaveLength(0);
    expect(view.queryByTestId("workflow-run-phase-rounds")).toBeNull();
  });

  it("渲染 run 状态词（灯旁永远有词）", () => {
    setSnapshot({ run: run({ status: "completed" }) });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-status").textContent).toBe("Completed");
  });

  it("直接启动（无工具行）时从启动轮元数据取图（docs/dynamic-workflow/launch.md）", () => {
    const launchRow = {
      kind: "userInput" as const,
      rowId: "row-launch",
      text: "Started the saved workflow",
      origin: "workflowLaunch" as const,
      workflowLaunch: {
        runId: "dwfrun-1",
        toolCallId: "tool-wf-1",
        name: "Fan-out review",
        scope: "project" as const,
        path: "/workspace/.zcode/workflows/fan-out-review.dwf.ts",
        display: graphRow.display,
        script: "export default async function main() {}",
      },
    };
    snapshot = {
      rows: { window: [launchRow] },
      workflowRuns: { revision: 1, runs: [run()] },
    };
    const view = renderPane();
    expect(view.getByTestId("workflow-run-phases")).toBeTruthy();
    expect(view.queryByTestId("workflow-run-graph-unavailable")).toBeNull();
  });

  // 直接启动的来龙去脉（docs/dynamic-workflow/launch.md「The launch turn」）：作用域、说明、实参与「由你从
  // 工作流中枢启动 · 时刻」只在这里说——聊天区的 run 卡与工具路径发起的一模一样。
  it("直接启动的 run：状态头下有来龙去脉节——脚注、作用域徽标、说明、实参表", () => {
    const workflowLaunch = {
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
      name: "Fan-out review",
      scope: "global" as const,
      path: "/home/u/.zcode/workflows/fan-out-review.dwf.ts",
      description: "Review a change from several angles.",
      args: { topic: "adaptive concurrency", depth: 3 },
      display: graphRow.display,
    };
    snapshot = {
      rows: {
        window: [
          {
            kind: "turnHeader" as const,
            rowId: "row-header",
            origin: "workflowLaunch" as const,
            executionKind: "controlOnly" as const,
            state: "completedSuccess" as const,
            startedAt: Date.UTC(2026, 8, 14, 13, 34),
            workflowLaunch,
          },
          {
            kind: "userInput" as const,
            rowId: "row-launch",
            text: "Started the saved workflow",
            origin: "workflowLaunch" as const,
            workflowLaunch,
          },
        ],
      },
      workflowRuns: { revision: 1, runs: [run()] },
    };
    const view = renderPane();
    const provenance = view.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-scope")).toBe("global");
    expect(provenance.textContent).toContain("Started by you from the workflows hub");
    expect(provenance.textContent).toContain(" · ");
    expect(view.getByTestId("workflow-run-provenance-scope").textContent).toBe("Global");
    expect(provenance.textContent).toContain("Review a change from several angles.");
    const args = view.getByTestId("workflow-run-provenance-args").textContent ?? "";
    expect(args).toContain("topic");
    expect(args).toContain("adaptive concurrency");
    expect(args).toContain("depth");
    expect(args).toContain("3");
    // 来龙去脉排在状态头之后、结果区 / 脊线之前。
    const header = view.getByTestId("workflow-run-status").closest("div.border-b")!;
    expect(
      header.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByTestId("workflow-run-phases")).toBeTruthy();
  });

  it("工具路径发起的 run 没有来龙去脉节", () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-provenance")).toBeNull();
  });

  it("行窗口里翻不到那条工具调用时给出「没有图」而不是空清单", () => {
    setSnapshot({ run: run(), withGraphRow: false });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-phases")).toBeNull();
    expect(view.getByTestId("workflow-run-graph-unavailable").textContent).toContain(
      "not in this conversation's visible history",
    );
  });
});

// ── 子代理模型（docs/dynamic-workflow/presentation.md「The run pane」）──
// 用户在启动时把这次 run 的子代理定在了另一个模型上；主代理仍是会话模型，所以只说子代理。
// 状态头第一行**不再**摆模型芯片（它放不下，截断后剩下的正是 provider id）：模型名成了摘要行的
// 第一段——这一行本来就是「这条 run 的几个数」。规范串与强度退进 tooltip。
// 没指定过模型的 run 整段缺席——跟随会话模型是常态，没有可说的。
describe("WorkflowRunSidePane 子代理模型", () => {
  // 团队套餐的 provider id 是一串十六进制：这次改动要挡的就是它。
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  it("模型名是摘要行的第一段，不再是状态头上的芯片", () => {
    setSnapshot({ run: run({ subagentModel: "zhipu/glm-5.3-flash" }) });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents glm-5.3-flash");
    // 它住在摘要行里，不在状态头那一行（与并发芯片、Stop 钮同排的那一行）。
    expect(segment.closest('[data-testid="workflow-run-usage"]')).not.toBeNull();
    const summary = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(summary.indexOf("Subagents glm-5.3-flash")).toBe(0);
  });

  it("屏幕上绝不出现 provider id，哪怕它是团队套餐的 UUID；规范串退进 tooltip", () => {
    setSnapshot({ run: run({ subagentModel: TEAM_PLAN_MODEL }) });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents GLM-5.3-Flash");
    expect(segment.textContent).not.toContain("4fc7f541");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(segment.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    // 强度不上屏，它跟规范串一起住在 tooltip 里。
    expect(segment.getAttribute("title")).toContain("thinking High");
  });

  it("zh-CN 下同一段说中文，模型名原样不译", () => {
    setSnapshot({ run: run({ subagentModel: TEAM_PLAN_MODEL }) });
    const view = renderPane("zh-CN");

    expect(view.getByTestId("workflow-run-subagent-model").textContent).toBe(
      "子代理 GLM-5.3-Flash",
    );
  });

  it("图不可得（建不出时间线）退回用量行时，模型仍在行首：它与有没有图无关", () => {
    setSnapshot({
      run: run({ subagentModel: TEAM_PLAN_MODEL, usage: { spentTokens: 12_345, nodesUsed: 3 } }),
      withGraphRow: false,
    });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents GLM-5.3-Flash");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(segment.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    // 同一行里，模型在前，用量标签与读数照旧跟在后面。
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage.indexOf("Subagents GLM-5.3-Flash")).toBe(0);
    expect(usage).toContain("Usage");
    expect(usage).toContain("12,345 tokens · 3 steps");
  });

  it("没指定过模型的 run 里整段缺席（子代理跟随会话模型）", () => {
    setSnapshot({ run: run() });
    const view = renderPane();

    expect(view.queryByTestId("workflow-run-subagent-model")).toBeNull();
    expect(document.body.textContent).not.toContain("Subagents ");
  });

  it("run 不在投影里（被淘汰 / 冷启动）时也没有这一段", () => {
    setSnapshot({});
    const view = renderPane();

    expect(view.queryByTestId("workflow-run-subagent-model")).toBeNull();
  });
});

describe("WorkflowRunSidePane 摘要行", () => {
  it("与聊天卡页脚同文案：工作中的子代理数、步数、token，没有上限、没有进度轨", () => {
    setSnapshot({
      run: run({
        usage: { spentTokens: 12_345, nodesUsed: 3 },
        actors: [{ siteId: "actor#1", ordinal: 1, status: "running" }],
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "executing" }],
      }),
    });
    const view = renderPane();
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage).toContain("1 agent working");
    expect(usage).toContain("0/1 steps");
    expect(usage).toContain("12,345 tokens");
    expect(usage).not.toContain("%");
    expect(view.container.querySelector("progress")).toBeNull();
  });

  it("图不可得（建不出时间线）时退回用量行", () => {
    setSnapshot({
      run: run({ usage: { spentTokens: 12_345, nodesUsed: 3 } }),
      withGraphRow: false,
    });
    const view = renderPane();
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage).toContain("Usage");
    expect(usage).toContain("12,345 tokens · 3 steps");
  });

  // 实例表撞界（docs/dynamic-workflow/presentation.md「The run pane」）：摘要行里的步数已经把
  // 表外的实例算进来了，脊柱却只列得出表内那些——这一句说的正是这个差额。
  it("撞界的 run 在摘要行下多一句「仅展示 n/m 步的详情」，计数仍是真实步数", () => {
    setSnapshot({
      run: run({
        usage: {
          spentTokens: 1,
          nodesUsed: 1_100,
          nodesUnlisted: 2_000,
          nodesUnlistedSettled: 1_500,
        },
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }],
        truncated: true,
      }),
    });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-truncated").textContent).toBe(
      "Details shown for 1 of 2001 steps",
    );
    expect(view.getByTestId("workflow-run-usage").textContent ?? "").toContain("1501/2001 steps");
  });

  it("没撞界、以及只有小表撞界（步数一个不少）的 run 都没有这一句", () => {
    setSnapshot({ run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled" }] }) });
    expect(renderPane().queryByTestId("workflow-run-truncated")).toBeNull();
    cleanup();
    // `truncated` 也会被 reports / artifacts / phases 触界置位；那时再念「仅展示 1/1 步」是句废话。
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled" }], truncated: true }),
    });
    expect(renderPane().queryByTestId("workflow-run-truncated")).toBeNull();
  });

  it("zh-CN 念「仅展示 1/2,001 步的详情」", () => {
    setSnapshot({
      run: run({
        usage: { spentTokens: 1, nodesUsed: 1, nodesUnlisted: 2_000 },
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "queued" }],
        truncated: true,
      }),
    });
    expect(renderPane("zh-CN").getByTestId("workflow-run-truncated").textContent).toBe(
      "仅展示 1/2001 步的详情",
    );
  });
});

describe("WorkflowRunSidePane Stop", () => {
  it("running 时可点，并且走既有的 cancelBackgroundWork {workId ≡ runId}", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    const button = view.getByTestId<HTMLButtonElement>("workflow-run-cancel");
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    const envelope = sendCommand.mock.calls[0]![0] as unknown as {
      type: string;
      sessionId: string;
      payload: { workId: string };
    };
    expect(envelope.type).toBe("cancelBackgroundWork");
    expect(envelope.payload).toEqual({ workId: "dwfrun-1" });
    expect(envelope.sessionId).toBe("parent-a");
  });

  it.each(["pending", "completed", "errored", "stopped"] as const)("%s 时按钮禁用", (status) => {
    setSnapshot({ run: run({ status }) });
    const view = renderPane();
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(true);
  });

  it("run 不在投影里时按钮禁用（对它的在飞状态一无所知）", () => {
    setSnapshot({});
    const view = renderPane();
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(true);
  });

  it("按钮说 Stop run，图标与卡上那枚同款：实心方块", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    const button = view.getByTestId("workflow-run-cancel");
    expect(button.getAttribute("aria-label")).toBe("Stop run");
    expect(button.textContent).toContain("Stop run");
    // 与 WorkflowRunDigest 的 Stop 钮同形：填充 currentColor 的方块，不是叉。
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("fill-current");
    expect(icon?.querySelector("rect")).toBeTruthy();
  });

  it("可点时提示带第二行「停下的运行可以恢复」；禁用时只剩为什么不可用", () => {
    setSnapshot({ run: run({ status: "running" }) });
    renderPane();
    expect(tooltips.calls.find((call) => call.title === "Stop run")?.description).toBe(
      "You can resume later; finished steps are kept.",
    );

    cleanup();
    tooltips.calls.length = 0;
    setSnapshot({ run: run({ status: "completed" }) });
    renderPane();
    const disabled = tooltips.calls.find(
      (call) => call.title === "Only a running workflow can be stopped.",
    );
    expect(disabled).toBeTruthy();
    expect(disabled?.description).toBeUndefined();
  });
});

// 修复原因（2026-09-15，桌面实测）：老 run 被误留在 running 时 Cancel 点了没反应；Resume 撞上
// 不再编译的老脚本同样只在控制台留 warn。被拒的 ACK 现在按词表变成状态头下的一句话。
describe("WorkflowRunSidePane 被拒提示", () => {
  it("cancel 被拒（not_found）→ 状态头下出现一句话；run 状态一变即收起", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.backgroundWorkCancelRejected.not_found",
    } as never);
    const view = renderPane();

    fireEvent.click(view.getByTestId("workflow-run-cancel"));

    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("not running in this agent");
    // 按钮不被锁死：提示只是解释，不改变可点性。
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(false);

    setSnapshot({ run: run({ status: "stopped", stopReason: "user" }) });
    rerenderPane(view);
    expect(view.queryByTestId("workflow-run-rejection")).toBeNull();
  });

  it("resume 被拒（compile_failed）→ 一句话指向调整工作流 + ACK 的诊断在等宽块里", async () => {
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.workflowRunResumeRejected.compile_failed",
      message: "L3:C1 Property 'askWithOldFacade' does not exist",
    } as never);
    const view = renderPane();

    fireEvent.click(await view.findByTestId("workflow-run-resume"));

    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("no longer compiles");
    expect(hint.textContent).toContain("amend the workflow");
    expect(hint.querySelector("pre")?.textContent).toContain("askWithOldFacade");
  });

  it("词表外的 reasonCode → 通用文案带 code；accepted 不出提示", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.executionFailed",
    } as never);
    const view = renderPane();

    fireEvent.click(view.getByTestId("workflow-run-cancel"));
    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("fault.command.executionFailed");

    setSnapshot({ run: run({ status: "stopped" }) });
    rerenderPane(view);
    setSnapshot({ run: run({ status: "running" }) });
    rerenderPane(view);
    fireEvent.click(view.getByTestId("workflow-run-cancel"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-rejection")).toBeNull();
  });

  it("zh-CN 文案", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.backgroundWorkCancelRejected.not_running",
    } as never);
    const view = renderPane("zh-CN");
    fireEvent.click(view.getByTestId("workflow-run-cancel"));
    expect((await view.findByTestId("workflow-run-rejection")).textContent).toContain("已经结束");
  });
});

describe("WorkflowRunSidePane 结果与失败面板", () => {
  it("completed 且无 resultPreview 时指向会话里的后台结果消息，不编造结果", () => {
    setSnapshot({ run: run({ status: "completed" }) });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-result").textContent).toContain(
      "delivered to the conversation as a background result message",
    );
  });

  it("errored 时原样呈现投影给出的错误原文", () => {
    setSnapshot({ run: run({ status: "errored", error: "节点数超过上限 100" }) });
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-error");
    expect(panel.textContent).toContain("Run errored");
    expect(panel.textContent).toContain("节点数超过上限 100");
  });

  it("错误原文按正文排版，不用等宽字体", () => {
    // 投影写进 error 的是 WorkflowErrorJson.message（product-projection.ts 的 run-settled
    // 分支只取 .message，code 被丢掉），而那些 message 是人话短句——"run 已取消"、
    // "typed ask 结束时未提交结果"、"节点数超过上限 100"。DESIGN.md 把 font-mono 留给
    // 路径/命令/代码/标识符/终端数据，一句人话不属于其中任何一类。
    setSnapshot({ run: run({ status: "errored", error: "typed ask 结束时未提交结果" }) });
    const view = renderPane();
    const message = view.getByTestId("workflow-run-error-message");
    expect(message.className).not.toContain("font-mono");
    // 仍保留 pre-wrap：message 万一带换行也不能被折叠掉。
    expect(message.className).toContain("whitespace-pre-wrap");
  });

  it("stopped 且没有错误详情时说明没有，而不是留一片空白", () => {
    setSnapshot({ run: run({ status: "stopped" }) });
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-error");
    expect(panel.textContent).toContain("Run stopped");
    expect(panel.textContent).toContain("No error detail was recorded.");
  });

  it("stopped 带原因：标题与状态头都跟原因词（决策 15）", () => {
    setSnapshot({
      run: run({ status: "stopped", stopReason: "provider", error: "Sign-in expired." } as never),
    });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-stop-reason").textContent).toContain("model error");
    expect(view.getByTestId("workflow-run-status-reason").textContent).toContain("model error");
    expect(view.getByTestId("workflow-run-error").textContent).toContain("Sign-in expired.");
  });

  // 「停止」这个动词说不出后果，所以后果回到状态行：可恢复是投影带来的状态位，不从 status 推。
  it("状态行第三个词：run 带 resumable 时说「resumable」，不带就没有那个词", () => {
    setSnapshot({ run: run({ status: "stopped", stopReason: "user", resumable: true }) });
    const withBit = renderPane();
    expect(withBit.getByTestId("workflow-run-status-resumable").textContent).toContain("resumable");
    expect(withBit.getByTestId("workflow-run-status-reason").textContent).toContain("by you");

    cleanup();
    setSnapshot({ run: run({ status: "stopped", stopReason: "user" }) });
    const without = renderPane();
    expect(without.queryByTestId("workflow-run-status-resumable")).toBeNull();

    cleanup();
    setSnapshot({ run: run({ status: "stopped", stopReason: "user", resumable: true }) });
    const zh = renderPane("zh-CN");
    expect(zh.getByTestId("workflow-run-status-resumable").textContent).toContain("可恢复");
  });

  it("running 时既没有结果面板也没有失败面板", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-result")).toBeNull();
    expect(view.queryByTestId("workflow-run-error")).toBeNull();
  });
});

describe("WorkflowRunSidePane 升级问题", () => {
  const NOW = 1_756_000_000_000;
  const MINUTE = 60_000;
  const questions = [
    {
      qid: "dwfq-dwfrun1-1",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorName: "poet",
      question: "评分上限是 95，但通过门槛是 96，这个门是不是坏了？",
      context: "已经试过 4 轮，最高分 95。",
      askedAt: NOW - 42 * MINUTE,
    },
    {
      qid: "dwfq-dwfrun1-2",
      actorSiteId: "actor#2",
      actorOrdinal: 3,
      question: "用哪版风格指南？",
      askedAt: NOW - 90 * MINUTE,
    },
  ];
  const askers = () =>
    run({
      actors: [
        { siteId: "actor#1", ordinal: 1, name: "poet", sessionId: "s-1", status: "waiting" },
        { siteId: "actor#2", ordinal: 3, sessionId: "s-2", status: "waiting" },
      ],
      nodes: [
        {
          siteId: "ask#1",
          ordinal: 1,
          phase: "executing",
          actorSiteId: "actor#1",
          actorOrdinal: 1,
        },
        { siteId: "ask#2", ordinal: 3, phase: "waiting", actorSiteId: "actor#2", actorOrdinal: 3 },
      ],
      pendingQuestions: questions,
    });

  it("挂在提问者那一行下面：问题紧跟匹配 site@ordinal 的子代理药丸", () => {
    setSnapshot({ run: askers() });
    const view = renderPane();

    const rows = view.getAllByTestId("workflow-run-question");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-qid")).toBe("dwfq-dwfrun1-1");
    const pill = rows[0]!.previousElementSibling as HTMLElement;
    expect(pill.getAttribute("data-testid")).toBe("workflow-agent-pill");
    expect(pill.textContent).toContain("poet");
    expect(rows[0]!.textContent).toContain("这个门是不是坏了？");
    expect(rows[0]!.textContent).toContain("已经试过 4 轮，最高分 95。");
    // qid 是主代理作答要用的 token；用户答不了，但能指着它让主代理去答。
    expect(rows[0]!.textContent).toContain("dwfq-dwfrun1-1");
    // 挂在行下的问题不重复提问者的名字。
    expect(rows[0]!.textContent).not.toContain("poet");
    expect(view.queryByTestId("workflow-run-orphan-questions")).toBeNull();
  });

  it("每条带等待时长（读者的第一个问题恒是「这个已经等了多久」）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({ run: askers() });
      const view = renderPane();
      const waited = view.getAllByTestId("workflow-run-question-waited");
      expect(waited[0]!.textContent).toBe("42m ago");
      expect(waited[1]!.textContent).toBe("1h ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("等待时长自己走时钟：run 在等答案时不发事件，靠投影更新会一直显示「刚刚」", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({ run: askers() });
      const view = renderPane();
      const before = view.getAllByTestId("workflow-run-question-waited")[0]!.textContent;
      act(() => {
        vi.advanceTimersByTime(20 * MINUTE);
      });
      const after = view.getAllByTestId("workflow-run-question-waited")[0]!.textContent;
      expect(after).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("askedAt 缺席（老 journal 重放）时不渲染时长，绝不编一个「刚刚」", () => {
    const { askedAt: _dropped, ...withoutAskedAt } = questions[0]!;
    setSnapshot({ run: { ...askers(), pendingQuestions: [withoutAskedAt] } });
    const view = renderPane();
    expect(view.getAllByTestId("workflow-run-question")).toHaveLength(1);
    expect(view.queryByTestId("workflow-run-question-waited")).toBeNull();
  });

  it("匹配不上提问者的问题挂在清单末尾，并自报名字（站点实例标签 / 匿名兜底）", () => {
    setSnapshot({
      run: run({
        pendingQuestions: [
          { qid: "q-a", actorSiteId: "actor#9", actorOrdinal: 2, question: "谁来审？" },
          { qid: "q-b", question: "没有主语的问题" },
        ],
      }),
    });
    const view = renderPane();
    const block = view.getByTestId("workflow-run-orphan-questions");
    expect(block.textContent).toContain("Waiting on an answer");
    const rows = view.getAllByTestId("workflow-run-question");
    expect(rows[0]!.textContent).toContain("actor#9@2");
    expect(rows[1]!.textContent).toContain("Anonymous Subagent");
  });

  it("v1 只读：清单里没有任何输入控件或应答按钮", () => {
    setSnapshot({ run: askers() });
    const view = renderPane();
    const list = view.getByTestId("workflow-run-phases");
    expect(list.querySelectorAll("input, textarea").length).toBe(0);
    expect(list.textContent).not.toContain("Answer");
  });

  it("零条时没有问题行，也没有末尾的孤儿块（键缺席与空数组两种形态都一样）", () => {
    setSnapshot({ run: run({ pendingQuestions: [] }) });
    let view = renderPane();
    expect(view.queryAllByTestId("workflow-run-question")).toHaveLength(0);
    expect(view.queryByTestId("workflow-run-orphan-questions")).toBeNull();
    cleanup();
    setSnapshot({ run: run() });
    view = renderPane();
    expect(view.queryAllByTestId("workflow-run-question")).toHaveLength(0);
  });

  it("zh-CN 下等待时长与孤儿块标题都本地化，且没有英文兜底漏出来", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({
        run: run({
          pendingQuestions: [
            { qid: "q-b", question: "没有主语的问题", askedAt: NOW - 42 * MINUTE },
          ],
        }),
      });
      const view = renderPane("zh-CN");
      const text = view.getByTestId("workflow-run-orphan-questions").textContent ?? "";
      expect(text).toContain("待答问题");
      expect(text).toContain("42 分钟前");
      expect(text).toContain("未命名子代理");
      expect(text).not.toContain("Waiting on an answer");
      expect(text).not.toContain("ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkflowRunSidePane 淘汰 / 冷启动空态", () => {
  it("run 不在 workflowRuns 里时 tab 仍然打开，措辞只说实时状态没了", () => {
    setSnapshot({});
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-untracked");
    expect(panel.textContent).toContain("No longer tracked live");
    // 关键：不能读成「这次运行不存在了」——journal 里的记录仍然完整，那正是留着这个
    // tab 的理由（产物仍列得出来，见产物区那条用例）。
    expect(panel.textContent).toContain("record is still complete");
  });
});

describe("WorkflowRunSidePane 国际化", () => {
  it("状态头、用量、Stop 与结果在 zh-CN 下全部本地化", () => {
    setSnapshot({
      run: run({
        status: "completed",
        usage: { spentTokens: 1_000, nodesUsed: 3 },
      }),
    });
    const view = renderPane("zh-CN");
    const text = view.container.textContent ?? "";

    expect(view.getByTestId("workflow-run-status").textContent).toBe("已完成");
    expect(text).toContain("停止运行");
    // 摘要行与聊天卡页脚同文案：三条子代理车道 + 步数 + token。
    expect(view.getByTestId("workflow-run-usage").textContent).toContain("3 个子代理");
    expect(view.getByTestId("workflow-run-usage").textContent).toContain("1,000 tokens");
    expect(text).toContain("结果");
    // 没有英文兜底漏出来。
    expect(text).not.toContain("Stop run");
    // 旧动词彻底退场。
    expect(text).not.toContain("取消运行");
  });
});

// ── 阶段清单的子代理行（docs/dynamic-workflow/presentation.md「The spine」）──
// 与卡上同一枚药丸，加「正在做什么」（当前步的 label）、计数、状态标记与打开 transcript 的箭头。
describe("WorkflowRunSidePane 子代理行", () => {
  function actor(overrides: Record<string, unknown> = {}) {
    return {
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "dwf-dwfrun-1-actor_1@1",
      status: "waiting" as const,
      ...overrides,
    };
  }
  const executing = (actorOrdinal = 1) => ({
    siteId: "ask#1",
    ordinal: actorOrdinal,
    phase: "executing" as const,
    actorSiteId: "actor#1",
    actorOrdinal,
  });

  it("行带运行时名、计数与可读的状态标记；不写当前步的 label（站点名对读者没有信息量）", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();

    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.getAttribute("data-agent-status")).toBe("running");
    expect(pill.querySelector('[data-testid="workflow-run-agent-activity"]')).toBeNull();
    expect(pill.textContent).toContain("1 tasks");
    // 状态不只靠颜色或图形：标记带可读文字。
    const mark = pill.querySelector('[data-testid="workflow-pill-status"]');
    expect(mark?.getAttribute("aria-label")).toBe("running");
  });

  /** 行尾的 ↗：一行一枚（活的 run 里每枚子代理药丸都可开），按行里的名字取。 */
  const openOf = (view: ReturnType<typeof renderPane>, name: string) =>
    view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes(name))!
      .querySelector('[data-testid="workflow-run-agent-open"]')!;

  it("点行尾箭头开 transcript tab，并带上 tab 自己的 workspace scope", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();

    fireEvent.click(openOf(view, "planner"));
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
      actorName: "planner",
    });
  });

  it("整行就是按钮：点药丸本身即打开，↗ 只是可打开的可见证据", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-label")).toBe("Open the transcript of planner");
    expect(pill.querySelector('[data-testid="workflow-run-agent-open"]')).toBeTruthy();
    // <button> 在块级父元素里只包住内容；行的容器是纵向 flex，药丸才拉满本节宽度、行行等宽。
    expect(pill.parentElement?.className).toContain("flex-col");
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({ actorSessionId: "dwf-dwfrun-1-actor_1@1", actorName: "planner" }),
    );
  });

  it("会话未落库的实例仍然成行，也可开：请求带槽位、不带会话 id（tab 里是占位，自愈）", () => {
    // docs/dynamic-workflow/presentation.md「The pill」。
    const { sessionId: _absent, ...pending } = actor({ name: "planner" });
    setSnapshot({ run: run({ actors: [pending], nodes: [executing()] }) });
    const view = renderPane();

    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.className).toContain("wf-pill-open");
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "dwfrun-1",
        siteId: "actor#1",
        ordinal: 1,
        actorName: "planner",
      }),
    );
    expect(onOpenWorkflowActorSession.mock.calls[0]![0]).not.toHaveProperty("actorSessionId");
  });

  it("还没出现的子代理（静态车道）在活的 run 里同样可开：期望序号 1", () => {
    // 脚本还没走到它的 agent()：投影里没有这个 actor，药丸交出车道 + 将来的序号。
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();
    const opens = view.getAllByTestId("workflow-run-agent-open");
    const absent = opens.find((open) => open.getAttribute("data-agent-session-id") === "")!;
    fireEvent.click(absent);
    const request = onOpenWorkflowActorSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ runId: "dwfrun-1", ordinal: 1 });
    expect(request.siteId).not.toBe("actor#1");
    expect(request).not.toHaveProperty("actorSessionId");
  });

  it("宿主没有下钻回调时没有任何箭头（回调的存在本身就是门控）", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane("en-US", { withActorCallback: false });
    expect(view.queryByTestId("workflow-run-agent-open")).toBeNull();
  });

  it("同一车道两个实例时拆成两行，各开各的 transcript", () => {
    setSnapshot({
      run: run({
        actors: [
          actor({ ordinal: 1, name: "worker-1", sessionId: "s-1" }),
          actor({ ordinal: 2, name: "worker-2", sessionId: "s-2" }),
        ],
        nodes: [executing(1), executing(2)],
      }),
    });
    const view = renderPane();

    const opens = view.getAllByTestId("workflow-run-agent-open");
    const withSession = opens.filter((open) => open.getAttribute("data-agent-session-id") !== "");
    expect(withSession.map((button) => button.getAttribute("data-agent-session-id"))).toEqual([
      "s-1",
      "s-2",
    ]);
    fireEvent.click(withSession[1]!);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({ actorSessionId: "s-2", ordinal: 2, actorName: "worker-2" }),
    );
  });

  it("脚本行走自己的那条路（docs/dynamic-workflow/transcript-and-notifications.md）：不开 actor transcript，开整个 run 的脚本 transcript，落到这一站", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "world-read#1", ordinal: 1, phase: "executing" }] }),
    });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(pill.querySelector('[data-testid="workflow-run-agent-open"]')).toBeNull();
    expect(pill.textContent).toContain("1 reads");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.className).toContain("wf-pill-open");
    const open = pill.querySelector('[data-testid="workflow-run-workspace-open"]')!;
    // 无标记脚本：隐式站的 id 是 "workflow"，落点就落它。
    expect(open.getAttribute("data-phase-id")).toBe("workflow");
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).not.toHaveBeenCalled();
    expect(onOpenWorkflowWorkspace).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-1",
      workflowName: "Fan-out review",
      phaseId: "workflow",
    });
  });

  it("带阶段的图：脚本行交出所在站的阶段 id；宿主没给回调时它是 span", () => {
    setSnapshot({
      phased: true,
      run: run({ nodes: [{ siteId: "world-read#1", ordinal: 1, phase: "executing" }] }),
    });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(pill.getAttribute("aria-label")).toBe("Open the script's steps at plan");
    fireEvent.click(pill);
    expect(onOpenWorkflowWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ phaseId: "phase#a" }),
    );
    cleanup();

    const bare = renderPane("en-US", { withWorkspaceCallback: false });
    const span = bare
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(span.tagName).toBe("SPAN");
    expect(bare.queryByTestId("workflow-run-workspace-open")).toBeNull();
  });

  it("新实例出现即入列：行是活的，不是打开那一刻的快照", () => {
    const withSession = (view: ReturnType<typeof renderPane>) =>
      view
        .getAllByTestId("workflow-run-agent-open")
        .filter((open) => open.getAttribute("data-agent-session-id") !== "");
    setSnapshot({ run: run({ actors: [actor({ name: "worker-1" })], nodes: [executing()] }) });
    const view = renderPane();
    expect(withSession(view)).toHaveLength(1);

    setSnapshot({
      run: run({
        actors: [
          actor({ name: "worker-1" }),
          actor({ ordinal: 2, name: "worker-2", sessionId: "s-2" }),
        ],
        nodes: [executing(1), executing(2)],
      }),
    });
    rerenderPane(view);
    expect(withSession(view)).toHaveLength(2);
  });

  it("点节头折叠再展开", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();
    const phase = view.getByTestId("workflow-run-phase");
    expect(phase.getAttribute("data-phase-open")).toBe("true");

    fireEvent.click(view.getByTestId("workflow-run-phase-toggle"));
    expect(phase.getAttribute("data-phase-open")).toBe("false");
    expect(view.queryByTestId("workflow-run-agent-open")).toBeNull();

    fireEvent.click(view.getByTestId("workflow-run-phase-toggle"));
    expect(phase.getAttribute("data-phase-open")).toBe("true");
  });

  it("zh-CN 下隐式阶段名、计数与状态标记都本地化", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane("zh-CN");
    const list = view.getByTestId("workflow-run-phases");
    expect(list.textContent).toContain("工作流");
    expect(list.textContent).toContain("1 个任务");
    expect(
      list.querySelector('[data-testid="workflow-pill-status"]')?.getAttribute("aria-label"),
    ).toBe("运行中");
    expect(list.textContent).not.toContain("asks");
  });
});

describe("WorkflowRunSidePane Resume", () => {
  it("stopped 且带 resumable 状态位 → 渲染 Resume，点击发 resumeWorkflowRun {workId ≡ runId, name}", async () => {
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    const button = await view.findByTestId<HTMLButtonElement>("workflow-run-resume");

    fireEvent.click(button);

    const resumeCall = sendCommand.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "resumeWorkflowRun",
    );
    expect(resumeCall).toBeDefined();
    const envelope = resumeCall![0] as unknown as {
      type: string;
      sessionId: string;
      payload: { workId: string; name?: string };
    };
    // name 喂恢复后完成通知的主题（重启后原工具 input 不可得，tab 上的展示名是仅存来源）。
    expect(envelope.payload).toEqual({ workId: "dwfrun-1", name: "Fan-out review" });
    expect(envelope.sessionId).toBe("parent-a");
  });

  it.each(["pending", "running", "completed"] as const)("%s 不渲染 Resume", async (status) => {
    setSnapshot({ run: run({ status }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
  });

  it("stopped(interrupted) 且投影带 resumable 状态位（冷回放折叠了行的谓词）→ 渲染 Resume", async () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "interrupted",
        error: "owning process exited",
        resumable: true,
      } as never),
    });
    const view = renderPane();
    expect(await view.findByTestId("workflow-run-resume")).toBeDefined();
  });

  it("errored（脚本真失败）→ 不渲染", async () => {
    setSnapshot({ run: run({ status: "errored" }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
  });

  it("stopped 但无状态位（旧 CLI）→ 不渲染死按钮；不再另查 journal 摘要", async () => {
    setSnapshot({ run: run({ status: "stopped" }) });
    const view = renderPane();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    expect(workflowRunsQuery).not.toHaveBeenCalled();
  });

  // 灰度（docs/dynamic-workflow/launch.md「Gray release」DWG-07）：Resume 会真的起一台引擎，
  // 是这块面板上唯一被收走的动作；面板其余部分照旧渲染。
  it("灰度关 → resumable 的 run 也不渲染 Resume，但状态头与阶段清单照旧", async () => {
    setDynamicWorkflowEnabled(false);
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    await Promise.resolve();

    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    // 「只收 Resume」：Stop 那枚钮与阶段清单仍在，run 本身没有被藏起来。
    expect(view.queryByTestId("workflow-run-cancel")).not.toBeNull();
    expect(view.queryByTestId("workflow-run-phases")).not.toBeNull();
  });

  it("灰度快照未就绪（loading）→ 先不给 Resume；就绪且命中后再长出来", async () => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "loading",
      enabled: false,
      config: null,
    });
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();

    act(() => {
      setDynamicWorkflowEnabled(true);
    });
    expect(await view.findByTestId("workflow-run-resume")).toBeDefined();
  });
});

// ── 产物区（docs/dynamic-workflow/authoring.md「How the user sees them」）──
// 区自己的形态（默认展开、卡片字段、点击回调）在 workflowRunArtifactsSection.test.ts 里穷举；
// 这里只钉「它在这块面板上的位置与在场条件」——那两件事只有在完整面板里才成立。
//
// ⚠ 术语：产物 = 脚本经 `artifact.*` 交付给用户的产出，与「结果」（顶层返回值）是两件事，
// spec 的不变式要求两者同屏可区分。（`report` 条目那一节已于 2026-09-04 按用户指令撤走。）
describe("WorkflowRunSidePane 产物区", () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({
    id: "book",
    kind: "file",
    title: "审计报告",
    version: 1,
    contentType: "application/pdf",
    bytes: 4096,
    ...overrides,
  });

  it("排在阶段清单之后，是面板的最后一节（Results / 事件日志 / Script 三节已撤走）", async () => {
    setSnapshot({
      run: run({
        artifacts: [summary()],
        pendingQuestions: [
          { qid: "q-1", siteId: "ask#1", ordinal: 1, question: "哪个 registry？" },
        ],
      } as never),
    });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());

    const artifacts = view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION);
    const phases = view.getByTestId("workflow-run-phases");
    // Node.DOCUMENT_POSITION_FOLLOWING === 4：a 在 b 之前。升级问题挂在清单里的提问者下面
    // （不再是独立一节），所以产物区紧跟阶段清单。
    expect(phases.compareDocumentPosition(artifacts) & 4).toBeTruthy();
    // 面板到此为止：产物区之后没有兄弟节点。
    expect(artifacts.nextElementSibling).toBeNull();
  });

  it("零件时整区缺席（不给不发布产物的 run 留一节空壳）", async () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    await act(async () => {});
    expect(view.queryByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeNull();
  });

  it.each(["errored", "stopped"] as const)("%s 的 run 一样渲染产物区", async (status) => {
    // 一个死在第 12 步的 run 仍然可能已经发布了一份 pdf；只报一句「失败」等于把它扔了。
    setSnapshot({ run: run({ status, artifacts: [summary()] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy();
  });

  it("点卡片 → 打开产物 tab 的请求带上这块面板的 workspace scope 与产物 id，且不带版本号", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
      // 宿主据 contentType 分流（html 直接开浏览器 tab），所以这块面板手上的那份合并视图
      // 带得到就交出去。
      contentType: "application/pdf",
    });
  });

  it("合并视图里有 sourcePath 时一并交出去——宿主不必再为「在工作区显示」查一次 journal", async () => {
    // 出处只在 journal 里（活投影那份摘要刻意不带它），所以这里让 journal 答上同一个 id。
    workflowRunArtifactsQuery.mockImplementation(async () => ({
      artifacts: [
        {
          id: "book",
          kind: "file",
          title: "审计报告",
          version: 1,
          contentType: "text/html",
          sourcePath: "reports/audit.html",
          versions: [{ version: 1, publishedAt: 1, bytes: 4096 }],
          itemCount: 0,
        },
      ],
    }));
    setSnapshot({ run: run({ artifacts: [summary({ contentType: "text/html" })] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
      contentType: "text/html",
      sourcePath: "reports/audit.html",
    });
  });

  it("宿主没注入打开能力时卡片不可点（回调的存在本身就是门控）", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane("en-US", { withArtifactCallback: false });
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).not.toHaveBeenCalled();
  });

  it("run 已被活投影淘汰时，产物仍从 journal 列得出来", async () => {
    workflowRunArtifactsQuery.mockImplementation(async () => ({
      artifacts: [
        {
          id: "notes",
          kind: "markdown",
          title: "综述",
          version: 1,
          versions: [{ version: 1, publishedAt: 1, bytes: 12 }],
          itemCount: 0,
        },
      ],
    }));
    setSnapshot({});
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByText("综述")).toBeTruthy();
  });

  it("zh-CN 下区名念「产物」——与顶部「结果」措辞不重叠", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane("zh-CN");
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION).textContent).toContain("产物");
  });
});

// ── 阶段名册（docs/dynamic-workflow/presentation.md「Past six participants」）──
// 过了六个参与者的站：钉 5 枚（asking → running → failed → 补位）、问题挂在钉住的提问者下面、
// 其余每人一格、「列出全部」展开两列密排（展开时格子收起，追记「五枚药丸与一扇门」）；折叠节头上
// 头像串换成迷你量条。
describe("WorkflowRunSidePane 阶段名册", () => {
  type FanStatus = "done" | "running" | "failed" | "pending";
  function fanoutSnapshot(
    n: number,
    statusOf: (index: number) => FanStatus,
    pendingQuestions: WorkflowRunState["pendingQuestions"] = [],
    unlistedByPhase?: WorkflowRunState["unlistedByPhase"],
  ) {
    // 一条车道跑出 N 个实例：静态图是一张 `many` 卡，run 一来按实例拆成 N 枚药丸。
    const steps: GraphStep[] = [
      { id: "ask#1", kind: "ask", label: "review", lane: "actor#1", phase: "phase#a" },
    ];
    const lanes = [{ id: "actor#1" }];
    const actors: WorkflowRunState["actors"] = [];
    const nodes: WorkflowRunState["nodes"] = [];
    for (let i = 1; i <= n; i += 1) {
      const status = statusOf(i);
      actors.push({
        siteId: "actor#1",
        ordinal: i,
        name: `reviewer-${i}`,
        sessionId: `dwf-dwfrun-1-actor_1@${i}`,
        status: status === "running" ? "running" : status === "pending" ? "waiting" : "completed",
      });
      if (status === "pending") continue;
      nodes.push({
        siteId: "ask#1",
        ordinal: i,
        actorSiteId: "actor#1",
        actorOrdinal: i,
        ...(status === "running"
          ? { phase: "executing" }
          : { phase: "settled", outcome: status === "failed" ? "failed" : "ok" }),
      } as WorkflowRunState["nodes"][number]);
    }
    snapshot = {
      rows: {
        window: [
          {
            ...graphRow,
            display: {
              ...graphRow.display,
              causalityGraph: {
                steps,
                lanes,
                participants: participantsOf(steps).map((participant) => ({
                  ...participant,
                  many: true,
                })),
                handoffs: [],
                phases: [{ id: "phase#a", name: "review", line: 1 }],
                phaseEdges: [],
              },
            },
          },
        ],
      },
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            actors,
            nodes,
            pendingQuestions,
            ...(unlistedByPhase === undefined ? {} : { truncated: true, unlistedByPhase }),
          }),
        ],
      },
    };
  }
  const mid = (i: number): FanStatus =>
    i === 4 ? "failed" : i === 2 || i === 6 || i === 8 ? "running" : "done";
  const question = {
    qid: "q-6",
    actorSiteId: "actor#1",
    actorOrdinal: 6,
    question: "Treat the failing assertion as a bug or as drift?",
  };

  it("钉 5 枚：asking → running → failed → 补位；问题挂在钉住的提问者下面；第六枚是门，门关着", () => {
    fanoutSnapshot(9, mid, [question]);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    expect(section.getAttribute("data-phase-open")).toBe("true");
    const pins = within(section).getByTestId("workflow-roster-pins");
    const pills = within(pins).getAllByTestId("workflow-agent-pill");
    // asking 的 6 领头，再是 running 的 2、8，然后 failed 的 4，最后补位的 1。
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "reviewer-61 tasks",
      "reviewer-21 tasks",
      "reviewer-81 tasks",
      "reviewer-41 tasks",
      "reviewer-11 tasks",
    ]);
    // 问题紧跟 reviewer-6 那一行（同一个纵向 flex 容器里）。
    const row = within(pins).getByTestId("workflow-run-question");
    expect(row.getAttribute("data-qid")).toBe("q-6");
    expect(row.parentElement).toBe(pills[0]!.parentElement);
    // 门：其余四个（3 5 7 9，全 done）——两张脸、「4 more」、计数只数其余、下箭头。
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.tagName).toBe("BUTTON");
    expect(door.getAttribute("data-door")).toBe("closed");
    expect(door.getAttribute("data-more-count")).toBe("4");
    expect(door.getAttribute("title")).toBe("4 more subagents · list them here");
    const tally = within(door).getByTestId("workflow-roster-tally");
    expect(
      [...tally.querySelectorAll("[data-roster-count]")].map(
        (item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`,
      ),
    ).toEqual(["done:4"]);
    expect(within(door).getByTestId("workflow-more-chevron")).toBeTruthy();
    expect(within(door).queryByTestId("workflow-more-open")).toBeNull();
    // 门关着：没有名单；正文里也没有格子、量条、头像串。
    expect(within(section).queryByTestId("workflow-roster-roll")).toBeNull();
    expect(within(section).queryByTestId("workflow-agent-cell")).toBeNull();
    expect(within(section).queryByTestId("workflow-roster-meter")).toBeNull();
    expect(within(section).queryByTestId("workflow-roster-meter-mini")).toBeNull();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
  });

  it("门后是名单：只有其余的人、按状态分组、组头是计数；再点门收起；名单里的行开 transcript 带 workspace scope", () => {
    // 60 人：1、7 running，6 failed，其余 done。
    fanoutSnapshot(60, (i) => (i === 1 || i === 7 ? "running" : i === 6 ? "failed" : "done"));
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    const door = within(section).getByTestId("workflow-roster-more-row");
    // running 先钉：钉位 = 1、7、6、2、3；其余 55 = 4 5 8…60。
    expect(door.getAttribute("data-more-count")).toBe("55");
    expect(door.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(door);
    expect(door.getAttribute("aria-expanded")).toBe("true");
    expect(door.getAttribute("data-door")).toBe("open");
    expect(within(door).queryByTestId("workflow-roster-tally")).toBeNull();
    const roll = within(section).getByTestId("workflow-roster-roll");
    const headings = within(roll).getAllByTestId("workflow-roll-heading");
    expect(headings.map((heading) => heading.textContent)).toEqual(["55done"]);
    const rows = within(roll).getAllByTestId("workflow-agent-pill");
    expect(rows).toHaveLength(55);
    expect(rows.every((entry) => entry.getAttribute("data-pill-size") === "row")).toBe(true);
    // 钉住的五个不在名单里。
    const names = rows.map((entry) => entry.getAttribute("title"));
    for (const pinned of ["reviewer-6", "reviewer-1", "reviewer-7", "reviewer-2", "reviewer-3"]) {
      expect(names).not.toContain(pinned);
    }
    expect(names.slice(0, 3)).toEqual(["reviewer-4", "reviewer-5", "reviewer-8"]);
    // 名单里的行是按钮，开 transcript 带 tab 自己的 workspace scope。
    const target = rows.find((entry) => entry.getAttribute("title") === "reviewer-5")!;
    expect(target.tagName).toBe("BUTTON");
    fireEvent.click(target);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@5",
      siteId: "actor#1",
      ordinal: 5,
      actorName: "reviewer-5",
    });
    // 再点门：名单收起，计数行回来。
    fireEvent.click(door);
    expect(within(section).queryByTestId("workflow-roster-roll")).toBeNull();
    expect(within(door).getByTestId("workflow-roster-tally")).toBeTruthy();
  });

  it("名单按注意力序分组：running、pending 在 done 前面；第六个提问者落在名单里带 ?", () => {
    // 九人：1 2 3 4 5 6 都在提问（钉五个，第六个落进名单）；7 running、8 pending、9 done。
    const asks = [1, 2, 3, 4, 5, 6].map((i) => ({
      qid: `q-${i}`,
      actorSiteId: "actor#1",
      actorOrdinal: i,
      question: `q ${i}`,
    }));
    fanoutSnapshot(9, (i) => (i === 7 ? "running" : i === 8 ? "pending" : "done"), asks);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    fireEvent.click(within(section).getByTestId("workflow-roster-more-row"));
    const roll = within(section).getByTestId("workflow-roster-roll");
    expect(
      within(roll)
        .getAllByTestId("workflow-roll-heading")
        .map((heading) => heading.getAttribute("data-roll-group")),
    ).toEqual(["running", "pending", "done"]);
    const rows = within(roll).getAllByTestId("workflow-agent-pill");
    expect(rows.map((entry) => entry.getAttribute("title"))).toEqual([
      "reviewer-7",
      "reviewer-8",
      "reviewer-6",
      "reviewer-9",
    ]);
    // 第六个提问者 reviewer-6：行上一枚 ?；问题本身不在名单里重复（孤儿块也不收它——它有提问者）。
    expect(within(rows[2]!).getByTestId("workflow-roll-asking")).toBeTruthy();
    expect(within(roll).queryByTestId("workflow-run-question")).toBeNull();
  });

  it("折起的名册站在节头带迷你量条而不是头像串", () => {
    fanoutSnapshot(9, mid);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(section.getAttribute("data-phase-open")).toBe("false");
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    // 六个及以下仍是头像串。
    fanoutSnapshot(6, mid);
    const few = rerenderPane(view);
    const small = few.getByTestId("workflow-run-phase");
    fireEvent.click(within(small).getByTestId("workflow-run-phase-toggle"));
    expect(within(small).queryByTestId("workflow-roster-meter-mini")).toBeNull();
  });

  // 表外的那些（docs/dynamic-workflow/presentation.md「Past six participants」「The spine」）：
  // 被归约淘汰的子代理没有药丸也没有行，但门、计数行、量条与 settled/observed 都得算上它们。
  it("被淘汰的子代理进门的人数、计数行、迷你量条与 settled/observed，名单末尾一行淡字交代差额", () => {
    fanoutSnapshot(
      8,
      (i) => (i === 1 ? "running" : "done"),
      [],
      [{ phaseName: "review", actors: 300, actorsSettled: 300, actorsFailed: 2, settled: 300 }],
    );
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    // 门：表内其余三个 + 表外三百个。
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.getAttribute("data-more-count")).toBe("303");
    expect(door.getAttribute("title")).toBe("303 more subagents · list them here");
    expect(
      [
        ...within(door)
          .getByTestId("workflow-roster-tally")
          .querySelectorAll("[data-roster-count]"),
      ].map((item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`),
    ).toEqual(["done:301", "failed:2"]);
    // 步数：表内 8 个里结算了 7 个，表外 300 个分子分母一起抬。
    expect(within(section).getByTestId("workflow-run-phase-fraction").textContent).toBe("307/308");
    // 名单只列得出表内的三个，末尾一行说清剩下的三百个。
    fireEvent.click(door);
    const roll = within(section).getByTestId("workflow-roster-roll");
    expect(within(roll).getAllByTestId("workflow-agent-pill")).toHaveLength(3);
    expect(
      within(roll)
        .getAllByTestId("workflow-roll-heading")
        .map((h) => h.textContent),
    ).toEqual(["3done"]);
    expect(within(roll).getByTestId("workflow-roll-unlisted").textContent).toBe(
      "300 more agents not listed",
    );
    // 折起：节头是迷你量条（名册的判定同样算上表外的）。
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
  });

  it("四枚药丸加三百个还没跑的被拒子代理也是名册：门在，量条在，头像串不在，计数行全是 pending", () => {
    fanoutSnapshot(4, () => "running", [], [{ phaseName: "review", actors: 300, settled: 0 }]);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    expect(within(section).getAllByTestId("workflow-agent-pill")).toHaveLength(4);
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.getAttribute("data-more-count")).toBe("300");
    // `actorsSettled` 缺席：三百个一个都没跑完，计数行不能把它们说成 done。
    expect(
      [
        ...within(door)
          .getByTestId("workflow-roster-tally")
          .querySelectorAll("[data-roster-count]"),
      ].map((item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`),
    ).toEqual(["pending:300"]);
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
  });

  it("zh-CN：门的两种文案与组头", () => {
    fanoutSnapshot(9, mid);
    const view = renderPane("zh-CN");
    const door = view.getByTestId("workflow-roster-more-row");
    expect(door.textContent).toContain("还有 4 个");
    expect(door.getAttribute("title")).toBe("还有 4 个子代理 · 在这里列出");
    fireEvent.click(door);
    expect(door.getAttribute("title")).toBe("还有 4 个子代理 · 收起");
    expect(view.getByTestId("workflow-roll-heading").textContent).toBe("4个已完成");
  });

  // ── 落点（追记「五枚药丸与一扇门」）：卡上「还有 n 个」那一行 / 站头把站 id 交给宿主，tab 带着
  // focusPhaseId 到这里——展开、开门、节头滚到顶、亮一下；同一站换 openedAt 再落一次。
  const landedTree = (overrides: Partial<WorkflowRunSidePaneTab>) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowRunSidePane, { tab: { ...tab, ...overrides }, onOpenWorkflowActorSession }),
    );

  it("tab 带 focusPhaseId：那一站展开、门开着、节头滚到顶并亮一下；换 openedAt 再落；不带就不落", () => {
    const scrollIntoView = vi.fn();
    // jsdom 没有 scrollIntoView。
    Element.prototype.scrollIntoView = scrollIntoView;
    // 没有在跑的站：默认全部折起，展开只能来自落点。
    fanoutSnapshot(9, () => "done");
    const view = render(landedTree({ focusPhaseId: "phase#a", openedAt: 1 }));
    const section = view.getByTestId("workflow-run-phase");
    expect(section.getAttribute("data-phase-open")).toBe("true");
    expect(section.getAttribute("data-phase-landed")).toBe("true");
    const head = within(section).getByTestId("workflow-run-phase-toggle");
    expect(head.className).toContain("wf-landed");
    expect(
      within(section).getByTestId("workflow-roster-more-row").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(section).getByTestId("workflow-roster-roll")).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    expect(scrollIntoView.mock.instances[0]).toBe(head);
    // 同一站再点一次（openedAt 刷新）：再落。
    view.rerender(landedTree({ focusPhaseId: "phase#a", openedAt: 2 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    // 不带落点重开（表头的 ⤢）：不滚、不收。
    view.rerender(landedTree({ openedAt: 3 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(view.getByTestId("workflow-run-phase").getAttribute("data-phase-open")).toBe("true");
  });

  it("亮一下是一次性的：1.2 s 后落点标记退场，展开与名单留着", () => {
    vi.useFakeTimers();
    try {
      fanoutSnapshot(9, () => "done");
      const view = render(landedTree({ focusPhaseId: "phase#a", openedAt: 1 }));
      expect(view.getByTestId("workflow-run-phase").getAttribute("data-phase-landed")).toBe("true");
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      const section = view.getByTestId("workflow-run-phase");
      expect(section.getAttribute("data-phase-landed")).toBeNull();
      expect(section.getAttribute("data-phase-open")).toBe("true");
      expect(within(section).getByTestId("workflow-roster-roll")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 状态头下的 lineage 行（docs/dynamic-workflow/presentation.md「The run pane」）──
describe("WorkflowRunSidePane lineage", () => {
  it.each([
    ["en-US", "Amends run"],
    ["zh-CN", "调整自 run"],
  ] as const)("修订出来的 run：状态头下一行「调整自 run X」：%s", (locale, label) => {
    setSnapshot({ run: run({ resumedFrom: "dwfrun-prev" }) });
    const view = renderPane(locale);
    const line = view.getByTestId("workflow-run-amends");
    expect(line.textContent).toContain(label);
    expect(line.textContent).toContain("dwfrun-prev");
    expect(view.queryByTestId("workflow-run-superseded-by")).toBeNull();
  });

  it("被替代的 run：状态词带原因，链接开后继的详情、带后继自己的发起行 id", () => {
    const successor = run({
      runId: "dwfrun-next",
      toolCallId: "tool-wf-2",
      resumedFrom: "dwfrun-1",
    });
    const predecessor = run({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-next",
    } as never);
    snapshot = {
      rows: { window: [graphRow] },
      workflowRuns: { revision: 1, runs: [predecessor, successor] },
    };
    const view = renderPane("en-US", { withOpenRunCallback: true });
    expect(view.getByTestId("workflow-run-status").textContent).toBe("Stopped");
    expect(view.getByTestId("workflow-run-status-reason").textContent).toContain("superseded");
    // 被替代的 run 没有 resumable 位：没有 Resume。
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    const link = view.getByTestId("workflow-run-superseded-by");
    expect(link.tagName).toBe("BUTTON");
    expect(link.textContent).toContain("Superseded by run");
    expect(link.textContent).toContain("dwfrun-next");
    fireEvent.click(link);
    expect(onOpenWorkflowRun).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-a",
        runId: "dwfrun-next",
        toolCallId: "tool-wf-2",
        workspacePath: "/workspace",
      }),
    );
  });

  it("后继不在投影里（或宿主没给回调）时那一行是静态文字", () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "superseded",
        supersededBy: "dwfrun-gone",
      } as never),
    });
    const view = renderPane("zh-CN", { withOpenRunCallback: true });
    const line = view.getByTestId("workflow-run-superseded-by");
    expect(line.tagName).toBe("DIV");
    expect(line.textContent).toContain("已被替代，后继 run");
    expect(line.textContent).toContain("dwfrun-gone");
  });

  it("普通 run 没有 lineage 行", () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-amends")).toBeNull();
    expect(view.queryByTestId("workflow-run-superseded-by")).toBeNull();
  });
});

// ── 「配置」（docs/dynamic-workflow/presentation.md「The run pane」「The settings popover」）──
// 状态头两行：名字 + Configure / Resume / Stop，其下是灯与状态词 + 并发芯片。Configure 与 Resume 同一道
// 灰度门；能配置的 run 上，摘要行的模型段也是一个入口。Apply 被接受后面板原地换成新 run 的 tab。
describe("WorkflowRunSidePane 配置", () => {
  beforeEach(() => {
    setDynamicWorkflowEnabled(true);
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    onOpenWorkflowRun.mockClear();
  });

  it("状态头两行：第一行名字与 Configure → Resume → Stop，第二行灯与状态词和并发芯片", () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "user",
        resumable: true,
        concurrencyCeiling: 13,
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    });
    const view = renderPane();
    const configure = view.getByTestId("workflow-run-configure");
    const resume = view.getByTestId("workflow-run-resume");
    const cancel = view.getByTestId("workflow-run-cancel");
    expect(configure.textContent).toBe("Configure");
    expect(
      configure.compareDocumentPosition(resume) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(resume.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const statusRow = view.getByTestId("workflow-run-status-row");
    expect(statusRow.contains(view.getByTestId("workflow-run-status"))).toBe(true);
    expect(statusRow.contains(view.getByTestId("workflow-run-concurrency"))).toBe(true);
    expect(view.getByTestId("workflow-run-concurrency").textContent).toBe("Max concurrency 4");
    expect(statusRow.contains(configure)).toBe(false);
  });

  // 芯片与 Configure 同进同退（docs/dynamic-workflow/concurrency.md「What the user sees」）：
  // 完成或被替代的 run 上，界已经没有东西在它下面跑、也没有控件能改它，留下的数只会被读成实时读数。
  it.each([
    ["completed", run({ status: "completed" })],
    ["superseded", run({ status: "stopped", stopReason: "superseded", supersededBy: "run-next" })],
  ])("%s 的 run 不画并发芯片，即便界仍在天花板之下", (_case, state) => {
    setSnapshot({
      run: { ...state, concurrencyCeiling: 13, concurrency: { cap: 13, ceiling: 13, limit: 4 } },
    });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-concurrency")).toBeNull();
    expect(view.queryByTestId("workflow-run-configure")).toBeNull();
  });

  it.each([
    ["completed", run({ status: "completed" })],
    ["superseded", run({ status: "stopped", stopReason: "superseded", supersededBy: "run-next" })],
  ])("%s 的 run 没有 Configure，模型段只是字", (_case, state) => {
    setSnapshot({ run: { ...state, subagentModel: "zhipu/glm-5.3" } });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-configure")).toBeNull();
    expect(view.getByTestId("workflow-run-subagent-model").tagName).toBe("SPAN");
  });

  it("灰度关：没有 Configure", () => {
    setDynamicWorkflowEnabled(false);
    setSnapshot({ run: run() });
    expect(renderPane().queryByTestId("workflow-run-configure")).toBeNull();
  });

  it("zh-CN 念「配置」；能配置时模型段是按钮，点它与点 Configure 开的是同一个弹层", () => {
    setSnapshot({ run: run({ subagentModel: "zhipu/glm-5.3" }) });
    const view = renderPane("zh-CN");
    expect(view.getByTestId("workflow-run-configure").textContent).toBe("配置");
    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.tagName).toBe("BUTTON");
    fireEvent.click(segment);
    expect(segment.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="workflow-run-settings-popover"]')).not.toBeNull();
  });

  it("Apply 发 amendWorkflowRunSettings {workId ≡ runId, 改过的设置}；新 run 进投影后 tab 原地换成它", async () => {
    sendCommand.mockImplementationOnce(
      async () =>
        ({
          status: "accepted",
          result: {
            type: "amendWorkflowRunSettings",
            runId: "dwfrun-2",
            toolCallId: "settings-1",
            supersededRunId: "dwfrun-1",
          },
        }) as never,
    );
    const current = run({
      concurrencyCeiling: 13,
      concurrency: { cap: 13, ceiling: 13, limit: 4 },
    });
    setSnapshot({ run: current });
    const view = renderPane("en-US", { withOpenRunCallback: true });
    fireEvent.click(view.getByTestId("workflow-run-configure"));
    fireEvent.click(
      document.querySelector('[data-testid="workflow-run-settings-bound-decrease"]')!,
    );
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="workflow-run-settings-apply"]')!);
    });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "amendWorkflowRunSettings",
        payload: { workId: "dwfrun-1", maxConcurrency: 3 },
        sessionId: "parent-a",
      }),
    );
    // 被接受的那一刻新 run 还没进投影：先不动。
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
    snapshot = {
      ...(snapshot as object),
      workflowRuns: {
        revision: 2,
        runs: [
          { ...current, status: "stopped", stopReason: "superseded", supersededBy: "dwfrun-2" },
          run({ runId: "dwfrun-2", toolCallId: "settings-1", resumedFrom: "dwfrun-1" }),
        ],
      },
    };
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunSidePane, { tab: { ...tab }, onOpenWorkflowRun }),
      ),
    );
    await waitFor(() => expect(onOpenWorkflowRun).toHaveBeenCalledTimes(1));
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "settings-1",
      runId: "dwfrun-2",
      workflowName: "Fan-out review",
      replaceRunId: "dwfrun-1",
    });
  });

  // 只改并发上限、run 又在飞：就地生效，结果里的 runId 就是这个 run 自己、没有 supersededRunId
  // （docs/dynamic-workflow/concurrency.md）。没有后继可跟——这个 tab 已经是它了。
  it("就地生效的结果（runId 是自己、无 supersededRunId）：不请求换 tab", async () => {
    sendCommand.mockImplementationOnce(
      async () =>
        ({
          status: "accepted",
          result: {
            type: "amendWorkflowRunSettings",
            runId: "dwfrun-1",
            toolCallId: "settings-1",
          },
        }) as never,
    );
    const current = run({
      concurrencyCeiling: 13,
      concurrency: { cap: 13, ceiling: 13, limit: 4 },
    });
    setSnapshot({ run: current });
    const view = renderPane("en-US", { withOpenRunCallback: true });
    fireEvent.click(view.getByTestId("workflow-run-configure"));
    // 就地生效的后果句：不再念「将停止当前运行」。
    fireEvent.click(
      document.querySelector('[data-testid="workflow-run-settings-bound-decrease"]')!,
    );
    expect(
      document.querySelector('[data-testid="workflow-run-settings-consequence"]')?.textContent,
    ).toBe("Applies to this run right away; no new run is started.");
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="workflow-run-settings-apply"]')!);
    });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { workId: "dwfrun-1", maxConcurrency: 3 } }),
    );
    // 这个 run 一直在投影里：跟随逻辑若不认得「后继就是自己」，这里会立刻请求把 tab 换掉。
    await act(async () => {});
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
  });

  it("「配置」出来的 run 在设置轮落地之前借前驱的图；设置轮落地后来龙去脉说「由你调整设置」", () => {
    const settingsTab = { ...tab, toolCallId: "settings-1", runId: "dwfrun-2" };
    const predecessor = run({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-2",
    });
    const successor = run({ runId: "dwfrun-2", toolCallId: "settings-1", resumedFrom: "dwfrun-1" });
    snapshot = {
      rows: { window: [graphRow] },
      workflowRuns: { revision: 1, runs: [predecessor, successor] },
    };
    const borrowed = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkflowRunSidePane, { tab: settingsTab }),
      ),
    );
    expect(borrowed.getByTestId("workflow-run-phases")).toBeTruthy();
    expect(borrowed.queryByTestId("workflow-run-provenance")).toBeNull();
    cleanup();

    const workflowLaunch = {
      runId: "dwfrun-2",
      toolCallId: "settings-1",
      name: "Fan-out review",
      display: graphRow.display,
      amend: {
        predecessorRunId: "dwfrun-1",
        subagentModel: { to: "zhipu/glm-5.3-flash" },
        maxConcurrency: { from: 13, to: 4 },
        ceiling: 13,
      },
    };
    snapshot = {
      rows: {
        window: [
          graphRow,
          {
            kind: "turnHeader" as const,
            rowId: "row-header",
            origin: "workflowLaunch" as const,
            executionKind: "controlOnly" as const,
            state: "completedSuccess" as const,
            startedAt: Date.UTC(2026, 8, 18, 4, 51),
            workflowLaunch,
          },
        ],
      },
      workflowRuns: { revision: 2, runs: [predecessor, successor] },
    };
    const landed = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkflowRunSidePane, { tab: settingsTab }),
      ),
    );
    const provenance = landed.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-kind")).toBe("settings");
    expect(provenance.textContent).toContain("由你调整设置");
    expect(landed.queryByTestId("workflow-run-provenance-scope")).toBeNull();
    const rows = landed.getByTestId("workflow-run-provenance-settings").textContent ?? "";
    expect(rows).toContain("子代理模型");
    expect(rows).toContain("会话模型 → glm-5.3-flash");
    expect(rows).toContain("最大并发数");
    expect(rows).toContain("默认 13 → 4");
  });

  // 就地生效的设置轮（docs/dynamic-workflow/concurrency.md）：`amend` 不带 predecessorRunId。
  // 来龙去脉块按 toolCallId 认轮次，所以只有当用户开的正是那一轮的 tab 时才会读到它——
  // 这一块从不读 predecessorRunId，缺了它照常把改了什么念出来，不炸。
  it("就地生效的设置轮落在来龙去脉块上：没有前驱也照常念「由你调整设置」与上限那一行", () => {
    const retuned = run({ runId: "dwfrun-1", toolCallId: "tool-1" });
    const retuneTab = { ...tab, toolCallId: "settings-9", runId: "dwfrun-1" };
    snapshot = {
      rows: {
        window: [
          graphRow,
          {
            kind: "turnHeader" as const,
            rowId: "row-retune",
            origin: "workflowLaunch" as const,
            executionKind: "controlOnly" as const,
            state: "completedSuccess" as const,
            startedAt: Date.UTC(2026, 8, 18, 4, 51),
            workflowLaunch: {
              runId: "dwfrun-1",
              toolCallId: "settings-9",
              name: "Fan-out review",
              amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 },
            },
          },
        ],
      },
      workflowRuns: { revision: 1, runs: [retuned] },
    };
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkflowRunSidePane, { tab: retuneTab }),
      ),
    );
    const provenance = view.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-kind")).toBe("settings");
    expect(provenance.textContent).toContain("由你调整设置");
    const rows = view.getByTestId("workflow-run-provenance-settings").textContent ?? "";
    expect(rows).toContain("最大并发数");
    expect(rows).toContain("默认 13 → 4");
    expect(rows).not.toContain("子代理模型");
  });
});
