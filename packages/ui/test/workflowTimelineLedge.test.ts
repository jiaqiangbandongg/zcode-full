// @vitest-environment jsdom

// 边檐（docs/dynamic-workflow/presentation.md「Overflow: the ledge」）：纯几何（折叠不动点、檐宽、遮罩、
// 拇指）与 DOM（檐上的灯、折叠的站、点灯回镜头、← → 翻站）。jsdom 量不出尺寸，几何由原型 getter 假装。
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { draftTimeline, scanWorkflowDraft } from "@/components/workflow-timeline/draft-scan.js";
import {
  NO_FOLD,
  flightAfterScroll,
  foldStations,
  ledgeLamps,
  ledgeStubWidth,
  ledgeWidth,
  scrollbarThumb,
  stationCameraLeft,
  timelineMaskStyle,
} from "@/components/workflow-timeline/timeline-ledge.js";
import { timelineWidth } from "@/components/workflow-timeline/timeline-geometry.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("timeline-ledge geometry", () => {
  it("ledge width: none for none, lamps 16 apart with 8px pads, +n past three", () => {
    expect(ledgeWidth(0)).toBe(0);
    expect(ledgeWidth(1)).toBe(26);
    expect(ledgeWidth(3)).toBe(58);
    expect(ledgeWidth(4)).toBe(84);
  });

  it("folds nothing when the viewport is unmeasured", () => {
    expect(foldStations(8, 300, 0)).toBe(NO_FOLD);
    expect(foldStations(0, 0, 960)).toBe(NO_FOLD);
  });

  it("at the start, the three stations past the right edge fold; the fixpoint pulls none more", () => {
    // lamps at 17 + 192·i: verify (977), publish, wrap-up are past 960; revise (785) stays clear of 960 − 98.
    expect(foldStations(8, 0, 960)).toEqual({ left: [], right: [5, 6, 7] });
  });

  it("scrolled to the end, the fixpoint folds the station whose lamp sits under the growing ledge", () => {
    // review's lamp lands at 41: outside the first pass (x < 0) but under ledge(3) + fade = 98.
    expect(foldStations(8, 552, 960)).toEqual({ left: [0, 1, 2, 3], right: [] });
  });

  it("keep: the camera's target station never folds while the rest still do", () => {
    // 追记「草稿时间线的边檐误折」：镜头在飞时目标站不折——它就要进视野了，檐上闪一枚灯是误报。
    expect(foldStations(8, 0, 960, 5)).toEqual({ left: [], right: [6, 7] });
    expect(foldStations(8, 552, 960, 7)).toEqual({ left: [0, 1, 2, 3], right: [] });
  });

  it("a flight follows the scroll, lands within 1px, and ends when the scroll turns away", () => {
    const flight = { from: 360, index: 7, target: 552 };
    expect(flightAfterScroll(flight, 450)).toEqual({ from: 450, index: 7, target: 552 });
    expect(flightAfterScroll(flight, 551)).toBeUndefined();
    // 离目标比上一次采样更远：平滑滚动只会单调靠近，这是用户接手了。
    expect(flightAfterScroll(flight, 300)).toBeUndefined();
    expect(flightAfterScroll(undefined, 300)).toBeUndefined();
  });

  it("shows at most three lamps, nearest to the content, and counts the rest", () => {
    expect(ledgeLamps([0, 1, 2, 3, 4, 5, 6], "left")).toEqual({ shown: [4, 5, 6], more: 4 });
    expect(ledgeLamps([5, 6, 7, 8, 9, 10, 11], "right")).toEqual({
      shown: [5, 6, 7],
      more: 4,
    });
    expect(ledgeLamps([5, 6], "right")).toEqual({ shown: [5, 6], more: 0 });
  });

  it("stubs reach the first open lamp on the left and start at the slot end on the right", () => {
    const end = foldStations(8, 552, 960);
    // revise's lamp at 233; ledge(4) = three lamps + `+1`, inner edge at 84 − 8 = 76; 233 − 6 − 76.
    expect(ledgeStubWidth(end, "left", 552, 960)).toBe(151);
    expect(ledgeStubWidth(end, "right", 552, 960)).toBe(0);
    const start = foldStations(8, 0, 960);
    // revise's slot ends at 936; the ledge's inner edge is 960 − 50 = 910: shorter than 6 → none.
    expect(ledgeStubWidth(start, "right", 0, 960)).toBe(0);
  });

  it("masks in two bands: the rail row beside the ledge, the pills only at the viewport edge", () => {
    expect(timelineMaskStyle(NO_FOLD, 30, { left: false, right: false })).toBeUndefined();
    const start = timelineMaskStyle({ left: [], right: [5, 6, 7] }, 30, {
      left: false,
      right: true,
    });
    expect(start?.maskImage).toBe(
      "linear-gradient(90deg, #000 0px, #000 calc(100% - 106px), transparent calc(100% - 66px)), linear-gradient(90deg, #000 0px, #000 calc(100% - 40px), transparent 100%)",
    );
    expect(start?.maskSize).toBe("100% 30px, 100% calc(100% - 30px)");
    expect(start?.maskPosition).toBe("0 0, 0 30px");
    expect(start?.maskRepeat).toBe("no-repeat, no-repeat");
    expect(start?.WebkitMaskImage).toBe(start?.maskImage);
    // no ledge on a side that still overflows: the rail row fades at the edge like the pills do
    const plain = timelineMaskStyle(NO_FOLD, 30, { left: true, right: true });
    expect(plain?.maskImage).toBe(
      "linear-gradient(90deg, transparent 0px, #000 40px, #000 calc(100% - 40px), transparent 100%), linear-gradient(90deg, transparent 0px, #000 40px, #000 calc(100% - 40px), transparent 100%)",
    );
    const end = timelineMaskStyle({ left: [0, 1, 2, 3], right: [] }, 30, {
      left: true,
      right: false,
    });
    expect(end?.maskImage).toBe(
      "linear-gradient(90deg, transparent 92px, #000 132px, #000 100%), linear-gradient(90deg, transparent 0px, #000 40px, #000 100%)",
    );
  });

  it("thumb: viewport² / content, positioned by the scroll ratio, absent without overflow", () => {
    expect(scrollbarThumb(0, 960, 936)).toBeUndefined();
    expect(scrollbarThumb(0, 960, 0)).toBeUndefined();
    expect(scrollbarThumb(0, 960, 1512)).toEqual({ left: 0, width: 610 });
    expect(scrollbarThumb(552, 960, 1512)).toEqual({ left: 350, width: 610 });
    expect(scrollbarThumb(0, 100, 10_000)?.width).toBe(24);
  });

  it("camera centres a station and never scrolls past the start", () => {
    expect(stationCameraLeft(5, 960)).toBe(564);
    expect(stationCameraLeft(0, 960)).toBe(0);
  });

  it("has both locales for the ledge and scrollbar labels", () => {
    for (const key of [
      "chat.toolCall.workflow.timeline.ledge.earlier",
      "chat.toolCall.workflow.timeline.ledge.later",
      "chat.toolCall.workflow.timeline.scrollbar",
    ]) {
      expect(enUS[key as keyof typeof enUS]).toBeTruthy();
      expect(zhCN[key as keyof typeof zhCN]).toBeTruthy();
    }
  });
});

