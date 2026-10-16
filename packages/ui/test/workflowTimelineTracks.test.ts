// @vitest-environment jsdom

// 带与轨道在卡上的画法（docs/dynamic-workflow/presentation.md「Drawing the timeline」的「Bands on the card」）：
// 主线走最下面一行、分支叠在它上面、站头搬到站台行，分叉与汇合是曲线。没有带的时间线一像素不动。
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { timelineLayout, timelineWidth } from "@/components/workflow-timeline/timeline-geometry.js";
import {
  timelineHeight,
  WorkflowTimeline,
} from "@/components/workflow-timeline/WorkflowTimeline.js";
import { timelineRailPieces } from "@/components/workflow-timeline/WorkflowTimelineTracks.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

interface GraphSpec {
  names: readonly string[];
  /** 站下标 → 与它并行的站下标。 */
  alongside?: Record<number, readonly number[]>;
  edges: readonly (readonly [number, number])[];
}

function graphOf({ alongside = {}, edges, names }: GraphSpec): WorkflowCausalityGraphData {
  return {
    steps: names.map((name, i) => ({
      id: `ask#${i + 1}`,
      kind: "ask",
      label: name,
      line: i + 1,
      column: 1,
      lane: "actor#1",
      phase: `phase#${i + 1}`,
    })),
    lanes: [{ id: "actor#1", name: "worker", line: 1, column: 1 }],
    participants: names.map((_, i) => ({
      id: `phase#${i + 1}:actor#1`,
      phase: `phase#${i + 1}`,
      lane: "actor#1",
      steps: [`ask#${i + 1}`],
    })),
    handoffs: [],
    phases: names.map((name, i) => ({
      id: `phase#${i + 1}`,
      name,
      line: i + 1,
      column: 1,
      ...(alongside[i] === undefined
        ? {}
        : { alongside: alongside[i]!.map((j) => `phase#${j + 1}`) }),
    })),
    phaseEdges: edges.map(([from, to]) => ({ from: `phase#${from + 1}`, to: `phase#${to + 1}` })),
    exits: [`phase#${names.length}`],
  } as WorkflowCausalityGraphData;
}

/** 测试台架：A ∥ B → C，B 与 A 并行；边 A → B、B → C。 */
const TESTFIELD: GraphSpec = {
  alongside: { 1: [0] },
  edges: [
    [0, 1],
    [1, 2],
  ],
  names: ["A", "B", "C"],
};

/** 同一条带，前面多一个前驱 P。 */
const WITH_PRED: GraphSpec = {
  alongside: { 2: [1] },
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
  names: ["P", "A", "B", "C"],
};

/** 带 [[A], [B, C]]，前有 P、后有 J；B → C 里再来一条回边 C → B（同一条轨道上的弧）。 */
const INNER_LOOP: GraphSpec = {
  alongside: { 2: [1], 3: [1] },
  edges: [
    [0, 1],
    [0, 2],
    [2, 3],
    [3, 4],
    [1, 4],
    [3, 2],
  ],
  names: ["P", "A", "B", "C", "J"],
};

function modelOf(spec: GraphSpec, run?: WorkflowRunState) {
  return buildWorkflowTimeline(graphOf(spec), run);
}

function renderTimeline(model: ReturnType<typeof buildWorkflowTimeline>) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowTimeline, { model }),
    ),
  );
}

/** 站 `running` 的 run：前面的站都结算过，最后一站在跑。 */
function runWith(names: readonly string[], runningIndex: number): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-1",
    status: "running",
    usage: { spentTokens: 1, nodesUsed: names.length },
    actors: [
      { siteId: "actor#1", ordinal: 1, name: "worker", sessionId: "s-1", status: "running" },
    ],
    nodes: names.map((_, i) => ({
      siteId: `ask#${i + 1}`,
      ordinal: 1,
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      ...(i === runningIndex
        ? { phase: "executing" as const }
        : { phase: "settled" as const, outcome: "ok" as const }),
    })) as WorkflowRunState["nodes"],
    lastEventSequence: 1,
  };
}

const railsOf = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("[data-testid='workflow-timeline-rail']")].map((rail) => ({
    d: rail.querySelector("path")?.getAttribute("d") ?? undefined,
    from: rail.getAttribute("data-rail-from"),
    ink: rail.getAttribute("data-rail-ink"),
    kind: rail.getAttribute("data-rail-kind"),
    to: rail.getAttribute("data-rail-to"),
  }));

