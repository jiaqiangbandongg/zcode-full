// @vitest-environment jsdom

// 轮尾摘要（docs/dynamic-workflow/presentation.md「The run card」）：两态、默认收起——收起是表头 +
// 阶段线，展开是药丸落到站下；冷态只剩一行。交互（chevron、⤢、Resume、芯片、药丸）走真实 DOM。
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, Profiler, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 提示只渲染 children（不改 DOM 形状），但把 title / description 记下来：Stop 钮的第二行
// 「停止后可以随时恢复」只活在提示里，是这次改名要钉住的那半句话。
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

// 接线层的卡只读 workspace 作用域算子代理模型的 provider 名；这里不验证那行字，给一个空实现
// 免去为它搭一整份 session store。
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));

// eslint-disable-next-line import/first -- 必须在 tooltip mock 之后再引入被测组件。
import {
  WorkflowRunDigest,
  type WorkflowRunDigestProps,
} from "@/components/workflow-timeline/WorkflowRunDigest.js";
// eslint-disable-next-line import/first -- 同上。
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
// eslint-disable-next-line import/first -- 同上。
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
// eslint-disable-next-line import/first -- 同上；词条只用于双语言存在性断言。
import enUS from "../src/i18n/locales/en-US.js";
// eslint-disable-next-line import/first -- 同上。
import zhCN from "../src/i18n/locales/zh-CN.js";

afterEach(() => {
  cleanup();
  tooltips.calls.length = 0;
});

// plan → verify，verify 回到 plan（与工具卡测试同一夹具）。
const LOOP_GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask",
      label: "plan",
      line: 2,
      column: 21,
      lane: "actor#1",
      phase: "phase#a",
    },
    {
      id: "ask#2",
      kind: "ask",
      label: "verify",
      line: 5,
      column: 21,
      lane: "actor#2",
      phase: "phase#b",
    },
  ],
  lanes: [
    { id: "actor#1", name: "planner", line: 1, column: 11 },
    { id: "actor#2", name: "checker", line: 4, column: 11 },
  ],
  participants: [
    { id: "phase#a:actor#1", phase: "phase#a", lane: "actor#1", steps: ["ask#1"] },
    { id: "phase#b:actor#2", phase: "phase#b", lane: "actor#2", steps: ["ask#2"] },
  ],
  handoffs: [],
  phases: [
    { id: "phase#a", name: "plan", line: 1 },
    { id: "phase#b", name: "verify", line: 4 },
  ],
  phaseEdges: [
    { from: "phase#a", to: "phase#b" },
    { from: "phase#b", to: "phase#a", back: true },
  ],
  exits: ["phase#b"],
} as const;

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-42",
    toolCallId: "tool-create-workflow",
    status: "running",
    usage: { spentTokens: 1_234, nodesUsed: 2 },
    actors: [
      { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
      { siteId: "actor#2", ordinal: 1, name: "Bob", sessionId: "s-2", status: "running" },
    ],
    nodes: [
      {
        siteId: "ask#1",
        ordinal: 1,
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
      { siteId: "ask#2", ordinal: 1, phase: "executing", actorSiteId: "actor#2", actorOrdinal: 1 },
    ] as WorkflowRunState["nodes"],
    lastEventSequence: 7,
    ...overrides,
  };
}

function joined(
  overrides: Partial<WorkflowRunState> = {},
  extra: Partial<WorkflowRunCardSummary> = {},
): WorkflowRunCardSummary {
  const run = runState(overrides);
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    nodesSettled: run.nodes.filter((node) => node.phase === "settled").length,
    nodesTotal: run.nodes.length,
    run,
    ...extra,
  };
}

function renderDigest(
  props: Partial<WorkflowRunDigestProps> & { summary: WorkflowRunCardSummary | undefined },
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunDigest, {
        graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
        name: "implement-verify",
        runId: props.summary?.runId ?? "dwfrun-42",
        testIdKey: "t",
        ...props,
      }),
    ),
  );
}