const NAMES = ["scope", "survey", "draft", "review", "revise", "verify", "publish", "wrap-up"];
const GRAPH: WorkflowCausalityGraphData = {
  steps: NAMES.map((name, i) => ({
    id: `ask#${i + 1}`,
    kind: "ask",
    label: name,
    line: i + 1,
    column: 1,
    lane: "actor#1",
    phase: `phase#${i + 1}`,
  })),
  lanes: [{ id: "actor#1", name: "worker", line: 1, column: 1 }],
  participants: NAMES.map((_, i) => ({
    id: `phase#${i + 1}:actor#1`,
    phase: `phase#${i + 1}`,
    lane: "actor#1",
    steps: [`ask#${i + 1}`],
  })),
  handoffs: [],
  phases: NAMES.map((name, i) => ({ id: `phase#${i + 1}`, name, line: i + 1, column: 1 })),
  phaseEdges: NAMES.slice(1).map((_, i) => ({ from: `phase#${i + 1}`, to: `phase#${i + 2}` })),
  exits: ["phase#8"],
} as WorkflowCausalityGraphData;

const VIEW = 960;
const SCROLLER = "workflow-timeline-scroller";
let scrollLeftStore = 0;

function fakeGeometry(
  contentWidth: (scroller: HTMLElement) => number = () => timelineWidth(NAMES.length),
) {
  const isScroller = (element: HTMLElement) => element.dataset["testid"] === SCROLLER;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? VIEW : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? contentWidth(this) : 0;
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
}