afterEach(cleanup);

describe("timelineLayout", () => {
  it("without bands the rows are exactly the old rail row: 6px of air, no platform row", () => {
    const model = modelOf({ edges: [[0, 1]], names: ["A", "B"] });
    expect(model.bands).toHaveLength(0);
    expect(timelineLayout(model.arcs, model.bands)).toEqual({
      banded: false,
      capY: 18,
      inset: 0,
      pillsTop: 38,
      rowY: [18],
    });
  });

  it("with a band: branch rows stack above the main line, then a 24px platform row", () => {
    const model = modelOf(TESTFIELD);
    // 顶上一层空没有弧 → 6px 呼吸；分支行 24；主线的空 0；主线行 24；站台行 24；再 8px 到药丸。
    expect(timelineLayout(model.arcs, model.bands)).toEqual({
      banded: true,
      capY: 66,
      inset: 12,
      pillsTop: 86,
      rowY: [42, 18],
    });
  });

  it("an arc in the top air pushes that row down to leave the lane its 8px ceiling", () => {
    const model = modelOf({ ...TESTFIELD, edges: [...TESTFIELD.edges, [2, 0]] });
    expect(model.arcs).toEqual([{ air: 1, from: 2, ink: "faint", lane: 0, to: 0 }]);
    expect(timelineLayout(model.arcs, model.bands).rowY).toEqual([58, 34]);
  });
});