// run 不在活投影里（八条上限淘汰 / 冷恢复无 journal 命中）的中性卡（docs/dynamic-workflow/presentation.md
// 「The run card」）：凡点名了 runId 的来源都出卡，联接不到就退成单行——种类词说「已结束」而不冒充终态。
describe("WorkflowRunDigest 中性卡（summary 缺席）", () => {
  it("单行：种类词「Workflow ended」，无灯无轨道无 Cancel / Resume，⤢ 仍在；status 属性为 absent", () => {
    const onOpenRun = vi.fn();
    const view = renderDigest({
      summary: undefined,
      onOpenRun,
      onResume: vi.fn(),
      onCancel: vi.fn(),
    });
    const root = view.container.querySelector("[data-workflow-run-digest]")!;
    expect(root.getAttribute("data-workflow-run-id")).toBe("dwfrun-42");
    expect(root.getAttribute("data-workflow-run-status")).toBe("absent");
    expect(root.getAttribute("role")).toBeNull();
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow ended");
    expect(view.getByTestId("workflow-card-name").textContent).toBe("implement-verify");
    expect(view.queryByTestId("workflow-digest-plot")).toBeNull();
    expect(view.queryByTestId("workflow-card-detail")).toBeNull();
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
  });

  it("双语言词条在场", () => {
    expect(enUS["chat.toolCall.workflow.card.ended"]).toBe("Workflow ended");
    expect(zhCN["chat.toolCall.workflow.card.ended"]).toBe("工作流已结束");
    const view = renderDigest({ summary: undefined }, "zh-CN");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("工作流已结束");
  });
});

// ── 名册站上「还有 n 个」那一行（docs/dynamic-workflow/presentation.md「Past six participants」）──
// 桌面实测：轮尾摘要里那一行原本是静态 span，点它冒泡到整块开关、把卡折起来了。它是一扇门：开 run
// 详情、落到这一站；站头照旧是开关的一部分。
describe("WorkflowRunDigest 「还有 n 个」", () => {
  const FANOUT_GRAPH = {
    steps: [
      {
        id: "ask#1",
        kind: "ask",
        label: "review",
        line: 3,
        column: 21,
        lane: "actor#1",
        phase: "phase#a",
      },
    ],
    lanes: [{ id: "actor#1", namePattern: { head: "reviewer-" }, line: 2, column: 11 }],
    participants: [
      { id: "phase#a:actor#1", phase: "phase#a", lane: "actor#1", steps: ["ask#1"], many: true },
    ],
    handoffs: [],
    phases: [{ id: "phase#a", name: "review", line: 1 }],
    phaseEdges: [],
    exits: ["phase#a"],
  } as const;
  function fanout(n: number): WorkflowRunCardSummary {
    const actors: WorkflowRunState["actors"] = [];
    const nodes: WorkflowRunState["nodes"] = [];
    for (let i = 1; i <= n; i += 1) {
      actors.push({
        siteId: "actor#1",
        ordinal: i,
        name: `reviewer-${i}`,
        sessionId: `s-${i}`,
        status: "running",
      });
      nodes.push({
        siteId: "ask#1",
        ordinal: i,
        phase: "executing",
        actorSiteId: "actor#1",
        actorOrdinal: i,
      } as WorkflowRunState["nodes"][number]);
    }
    return joined({ actors, nodes, usage: { spentTokens: 10, nodesUsed: n } });
  }
  const renderFanout = (props: Partial<WorkflowRunDigestProps>) =>
    renderDigest({
      graph: FANOUT_GRAPH as unknown as WorkflowRunDigestProps["graph"],
      summary: fanout(9),
      ...props,
    });

  it("有 onOpenRun 时那一行是按钮：点它开 run 详情、带站 id，不切换折叠；站头仍是开关的一部分", () => {
    const onOpenRun = vi.fn();
    const view = renderFanout({ onOpenRun });
    const root = view.container.querySelector("[data-workflow-run-digest]")!;
    expect(root.getAttribute("data-expanded")).toBe("true");
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("BUTTON");
    fireEvent.click(row);
    expect(onOpenRun).toHaveBeenCalledWith({ phaseId: "phase#a" });
    expect(root.getAttribute("data-expanded")).toBe("true");
    // 站头没有回调：span，点它切换折叠（追记「点击语法修订」）。
    const head = view.getByTestId("workflow-timeline-station-head");
    expect(head.tagName).toBe("SPAN");
    fireEvent.click(head);
    expect(root.getAttribute("data-expanded")).toBe("false");
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    // ⤢ 开整个 run，不带落点。
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenLastCalledWith();
  });

  it("没有 onOpenRun 时那一行是静态的 span，点它与点空白一样切换折叠", () => {
    const view = renderFanout({});
    const root = view.container.querySelector("[data-workflow-run-digest]")!;
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("SPAN");
    fireEvent.click(row);
    expect(root.getAttribute("data-expanded")).toBe("false");
  });
});