describe("WorkflowTimeline ledge", () => {
  const scrollTo = vi.fn();
  beforeEach(() => {
    scrollLeftStore = 0;
    scrollTo.mockReset();
    fakeGeometry();
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
  });
  afterEach(() => {
    cleanup();
    for (const key of ["clientWidth", "scrollWidth", "scrollLeft"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  function renderTimeline(onSelectStation?: () => void) {
    const model = buildWorkflowTimeline(GRAPH, undefined);
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowTimeline, {
          model,
          ...(onSelectStation === undefined ? {} : { onSelectStation }),
        }),
      ),
    );
  }

  async function scrollBy(view: ReturnType<typeof render>, left: number) {
    scrollLeftStore = left;
    await act(async () => {
      fireEvent.scroll(view.getByTestId(SCROLLER));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
  }

  it("folds the stations past the right edge onto the right ledge and masks that side only", async () => {
    const view = renderTimeline();
    await waitFor(() => expect(view.getByTestId("workflow-timeline-ledge-right")).toBeTruthy());
    expect(view.queryByTestId("workflow-timeline-ledge-left")).toBeNull();
    expect(view.container.querySelector("[data-ledge-ink]")?.className).toContain("border-t");
    expect(view.container.querySelector("[data-ledge-ink]")?.className).toContain(
      "border-foreground-subtlest",
    );
    const lamps = view.getAllByTestId("workflow-timeline-ledge-lamp");
    expect(lamps.map((lamp) => lamp.getAttribute("data-station-index"))).toEqual(["5", "6", "7"]);
    expect(lamps[0]?.getAttribute("title")).toBe("verify · pending");
    const stations = view.getAllByTestId("workflow-timeline-station");
    expect(stations[5]?.getAttribute("data-station-folded")).toBe("true");
    expect(stations[4]?.getAttribute("data-station-folded")).toBeNull();
    expect(view.getByTestId(SCROLLER).getAttribute("data-timeline-fade")).toBe("right");
    expect(view.queryByTestId("workflow-rank-strip")).toBeNull();
    expect(view.getByTestId("workflow-timeline-scrollbar")).toBeTruthy();
  });

  it("re-folds on scroll: the left ledge takes the stations that left, and the fixpoint takes review", async () => {
    const view = renderTimeline();
    await scrollBy(view, 552);
    await waitFor(() => expect(view.getByTestId("workflow-timeline-ledge-left")).toBeTruthy());
    expect(view.queryByTestId("workflow-timeline-ledge-right")).toBeNull();
    const lamps = view.getAllByTestId("workflow-timeline-ledge-lamp");
    expect(lamps.map((lamp) => lamp.getAttribute("data-station-index"))).toEqual(["1", "2", "3"]);
    expect(view.getByTestId("workflow-timeline-ledge-more").textContent).toBe("+1");
    expect(view.getByTestId("workflow-timeline-scrollbar").getAttribute("data-scrolling")).toBe(
      "true",
    );
    const thumb = view.getByTestId("workflow-timeline-scrollbar-thumb");
    expect(thumb.style.left).toBe("350px");
    expect(thumb.style.width).toBe("610px");
    expect(view.getByTestId(SCROLLER).getAttribute("data-timeline-fade")).toBe("left");
  });

  it("the scrollbar keeps its clicks: dragging the thumb or paging the track never reaches the host card", async () => {
    // 宿主卡（轮尾摘要）把空白处的 click 当折叠；拖完拇指浏览器会补发 click，它不能冒上去。
    const onHostClick = vi.fn();
    const model = buildWorkflowTimeline(GRAPH, undefined);
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement("div", { onClick: onHostClick }, createElement(WorkflowTimeline, { model })),
      ),
    );
    await waitFor(() => expect(view.getByTestId("workflow-timeline-scrollbar")).toBeTruthy());
    const thumb = view.getByTestId("workflow-timeline-scrollbar-thumb");
    // jsdom 没有指针捕获。
    thumb.setPointerCapture = vi.fn();
    thumb.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(thumb, { pointerId: 1, clientX: 160 });
    fireEvent.click(thumb);
    fireEvent.click(view.getByTestId("workflow-timeline-scrollbar"));
    expect(onHostClick).not.toHaveBeenCalled();
    // 对照：时间线上真正的空白处仍然把 click 交给宿主。
    fireEvent.click(view.getByTestId(SCROLLER));
    expect(onHostClick).toHaveBeenCalledOnce();
  });

  it("a ledge lamp brings its station back to the centre", async () => {
    const view = renderTimeline();
    await waitFor(() => expect(view.getByTestId("workflow-timeline-ledge-right")).toBeTruthy());
    fireEvent.click(view.getAllByTestId("workflow-timeline-ledge-lamp")[2]!);
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: stationCameraLeft(7, VIEW) }),
    );
  });

  it("← → on a focused station head scroll one station", async () => {
    const view = renderTimeline(() => {});
    await waitFor(() => expect(view.getByTestId("workflow-timeline-ledge-right")).toBeTruthy());
    const head = view.getAllByTestId("workflow-timeline-station")[1]!.querySelector("button")!;
    fireEvent.keyDown(head, { key: "ArrowRight" });
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 192 }));
    scrollLeftStore = 400;
    fireEvent.keyDown(head, { key: "ArrowLeft" });
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 208 }));
  });

  it("without overflow nothing folds, fades or scrolls", () => {
    // 缺省原型：clientWidth 0 = 量不到，与静态测试同一路。
    for (const key of ["clientWidth", "scrollWidth", "scrollLeft"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
    const view = renderTimeline();
    expect(view.queryByTestId("workflow-timeline-ledge-right")).toBeNull();
    expect(view.queryByTestId("workflow-timeline-scrollbar")).toBeNull();
    expect(view.getByTestId(SCROLLER).getAttribute("data-timeline-fade")).toBeNull();
    expect(view.container.querySelector(".wf-folded")).toBeNull();
  });
});

