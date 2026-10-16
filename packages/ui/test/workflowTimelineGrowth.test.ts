// @vitest-environment jsdom
// 补全的生长（docs/dynamic-workflow/presentation.md「Holes on the timeline」的「Growth」）：补全接进 run 的那一帧，
// 插入列右侧的站带 `wf-slide`、从 −插入宽度滑到位；320ms 后类摘掉；冷开一条已补全的时间线不滑。
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { STATION_PITCH } from "@/components/workflow-timeline/timeline-geometry.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { SLIDE_MS, fillGrowth } from "@/components/workflow-timeline/use-fill-growth.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 留白 id 是名字键 `hole#<8 位十六进制>`（docs/analysis.md「Sites」）；渲染器只认形状。
const H1 = "hole#a0000001"; // 决定分组
const H2 = "hole#a0000002"; // 评判

const OPEN: WorkflowCausalityGraphData = {
  steps: [
    { id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" },
    { id: H1, kind: "hole", label: "决定分组", lane: "main", phase: H1 },
    { id: "ask#2", kind: "ask", label: "member", lane: "actor#2", phase: "phase#2" },
  ],
  lanes: [
    { id: "actor#1", name: "侦察员" },
    { id: "actor#2", name: "组员" },
  ],
  participants: [
    { id: "p1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
    { id: "p2", phase: "phase#2", lane: "actor#2", steps: ["ask#2"] },
  ],
  handoffs: [],
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: "phase#2", name: "执行" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: "phase#2" },
    { from: "phase#2", to: H2 },
  ],
  holes: [
    { siteId: H1, name: "决定分组", type: "Plan" },
    { siteId: H2, name: "评判", type: "Verdict", tail: true },
  ],
};
const FILLED: WorkflowCausalityGraphData = {
  ...OPEN,
  steps: [
    OPEN.steps[0]!,
    {
      id: `${H1}/ask#1`,
      kind: "ask",
      label: "smoke",
      lane: `${H1}/actor#1`,
      phase: `${H1}/phase#1`,
      fill: H1,
    },
    {
      id: `${H1}/ask#2`,
      kind: "ask",
      label: "group",
      lane: `${H1}/actor#2`,
      phase: `${H1}/phase#2`,
      fill: H1,
    },
    OPEN.steps[2]!,
  ],
  lanes: [
    ...OPEN.lanes,
    { id: `${H1}/actor#1`, name: "冒烟员" },
    { id: `${H1}/actor#2`, name: "分组员" },
  ],
  participants: [
    OPEN.participants[0]!,
    { id: "p3", phase: `${H1}/phase#1`, lane: `${H1}/actor#1`, steps: [`${H1}/ask#1`] },
    { id: "p4", phase: `${H1}/phase#2`, lane: `${H1}/actor#2`, steps: [`${H1}/ask#2`] },
    OPEN.participants[1]!,
  ],
  // 体以标记开头：分析器留着 H1 自己的阶段（无成员），时间线把它交给头、不成站。
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: `${H1}/phase#1`, name: "冒烟测试", fill: H1 },
    { id: `${H1}/phase#2`, name: "分组", fill: H1 },
    { id: "phase#2", name: "执行" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: `${H1}/phase#1` },
    { from: `${H1}/phase#1`, to: `${H1}/phase#2` },
    { from: `${H1}/phase#2`, to: "phase#2" },
    { from: "phase#2", to: H2 },
  ],
  holes: [{ siteId: H2, name: "评判", type: "Verdict", tail: true }],
};

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-1",
    toolCallId: "tc-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}
const WAITING = run({
  holes: [{ siteId: H1, ordinal: 1, name: "决定分组", type: "Plan", state: "waiting" }],
});
const AFTER = run({
  holes: [
    {
      siteId: H1,
      ordinal: 1,
      name: "决定分组",
      type: "Plan",
      state: "filled",
      filledAt: Date.now(),
    },
  ],
});

describe("fillGrowth", () => {
  it("新出现的补全头且站数增加才算生长：after 是新头的末站，shift 是增量 × 站距", () => {
    const before = buildWorkflowTimeline(OPEN, WAITING);
    const after = buildWorkflowTimeline(FILLED, AFTER);
    const seen = { stations: before.stations.length, fills: [] };
    expect(fillGrowth(seen, after)).toEqual({ after: 2, shift: STATION_PITCH });
    // 头没变（只是 run 进度变了）或站数没增（无阶段的补全）都不滑。
    expect(fillGrowth({ stations: 5, fills: [H1] }, after)).toBeUndefined();
    expect(fillGrowth({ stations: 5, fills: [] }, after)).toBeUndefined();
  });
});

describe("WorkflowTimeline · 生长的滑动", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function view(model: ReturnType<typeof buildWorkflowTimeline>) {
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkflowTimeline, { model }),
    );
  }
  const slid = (container: HTMLElement) =>
    [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="workflow-timeline-station"].wf-slide',
      ),
    ].map((station) => [
      station.dataset.stationStatus,
      station.style.getPropertyValue("--wf-slide"),
    ]);

  it("补全接进 run：插入列右侧的站带 wf-slide 与 −插入宽度；320ms 后摘掉；新站自己不滑", () => {
    const { container, rerender } = render(view(buildWorkflowTimeline(OPEN, WAITING)));
    expect(slid(container)).toEqual([]);
    rerender(view(buildWorkflowTimeline(FILLED, AFTER)));
    const stations = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="workflow-timeline-station"]'),
    ];
    expect(stations.map((station) => station.classList.contains("wf-slide"))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(stations[3]!.style.getPropertyValue("--wf-slide")).toBe(`${-STATION_PITCH}px`);
    // 药丸列也随站滑。
    expect(
      container.querySelectorAll('[data-testid="workflow-timeline-pills"].wf-slide'),
    ).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(SLIDE_MS);
    });
    expect(slid(container)).toEqual([]);
  });

  it("冷开一条已补全的时间线不滑", () => {
    const { container } = render(view(buildWorkflowTimeline(FILLED, AFTER)));
    expect(slid(container)).toEqual([]);
  });
});