// ── 子代理模型（docs/dynamic-workflow/presentation.md「The run card」）──
// 细节串已经在说「几个子代理」，模型名跟在它后面当最后一段，同一段淡色文字——不加芯片、不加
// 前缀。强度与规范串在 tooltip 里。没指定过模型的 run 没有这一段。
describe("WorkflowRunDigest 子代理模型", () => {
  // 团队套餐的 provider id 是一串十六进制：这次改动要挡的就是它。
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  it("模型名是细节串的最后一段；provider id 不上屏，规范串与强度进 tooltip", () => {
    const view = renderDigest({ summary: joined({ subagentModel: TEAM_PLAN_MODEL }) });

    const detail = view.getByTestId("workflow-card-detail");
    expect(detail.textContent).toBe("2 phases · 1 agent working · GLM-5.3-Flash");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(detail.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    expect(detail.getAttribute("title")).toContain("thinking High");
  });

  it("宿主给得出 provider 名时才拼「名字/模型」", () => {
    const view = renderDigest({
      subagentModelProviderName: (providerId) => (providerId === "myproxy" ? "MyProxy" : undefined),
      summary: joined({ subagentModel: "myproxy/glm-4.7$medium" }),
    });

    expect(view.getByTestId("workflow-card-detail").textContent).toBe(
      "2 phases · 1 agent working · MyProxy/glm-4.7",
    );
  });

  it("没指定过模型的 run：细节串一个字不变，也没有 tooltip", () => {
    const view = renderDigest({ summary: joined() });

    const detail = view.getByTestId("workflow-card-detail");
    expect(detail.textContent).toBe("2 phases · 1 agent working");
    expect(detail.getAttribute("title")).toBeNull();
  });
});

// ── 表头挤不下的时候（docs/dynamic-workflow/presentation.md「When the header runs out of room」）──
// 细节串曾是表头上唯一不肯让位的那段字：它一长（子代理模型名能让它比「2 phases · 1 agent working」
// 长出一截），Configure 与 Stop 就被挤到卡片右边框外面。jsdom 不排版，所以这里钉住产生那个布局的
// 类契约——细节串可缩、控件不可缩、右簇带 min-w-0（少了它整簇一个像素都不缩，见下面第三条）。
describe("WorkflowRunDigest 表头溢出", () => {
  const LONG_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  function runningCard() {
    return renderDigest({
      onCancel: vi.fn(),
      onOpenRun: vi.fn(),
      settingsHost: { workspacePath: "/w", apply: vi.fn() },
      summary: joined({ subagentModel: LONG_MODEL }),
    });
  }

  it("让位的是细节串：min-w-0 + truncate，一行截断", () => {
    const detail = runningCard().getByTestId("workflow-card-detail");

    expect(detail.className).toContain("min-w-0");
    expect(detail.className).toContain("truncate");
  });

  it("控件不缩：Configure、Stop、⤢ 都带 shrink-0", () => {
    const view = runningCard();

    for (const id of [
      "workflow-digest-configure",
      "workflow-digest-cancel",
      "workflow-card-open-details",
    ]) {
      expect(view.getByTestId(id).className).toContain("shrink-0");
    }
  });

  it("右簇可压缩：不带 shrink-0，且必须带 min-w-0（否则地板是整串细节，一个像素都不缩）", () => {
    const view = runningCard();
    const cluster = view.getByTestId("workflow-card-detail").parentElement!;

    // shrink-0 会让整簇按内容宽定死——正是按钮被顶出卡外的老形状。
    expect(cluster.className).not.toContain("shrink-0");
    // 簇的 min-w-0 是这次修复的承重件：flex item 的 automatic minimum size 是 min-content，
    // 而 truncate 的 nowrap 让细节串的 min-content 等于整串字宽（overflow:hidden 和细节串
    // 自己的 min-w-0 都不会把它算小）。少了它，簇的地板就是「整串细节 + 按钮」。
    expect(cluster.className).toContain("min-w-0");
    // 三个控件与细节串同处一簇：负空间只能落在细节串上。
    for (const id of [
      "workflow-digest-configure",
      "workflow-digest-cancel",
      "workflow-card-open-details",
    ]) {
      expect(cluster.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
});

describe("WorkflowRunDigest 收起态（默认）", () => {
  it("表头 + 阶段线：种类词、名字、灯 + 状态词、不含 tokens 的摘要；站与弧在场，药丸不在", () => {
    const view = renderDigest({ summary: joined() });
    const root = view.getByTestId("workflow-run-digest-t");
    expect(root.getAttribute("data-expanded")).toBe("true");
    expect(root.getAttribute("data-workflow-run-status")).toBe("running");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow running");
    expect(view.getByTestId("workflow-card-name").textContent).toBe("implement-verify");
    expect(view.queryByTestId("workflow-digest-status")).toBeNull();
    const detail = view.getByTestId("workflow-card-detail").textContent!;
    expect(detail).toBe("2 phases · 1 agent working");
    expect(view.getByTestId("workflow-card-detail").className).toContain("text-ui-base");
    expect(view.getByTestId("workflow-card-detail").className).not.toContain("font-mono");
    expect(detail).not.toContain("tokens");
    // 运行中的种类词扫光，wf-swap 包在渐变外面（round 7 的教训）。
    expect(root.querySelector(".wf-swap .animated-gradient-text")).toBeTruthy();

    expect(view.getAllByTestId("workflow-timeline-station")).toHaveLength(2);
    expect(view.getByTestId("workflow-timeline-arc")).toBeTruthy();
    expect(view.queryAllByTestId("workflow-agent-pill")).toHaveLength(2);
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
    // 没有回调就没有 ⤢、没有 Resume（回调的存在即门控）。
    expect(view.queryByTestId("workflow-card-open-details")).toBeNull();
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
  });

  it("无箭头仍可点击及键盘折叠，子控件不切换", () => {
    const onOpenRun = vi.fn();
    const view = renderDigest({ summary: joined(), onOpenRun });
    const root = view.getByTestId("workflow-run-digest-t");
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
    expect(root.getAttribute("role")).toBe("button");
    fireEvent.click(root);
    expect(view.queryAllByTestId("workflow-agent-pill")).toHaveLength(0);
    fireEvent.keyDown(root, { key: "Enter" });
    expect(view.getAllByTestId("workflow-agent-pill")).toHaveLength(2);
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledOnce();
  });

  it("还没启动的子代理药丸与活药丸同一套点击语法：按钮、↗，点它交出槽位而不切换整块", () => {
    // docs/dynamic-workflow/presentation.md「The pill」：此前它是 span，点击冒泡到整块
    // 开关，把卡折起来。
    const onOpenPill = vi.fn();
    const view = renderDigest({
      summary: joined({
        actors: [
          { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
        ],
      }),
      onOpenPill,
    });
    const root = view.getByTestId("workflow-run-digest-t");
    const pills = view.getAllByTestId("workflow-agent-pill");
    expect(pills.map((pill) => pill.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(pills[1]!.className).toContain("wf-pill-open");
    expect(pills[1]!.querySelector('[data-testid="workflow-timeline-pill-open"]')).not.toBeNull();
    fireEvent.click(pills[1]!);
    expect(onOpenPill).toHaveBeenCalledTimes(1);
    const handed = onOpenPill.mock.calls[0]![0] as TimelinePill;
    expect(handed.slot).toEqual({ siteId: "actor#2", ordinal: 1 });
    expect(handed.instance).toBeUndefined();
    expect(root.getAttribute("data-expanded")).toBe("true");
  });

  it("⤢ 与待答问题芯片都开 run 详情；芯片按数量计数、无回调时不可点", () => {
    const onOpenRun = vi.fn();
    const view = renderDigest({ summary: joined(), onOpenRun, pendingQuestions: 1 });
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    const chip = view.getByTestId("workflow-digest-questions");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.textContent).toBe("1 question");
    fireEvent.click(chip);
    expect(onOpenRun).toHaveBeenCalledTimes(2);
    cleanup();

    const inert = renderDigest({ summary: joined(), pendingQuestions: 2 });
    const span = inert.getByTestId("workflow-digest-questions");
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe("2 questions");
    cleanup();

    expect(
      renderDigest({ summary: joined() }).queryByTestId("workflow-digest-questions"),
    ).toBeNull();
  });

  it("失败且可恢复：Resume 进表头，与详情页同一条命令；不可恢复或无回调时没有", () => {
    const onResume = vi.fn();
    const view = renderDigest({
      summary: joined({ status: "stopped", stopReason: "interrupted" }, { resumable: true }),
      onResume,
    });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow stopped");
    expect(view.getByTestId("workflow-digest-resume").getAttribute("data-size")).toBe("default");
    fireEvent.click(view.getByTestId("workflow-digest-resume"));
    expect(onResume).toHaveBeenCalledTimes(1);
    cleanup();

    expect(
      renderDigest({ summary: joined({ status: "errored" }), onResume }).queryByTestId(
        "workflow-digest-resume",
      ),
    ).toBeNull();
  });
});

describe("WorkflowRunDigest 产物条", () => {
  const ARTIFACTS = [
    { id: "book", kind: "file", title: "Audit report", version: 2 },
    { id: "perf", kind: "chart", title: "Round timings", version: 1 },
  ] as unknown as WorkflowRunState["artifacts"];

  it("收起态与展开态都挂产物条；点药丸交出产物 id，不切换整块", () => {
    const onOpenArtifact = vi.fn();
    const view = renderDigest({
      summary: joined({ status: "completed", artifacts: ARTIFACTS }),
      onOpenArtifact,
    });
    const root = view.getByTestId("workflow-run-digest-t");
    const strip = view.getByTestId("workflow-digest-artifacts");
    const pills = view.getAllByTestId("workflow-digest-artifact");
    expect(pills).toHaveLength(2);
    expect(pills[0]?.tagName).toBe("BUTTON");
    expect(pills[0]?.getAttribute("data-pill-size")).toBe("md");
    // 尾槽里的 v2 只在第 2 版的那枚上。
    expect(strip.querySelectorAll('[data-testid="workflow-run-artifact-version"]')).toHaveLength(1);

    expect(root.getAttribute("data-expanded")).toBe("true");
    fireEvent.click(pills[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith("perf");
    expect(root.getAttribute("data-expanded")).toBe("true");
    // 条上的空白处**是**整块开关的一部分（追记「点击语法修订」）：点它切换，产物条仍在。
    fireEvent.click(strip);
    expect(root.getAttribute("data-expanded")).toBe("false");
    expect(view.getAllByTestId("workflow-digest-artifact")).toHaveLength(2);
    fireEvent.click(strip);
    expect(root.getAttribute("data-expanded")).toBe("true");
  });

  it("禁用的产物药丸（无回调）不透传：点它既不打开也不切换整块", () => {
    const view = renderDigest({ summary: joined({ status: "completed", artifacts: ARTIFACTS }) });
    const root = view.getByTestId("workflow-run-digest-t");
    const pill = view.getAllByTestId("workflow-digest-artifact")[0] as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    fireEvent.click(pill);
    expect(root.getAttribute("data-expanded")).toBe("true");
  });

  it("没有产物或没有活投影时条缺席；没有回调时药丸禁用", () => {
    expect(
      renderDigest({ summary: joined() }).queryByTestId("workflow-digest-artifacts"),
    ).toBeNull();
    cleanup();
    const cold = renderDigest({ summary: joined({ artifacts: ARTIFACTS }, { run: undefined }) });
    expect(cold.queryByTestId("workflow-digest-artifacts")).toBeNull();
    cleanup();
    const inert = renderDigest({ summary: joined({ artifacts: ARTIFACTS }) });
    const pill = inert.getAllByTestId("workflow-digest-artifact")[0] as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
  });
});

// 实例表撞界（docs/dynamic-workflow/presentation.md「The run card」）：表头的计数已经把表外的
// 实例算进来了，时间线却只画得出表内那些——时间线下的这一句说的正是这个差额。
describe("WorkflowRunDigest 撞界提示", () => {
  const truncated = (overrides: Partial<WorkflowRunState> = {}) =>
    joined({
      usage: { spentTokens: 10, nodesUsed: 2, nodesUnlisted: 1_500, nodesUnlistedSettled: 900 },
      truncated: true,
      ...overrides,
    });

  it("收起态与展开态都在：「仅展示 2/1502 步的详情」", () => {
    const view = renderDigest({ summary: truncated() });
    const root = view.getByTestId("workflow-run-digest-t");
    expect(view.getByTestId("workflow-digest-truncated").textContent).toBe(
      "Details shown for 2 of 1502 steps",
    );
    fireEvent.click(root);
    expect(root.getAttribute("data-expanded")).toBe("false");
    expect(view.getByTestId("workflow-digest-truncated")).not.toBeNull();
  });

  it("没撞界、只有小表撞界、没有活投影、以及没有轨道的单行卡上都没有这一句", () => {
    expect(
      renderDigest({ summary: joined() }).queryByTestId("workflow-digest-truncated"),
    ).toBeNull();
    cleanup();
    // `truncated` 也会被 reports / artifacts / phases 触界置位；那时步数一个不少，没有可说的。
    expect(
      renderDigest({ summary: joined({ truncated: true }) }).queryByTestId(
        "workflow-digest-truncated",
      ),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest({ summary: truncated({}), graph: undefined }).queryByTestId(
        "workflow-digest-truncated",
      ),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest({ summary: joined({ truncated: true }, { run: undefined }) }).queryByTestId(
        "workflow-digest-truncated",
      ),
    ).toBeNull();
  });

  it("zh-CN 念「仅展示 2/1502 步的详情」", () => {
    const view = renderDigest({ summary: truncated() }, "zh-CN");
    expect(view.getByTestId("workflow-digest-truncated").textContent).toBe(
      "仅展示 2/1502 步的详情",
    );
  });
});

describe("WorkflowRunDigest 冷态", () => {
  it("没有活投影：一行——种类词 + 名字 + 状态词，没有计数、没有阶段线、没有 chevron", () => {
    const summary: WorkflowRunCardSummary = {
      runId: "dwfrun-42",
      toolCallId: "tool-create-workflow",
      status: "completed",
      nodesSettled: 2,
      nodesTotal: 2,
    };
    const view = renderDigest({ summary, onOpenRun: vi.fn() });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow completed");
    expect(view.queryByTestId("workflow-digest-status")).toBeNull();
    expect(view.queryByTestId("workflow-card-detail")).toBeNull();
    expect(view.queryByTestId("workflow-digest-plot")).toBeNull();
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
    const root = view.getByTestId("workflow-run-digest-t");
    expect(root.hasAttribute("data-expanded")).toBe(false);
    // 没有阶段线就没有开关：整块不是按钮。
    expect(root.hasAttribute("role")).toBe(false);
    expect(view.getByTestId("workflow-card-open-details")).toBeTruthy();
  });

  it("行窗口里没有图（resume 单独成轮）：即使有活投影也只剩一行", () => {
    const view = renderDigest({ summary: joined(), graph: undefined });
    expect(view.queryByTestId("workflow-card-detail")).toBeNull();
    expect(view.queryByTestId("workflow-digest-plot")).toBeNull();
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
  });
});

describe("WorkflowRunDigest 文案", () => {
  it("zh-CN 双写：芯片与 chevron 的词条在两种语言里都在", () => {
    for (const id of [
      "chat.toolCall.workflow.digest.question",
      "chat.toolCall.workflow.digest.questions",
      "chat.toolCall.workflow.digest.showAgents",
      "chat.toolCall.workflow.digest.hideAgents",
    ]) {
      expect(enUS[id as keyof typeof enUS]).toBeTruthy();
      expect(zhCN[id as keyof typeof zhCN]).toBeTruthy();
    }
    const view = renderDigest({ summary: joined(), pendingQuestions: 1 }, "zh-CN");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("工作流运行中");
    expect(view.getByTestId("workflow-digest-questions").textContent).toBe("1 个待答问题");
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
  });
});

it.each(["running", "completed", "stopped"] as const)(
  "运行卡名称使用普通 UI 字体：%s",
  (status) => {
    const view = renderDigest({ summary: joined({ status }) });
    expect(view.getByTestId("workflow-card-name").className).not.toContain("font-mono");
  },
);

// 运行卡上的 Stop run（docs/dynamic-workflow/presentation.md）：running 时
// Resume 的位置换成 Stop，走详情页同一条命令；点下即禁用直到状态变化。
describe("WorkflowRunDigest Stop run", () => {
  it("running + onCancel：Stop 进表头、可点；点后禁用并换成 Stopping…", () => {
    const onCancel = vi.fn();
    const view = renderDigest({ summary: joined(), onCancel });
    const cancel = view.getByTestId("workflow-digest-cancel");
    // 与 ⤢ 同款：ghost 图标钮，文字只在 aria-label / 提示里。
    expect(cancel.getAttribute("aria-label")).toBe("Stop run");
    expect(cancel.textContent).toBe("");
    expect(cancel.getAttribute("data-size")).toBe("icon-md");
    expect(cancel.getAttribute("data-variant")).toBe("ghost");
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(cancel.getAttribute("aria-label")).toBe("Stopping…");
    // 点 Cancel 不触发卡片折叠（按钮被 hitsControl 排除）。
    expect(
      view.container.querySelector("[data-workflow-run-digest]")?.getAttribute("data-expanded"),
    ).toBe("true");
  });

  it("Stopping… 的复位不再是一轮 effect setState：状态变化只提交一次", () => {
    // 修订 2026-09-12：复位曾是按 status 跑的 effect 里的 setCancelling(false)——每次状态变化都在
    // 投影帧的同步提交之后再补一笔更新（与工作流卡崩溃的抛点同形）。现在 Cancel 钮按 status 键控
    // 重挂，复位是重挂本身，状态变化那一帧只提交一次。用 Profiler 数提交。
    const onCancel = vi.fn();
    const onResume = vi.fn();
    let commits = 0;
    const tree = (summary: WorkflowRunCardSummary) =>
      createElement(
        Profiler,
        { id: "digest", onRender: () => (commits += 1) },
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(WorkflowRunDigest, {
            graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
            name: "implement-verify",
            testIdKey: "t",
            summary,
            onCancel,
            onResume,
          }),
        ),
      );
    const view = render(tree(joined()));
    fireEvent.click(view.getByTestId("workflow-digest-cancel"));
    expect(view.getByTestId("workflow-digest-cancel").getAttribute("aria-label")).toBe("Stopping…");

    // 同状态的新帧：按钮保持 Stopping…。
    view.rerender(tree(joined({ status: "running" }, { nodesSettled: 3 })));
    expect((view.getByTestId("workflow-digest-cancel") as HTMLButtonElement).disabled).toBe(true);

    commits = 0;
    view.rerender(tree(joined({ status: "stopped" }, { resumable: true })));
    expect(commits).toBe(1);
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.getByTestId("workflow-digest-resume")).toBeTruthy();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("状态一变按钮复位；stopped + resumable 时原位是 Resume；无回调或非 running 不渲染", () => {
    const onCancel = vi.fn();
    const onResume = vi.fn();
    const view = renderDigest({ summary: joined(), onCancel, onResume });
    fireEvent.click(view.getByTestId("workflow-digest-cancel"));
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunDigest, {
          graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
          name: "implement-verify",
          testIdKey: "t",
          summary: joined({ status: "stopped" }, { resumable: true }),
          onCancel,
          onResume,
        }),
      ),
    );
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.getByTestId("workflow-digest-resume")).toBeTruthy();
    cleanup();

    expect(renderDigest({ summary: joined() }).queryByTestId("workflow-digest-cancel")).toBeNull();
    cleanup();
    expect(
      renderDigest({ summary: joined({ status: "completed" }), onCancel }).queryByTestId(
        "workflow-digest-cancel",
      ),
    ).toBeNull();
  });

  it("zh-CN：停止运行 / 正在停止…", () => {
    const view = renderDigest({ summary: joined(), onCancel: vi.fn() }, "zh-CN");
    const cancel = view.getByTestId("workflow-digest-cancel");
    expect(cancel.getAttribute("aria-label")).toBe("停止运行");
    fireEvent.click(cancel);
    expect(cancel.getAttribute("aria-label")).toBe("正在停止…");
    expect(enUS["chat.toolCall.workflow.run.cancelling"]).toBeTruthy();
    expect(zhCN["chat.toolCall.workflow.run.cancelling"]).toBeTruthy();
  });

  // 动词改名的另一半：按下去之前就说清楚「停止 ≠ 丢弃」。这句话只活在提示的第二行里，
  // 所以断言走提示 props，而不是 DOM。
  it("提示第二行说明可恢复；正在停止时那句话撤走", () => {
    const view = renderDigest({ summary: joined(), onCancel: vi.fn() });
    const before = tooltips.calls.find((call) => call.title === "Stop run");
    expect(before?.description).toBe("You can resume later; finished steps are kept.");

    tooltips.calls.length = 0;
    fireEvent.click(view.getByTestId("workflow-digest-cancel"));
    const during = tooltips.calls.find((call) => call.title === "Stopping…");
    expect(during).toBeTruthy();
    expect(during?.description).toBeUndefined();
  });

  it("zh-CN 的提示第二行同样在场", () => {
    renderDigest({ summary: joined(), onCancel: vi.fn() }, "zh-CN");
    expect(tooltips.calls.find((call) => call.title === "停止运行")?.description).toBe(
      "停止后可以随时恢复，已完成的步骤会保留。",
    );
  });

  // run 控件的词表两边必须同集同序：一边加了词另一边忘了，用户看到的是英文兜底漏进中文界面。
  it("run 词表的键集在两种语言下完全一致", () => {
    const prefix = "chat.toolCall.workflow.run.";
    const zhKeys = Object.keys(zhCN).filter((key) => key.startsWith(prefix));
    const enKeys = Object.keys(enUS).filter((key) => key.startsWith(prefix));
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(enKeys).toEqual(zhKeys);
    for (const key of [`${prefix}stopHint`, `${prefix}resumable`]) {
      expect(zhCN[key]).toBeTruthy();
      expect(enUS[key]).toBeTruthy();
    }
  });
});

// ── lineage（docs/dynamic-workflow/presentation.md「The run card」）──
// 卡上只换种类词，不画「调整自 / 已被替代」两句（用户裁决：太吵）；那两句只在详情页与确认窗。
describe("WorkflowRunDigest lineage", () => {
  // 联接表把 run.stopReason 抄到摘要上（workflowRunCardJoin.ts）；夹具照抄。
  const superseded = joined(
    { status: "stopped", stopReason: "superseded", supersededBy: "dwfrun-next" },
    { stopReason: "superseded" },
  );

  it.each([
    ["en-US", "Workflow superseded"],
    ["zh-CN", "工作流已被替代"],
  ] as const)("被替代的 run：只换种类词，没有 Resume，也没有后继链接：%s", (locale, kind) => {
    const onResume = vi.fn();
    const view = renderDigest({ summary: superseded, onResume }, locale);
    expect(view.getByTestId("workflow-card-kind").textContent).toBe(kind);
    expect(view.container.textContent).not.toContain("dwfrun-next");
    // 被替代的 run 永不可恢复（CLI 不给 resumable）。
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
    // 灯仍是 stopped 的中性空环，不是 destructive。
    expect(view.container.innerHTML).not.toContain("bg-destructive");
  });

  it("修订出来的 run 卡上不提前驱", () => {
    const view = renderDigest({ summary: joined({ resumedFrom: "dwfrun-prev" }) });
    expect(view.container.textContent).not.toContain("dwfrun-prev");
  });

  it("普通 stopped 的 run 种类词照旧", () => {
    const view = renderDigest({
      summary: joined({ status: "stopped", stopReason: "user" }, { stopReason: "user" }),
    });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow stopped");
  });
});

// ── 接线（docs/dynamic-workflow/authoring.md「How the user sees them」）──
// 上面钉的是药丸把**产物 id** 交给上一层；这里钉上一层把 id 变成什么样的打开请求。活投影里那份
// 产物摘要带最新版的 `contentType`（宿主据它把 html 产物直接开成浏览器 tab），刻意不带
// `sourcePath`（高频状态键），所以请求里也不该凭空出现一个出处。
describe("ConversationWorkflowDigests 把药丸变成打开请求", () => {
  const ARTIFACTS = [
    { id: "book", kind: "file", title: "Audit report", version: 2, contentType: "text/html" },
    { id: "perf", kind: "chart", title: "Round timings", version: 1 },
  ] as unknown as WorkflowRunState["artifacts"];

  function renderDigests(onOpenWorkflowArtifact: (request: unknown) => void) {
    const summary = joined({ status: "completed", artifacts: ARTIFACTS });
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationWorkflowDigests, {
          turnKey: "t",
          digests: [
            {
              key: "k",
              toolCallId: "tool-create-workflow",
              runId: "dwfrun-42",
              name: "implement-verify",
              graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
              summary,
            },
          ],
          context: {
            sessionId: "parent-a",
            onOpenWorkflowArtifact,
          } as unknown as ConversationRowRenderContext,
        }),
      ),
    );
  }

  it("带上展示名与 contentType，不带出处（活投影那份摘要没有 sourcePath）", () => {
    const spy = vi.fn();
    const view = renderDigests(spy);

    fireEvent.click(view.getAllByTestId("workflow-digest-artifact")[0]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "dwfrun-42",
      artifactId: "book",
      title: "Audit report",
      contentType: "text/html",
    });
  });

  it("摘要上没有 contentType 的那一枚不编一个出来", () => {
    const spy = vi.fn();
    const view = renderDigests(spy);

    fireEvent.click(view.getAllByTestId("workflow-digest-artifact")[1]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "dwfrun-42",
      artifactId: "perf",
      title: "Round timings",
    });
  });
});