describe("WorkflowTimeline draft ledge", () => {
  // 追记「草稿时间线的边檐误折」：草稿首帧没有站（笔从 0 起步），滚动层晚一帧才挂上；内容宽随笔的揭示增长；
  // 镜头的 scrollTo 像浏览器的平滑滚动一样 150ms 后才落地、落地才派发 scroll。
  const DRAFT = NAMES.map((name) => `await phase("${name}")`).join("\n");
  const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    const max = this.scrollWidth - this.clientWidth;
    setTimeout(() => {
      scrollLeftStore = Math.max(0, Math.min(options.left ?? 0, max));
      this.dispatchEvent(new Event("scroll"));
    }, 150);
  });
  beforeEach(() => {
    scrollLeftStore = 0;
    scrollTo.mockClear();
    fakeGeometry((scroller) =>
      timelineWidth(scroller.querySelectorAll("[data-testid='workflow-timeline-station']").length),
    );
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    for (const key of ["clientWidth", "scrollWidth", "scrollLeft"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }
  async function until(view: ReturnType<typeof render>, done: () => boolean) {
    for (let elapsed = 0; elapsed < 10_000 && !done(); elapsed += 10) await advance(10);
    expect(done()).toBe(true);
  }
  const stationCount = (view: ReturnType<typeof render>) =>
    view.queryAllByTestId("workflow-timeline-station").length;

  it("the pen writes past the viewport: the newest station never folds, and the ledge answers a user scroll", async () => {
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowTimeline, { model: draftTimeline(scanWorkflowDraft(DRAFT)) }),
      ),
    );
    // 第六站一揭示就溢出，镜头起飞；落地前（150ms 内）最新站不折、右檐缺席，镜头恰好把它贴到右缘。
    await until(view, () => stationCount(view) === 6);
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: timelineWidth(6) - VIEW }),
    );
    expect(view.queryByTestId("workflow-timeline-ledge-right")).toBeNull();
    expect(view.container.querySelector(".wf-folded")).toBeNull();

    // 笔写完、镜头落地：滚动层在最右（没有 24px 过冲），什么都没折到右檐；左檐接住了滚过去的站。
    await until(
      view,
      () => view.queryByTestId("workflow-timeline-caret")?.dataset["pen"] === "idle",
    );
    await advance(200);
    expect(stationCount(view)).toBe(8);
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: timelineWidth(8) - VIEW }),
    );
    expect(scrollLeftStore).toBe(timelineWidth(8) - VIEW);
    expect(view.queryByTestId("workflow-timeline-ledge-right")).toBeNull();
    const landed = view.getAllByTestId("workflow-timeline-station");
    expect(landed[7]?.getAttribute("data-station-folded")).toBeNull();
    expect(landed[0]?.getAttribute("data-station-folded")).toBe("true");
    expect(view.getByTestId("workflow-timeline-ledge-left")).toBeTruthy();
    expect(view.getByTestId(SCROLLER).getAttribute("data-timeline-fade")).toBe("left");

    // 用户把它滚回起点：监听真的接上了——右檐出现、最新站折进去、左檐退场。
    scrollLeftStore = 0;
    await act(async () => {
      view.getByTestId(SCROLLER).dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(20);
    });
    expect(view.getByTestId("workflow-timeline-ledge-right")).toBeTruthy();
    expect(view.queryByTestId("workflow-timeline-ledge-left")).toBeNull();
    const stations = view.getAllByTestId("workflow-timeline-station");
    expect(stations[7]?.getAttribute("data-station-folded")).toBe("true");
    expect(stations[4]?.getAttribute("data-station-folded")).toBeNull();
  });
});