describe("WorkflowTimeline with bands", () => {
  it("draws two track rows, B on the branch, captions on the platform row, and only B gets a leader", () => {
    const model = modelOf(TESTFIELD);
    expect(model.stations.map((station) => station.track)).toEqual([0, 1, 0]);
    const view = renderTimeline(model);
    const layout = timelineLayout(model.arcs, model.bands);

    // 灯：A 与 C 在主线行，B 在分支行；x = 站左缘 + 17 − 5，整条轨道右移 12（带从站 0 起）。
    const lamps = [...view.container.querySelectorAll("[data-lamp]")] as HTMLElement[];
    expect(lamps.map((lamp) => lamp.getAttribute("data-lamp-track"))).toEqual(["0", "1", "0"]);
    expect(lamps.map((lamp) => lamp.style.top)).toEqual(["37px", "13px", "37px"]);
    expect(lamps.map((lamp) => lamp.style.left)).toEqual(["24px", "216px", "408px"]);

    // 站头：全部落在站台行上，左缘 = 站左缘 + 12，宽 168 − 12。
    const stations = view.getAllByTestId("workflow-timeline-station") as HTMLElement[];
    expect(stations.map((station) => station.getAttribute("data-station-track"))).toEqual([
      "0",
      "1",
      "0",
    ]);
    expect(stations.map((station) => station.style.top)).toEqual(["54px", "54px", "54px"]);
    expect(stations.map((station) => station.style.left)).toEqual(["24px", "216px", "408px"]);
    expect(stations.map((station) => station.style.width)).toEqual(["156px", "156px", "156px"]);
    expect(stations.map((station) => station.textContent)).toEqual(["A", "B", "C"]);

    // 引线只给分支轨道的站：主线的灯就在自己的名字正上方，不必再连一条。
    const leaders = view.getAllByTestId("workflow-timeline-leader");
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.getAttribute("data-leader-station")).toBe("1");
    expect(leaders[0]!.getAttribute("d")).toBe(`M221,25 V${layout.capY - 10}`);
    expect(leaders[0]!.getAttribute("stroke-dasharray")).toBe("1 2");
    expect(leaders[0]!.getAttribute("stroke-linecap")).toBe("round");
  });

  it("A → C rides the main row through fork and merge; B merges with a curve; A → B is not a rail", () => {
    const view = renderTimeline(modelOf(TESTFIELD));
    const rails = railsOf(view);
    // 带没有前驱：主线先是一小截尾巴，从 forkX − 4 一直到首站灯前 8px。
    expect(rails).toContainEqual({
      d: "M0,42 H21",
      from: null,
      ink: "faint",
      kind: "tail",
      to: "0",
    });
    // 分支轨道从同一个分叉点升起来，两段 8px 的四分之一圆。
    expect(rails).toContainEqual({
      d: "M4,42 Q12,42 12,34 V26 Q12,18 20,18 H213",
      from: null,
      ink: "faint",
      kind: "fork",
      to: "1",
    });
    // A → C 是主线上一条直线，横穿汇合点（mergeX = colX(2) − 10 = 386）。
    expect(rails).toContainEqual({
      d: "M37,42 H405",
      from: "0",
      ink: "faint",
      kind: null,
      to: "2",
    });
    // B → C 是汇合曲线：横到 xm − 8，落回主线。
    expect(rails).toContainEqual({
      d: "M229,18 H378 Q386,18 386,26 V34 Q386,42 394,42",
      from: "1",
      ink: "faint",
      kind: "merge",
      to: "2",
    });
    // A → B 被分叉吃掉了（控制经过了两条轨道，分叉已经说过）；双线段不画在卡上。
    expect(rails.some((rail) => rail.from === "0" && rail.to === "1")).toBe(false);
    expect(rails).toHaveLength(4);
  });

  it("a leading band insets the whole rail by 12 and the box is exactly timelineHeight", () => {
    const model = modelOf(TESTFIELD);
    const view = renderTimeline(model);
    const box = view.getByTestId("workflow-timeline-scroller").firstElementChild as HTMLElement;
    expect(box.style.width).toBe(`${timelineWidth(3, 12)}px`);
    expect(box.style.width).toBe("564px");
    expect(box.style.height).toBe(`${timelineHeight(model)}px`);
    // 站台行的底 + 8 是药丸的顶；高度 = 药丸顶 + 最高的一列 + 8。
    const pills = view.getAllByTestId("workflow-timeline-pills") as HTMLElement[];
    expect(pills.map((column) => column.style.top)).toEqual(["86px", "86px", "86px"]);
    expect(pills.map((column) => column.style.left)).toEqual(["12px", "204px", "396px"]);
    expect(timelineHeight(model)).toBe(86 + 32 + 8);
    // 收起的运行卡把药丸清空（`WorkflowRunDigest`），轨道与站台行留着：高度正好是药丸的顶 + 8。
    const collapsed = { ...model, stations: model.stations.map((s) => ({ ...s, pills: [] })) };
    expect(timelineHeight(collapsed)).toBe(86 + 8);
  });

  it("with a predecessor there is no inset and the fork is a rail from P into B", () => {
    const model = modelOf(WITH_PRED);
    expect(model.bands[0]).toMatchObject({ from: 1, join: 3, pred: 0, to: 2 });
    const view = renderTimeline(model);
    expect(timelineLayout(model.arcs, model.bands).inset).toBe(0);
    const rails = railsOf(view);
    // P → B：分叉曲线，从 colX(1) − 16 = 176 起，墨随这条段自己。
    expect(rails).toContainEqual({
      d: "M176,42 Q184,42 184,34 V26 Q184,18 192,18 H393",
      from: "0",
      ink: "faint",
      kind: "fork",
      to: "2",
    });
    // P → A 与 A → C 都是主线上的直线；主线因此穿过分叉点与汇合点。
    expect(rails).toContainEqual({
      d: "M25,42 H201",
      from: "0",
      ink: "faint",
      kind: null,
      to: "1",
    });
    expect(rails).toContainEqual({
      d: "M217,42 H585",
      from: "1",
      ink: "faint",
      kind: null,
      to: "3",
    });
    // 没有尾巴、没有残段：两头都有站。
    expect(rails.map((rail) => rail.kind)).not.toContain("tail");
    expect(rails.map((rail) => rail.kind)).not.toContain("stub");
  });

  it("every rail into the running station marches, main row and merge alike", () => {
    const model = modelOf(TESTFIELD, runWith(TESTFIELD.names, 2));
    expect(model.stations.map((station) => station.status)).toEqual(["done", "done", "running"]);
    const view = renderTimeline(model);
    const marching = railsOf(view).filter((rail) => rail.ink === "march");
    expect(marching.map((rail) => [rail.from, rail.to, rail.kind])).toEqual([
      ["0", "2", null],
      ["1", "2", "merge"],
    ]);
    // 行进的段在同一条路径上叠一条亮着的光（不动）：渐变描边，渐变沿这一段的首尾两点铺，
    // 在灯那一头（终点）满色。渐变的 id 各不相同，且都在这张 SVG 里。
    const lights = view.container.querySelectorAll(
      "[data-testid='workflow-timeline-rail'] path.wf-lit",
    );
    expect(lights).toHaveLength(2);
    const pieces = timelineRailPieces(model, timelineLayout(model.arcs, model.bands)).filter(
      (piece) => piece.ink === "march",
    );
    const ids = Array.from(lights).map((light) => {
      const stroke = light.getAttribute("stroke") ?? "";
      expect(light.getAttribute("data-testid")).toBe("workflow-march-light");
      expect(stroke).toMatch(/^url\(#.+\)$/);
      return stroke.slice(5, -1);
    });
    expect(new Set(ids).size).toBe(2);
    ids.forEach((id, k) => {
      const gradient = view.container.querySelector(`linearGradient[id="${id}"]`);
      expect(gradient?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
      expect(Number(gradient?.getAttribute("x1"))).toBe(pieces[k]!.start.x);
      expect(Number(gradient?.getAttribute("x2"))).toBe(pieces[k]!.end.x);
    });
  });

  it("a rail piece's start and end are the first and last points of its path", () => {
    const model = modelOf(TESTFIELD, runWith(TESTFIELD.names, 2));
    for (const piece of timelineRailPieces(model, timelineLayout(model.arcs, model.bands))) {
      // 沿着 M / H / V / Q 走一遍（轨道段只用这四个命令），落点就是终点。
      const tokens = piece.d
        .replace(/([MHVQ])/g, " $1 ")
        .trim()
        .split(/[\s,]+/);
      let x = 0;
      let y = 0;
      let start: { x: number; y: number } | undefined;
      for (let i = 0; i < tokens.length; ) {
        const command = tokens[i++];
        if (command === "M") {
          x = Number(tokens[i++]);
          y = Number(tokens[i++]);
          start ??= { x, y };
        } else if (command === "H") x = Number(tokens[i++]);
        else if (command === "V") y = Number(tokens[i++]);
        else if (command === "Q") {
          i += 2;
          x = Number(tokens[i++]);
          y = Number(tokens[i++]);
        } else throw new Error(`unexpected path command ${command} in ${piece.d}`);
      }
      expect(start).toEqual(piece.start);
      expect({ x, y }).toEqual(piece.end);
    }
  });

  it("a band-level arc lives in the top air but its riser starts and lands on the main row", () => {
    const model = modelOf({ ...TESTFIELD, edges: [...TESTFIELD.edges, [2, 0]] });
    const view = renderTimeline(model);
    const rowY = timelineLayout(model.arcs, model.bands).rowY;
    expect(rowY).toEqual([58, 34]);
    const arc = view.getByTestId("workflow-timeline-arc");
    expect(arc.getAttribute("data-arc-from")).toBe("2");
    expect(arc.getAttribute("data-arc-to")).toBe("0");
    // 源在带外 → 从 C 的灯那一行（主线，58）起飞，7px 之上；车道在最上面那层空里（ly = 34 − 26 = 8）；
    // 目标是带 → 落在分叉点 x = 4 上，主线之上 4px——竖段一路穿过分支行，而不是停在它边上。
    expect(arc.querySelector("path")!.getAttribute("d")).toBe(
      "M413,51 V16 Q413,8 405,8 H12 Q4,8 4,16 V54",
    );
    expect(arc.querySelector("path")!.getAttribute("d")).toContain(`M413,${rowY[0]! - 7}`);
    expect(arc.querySelector("path")!.getAttribute("d")).toContain(`V${rowY[0]! - 4}`);
  });

  it("an arc inside one track stays in that track's air, lamp to lamp", () => {
    // 带 [[1], [2, 3]]：3 → 2 是同一条轨道上的回边，与带级的弧同住最上面那层空（R = 2），
    // 但它两端都是灯——认错了就会画成整条带的自环。
    const model = modelOf(INNER_LOOP);
    expect(model.bands[0]!.tracks.map((track) => track.stations)).toEqual([[1], [2, 3]]);
    expect(model.arcs).toEqual([{ air: 1, from: 3, ink: "faint", lane: 0, to: 2 }]);
    const view = renderTimeline(model);
    const arc = view.getByTestId("workflow-timeline-arc");
    expect(arc.querySelector("path")!.getAttribute("d")).toBe(
      "M593,27 V16 Q593,8 585,8 H409 Q401,8 401,16 V25",
    );
  });
});

describe("WorkflowTimeline without bands", () => {
  it("keeps the old DOM: rails are spans on the station row, no leaders, no platform row", () => {
    const model = modelOf({
      edges: [
        [0, 1],
        [1, 2],
      ],
      names: ["plan", "work", "verify"],
    });
    const view = renderTimeline(model);
    const rails = view.getAllByTestId("workflow-timeline-rail");
    expect(rails.map((rail) => rail.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(rails.map((rail) => rail.className)).toEqual([
      expect.stringContaining("border-foreground-subtlest"),
      expect.stringContaining("border-foreground-subtlest"),
    ]);
    expect(view.queryAllByTestId("workflow-timeline-leader")).toHaveLength(0);
    const stations = view.getAllByTestId("workflow-timeline-station") as HTMLElement[];
    // 站头还排在轨道行里：没有绝对定位，也没有轨道号。
    expect(stations.map((station) => station.getAttribute("data-station-track"))).toEqual([
      null,
      null,
      null,
    ]);
    expect(stations.map((station) => station.style.top)).toEqual(["", "", ""]);
    expect(stations[0]!.querySelector("[data-lamp]")).not.toBeNull();
    const box = view.getByTestId("workflow-timeline-scroller").firstElementChild as HTMLElement;
    expect(box.style.width).toBe("552px");
    expect(box.style.height).toBe(`${timelineHeight(model)}px`);
    expect(timelineHeight(model)).toBe(6 + 24 + 8 + 32 + 8);
  });
});

// ── 边檐：带压扁之后，并行的两站之间是一条双线段 ─────────────────────────────
const LEDGE_SPEC: GraphSpec = {
  alongside: { 1: [0] },
  edges: [0, 1, 2, 3, 4, 5, 6].map((i) => [i, i + 1] as const),
  names: ["A", "B", "C", "D", "E", "F", "G", "H"],
};
const VIEW = 960;
let scrollLeftStore = 0;

describe("WorkflowTimeline ledge with a band", () => {
  const scrollTo = vi.fn();
  beforeEach(() => {
    scrollLeftStore = 0;
    scrollTo.mockReset();
    const isScroller = (element: HTMLElement) =>
      element.dataset["testid"] === "workflow-timeline-scroller";
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? VIEW : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? timelineWidth(8, 12) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? scrollLeftStore : 0;
      },
      set(this: HTMLElement, value: number) {
        if (isScroller(this)) scrollLeftStore = value;
      },
    });
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
  });
  afterEach(() => {
    cleanup();
    for (const key of ["clientWidth", "scrollWidth", "scrollLeft"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it("folds A and B onto the left ledge and draws the twin between them as two 1px lines", async () => {
    const view = renderTimeline(modelOf(LEDGE_SPEC));
    scrollLeftStore = 400;
    await act(async () => {
      fireEvent.scroll(view.getByTestId("workflow-timeline-scroller"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    await waitFor(() => expect(view.getByTestId("workflow-timeline-ledge-left")).toBeTruthy());
    const ledge = view.getByTestId("workflow-timeline-ledge-left");
    const lamps = [...ledge.querySelectorAll("[data-testid='workflow-timeline-ledge-lamp']")];
    expect(lamps.map((lamp) => lamp.getAttribute("data-station-index"))).toEqual(["0", "1", "2"]);
    // A 与 B 之间是双线段；B 与 C 之间是汇合，画成一条普通的补线。
    const segments = [...ledge.querySelectorAll("[data-ledge-ink]")];
    expect(segments.map((segment) => segment.getAttribute("data-ledge-twin"))).toEqual([
      "true",
      null,
      null,
    ]);
    // 遮罩的轨道带一直盖到站台行的底（86 − 8 = 78），否则檐旁的名字会被硬切。
    expect(view.getByTestId("workflow-timeline-scroller").getAttribute("style")).toContain(
      "mask-position: 0 0, 0 78px",
    );
    const twin = segments[0]!;
    expect(twin.querySelectorAll("span")).toHaveLength(2);
    expect(
      [...twin.querySelectorAll("span")].map((line) => (line as HTMLElement).style.top),
    ).toEqual(["-1px", "1px"]);
  });
});
