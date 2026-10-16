// @vitest-environment jsdom

// 「还有 n 个」那一行（docs/dynamic-workflow/presentation.md「Past six participants」）：卡上名册站的
// 第六枚药丸——三张脸一叠、`还有 n 个`、藏着失败时一枚 `✕ n`、↗ 常驻；一扇门不是状态。侧板上同一具身体
// 是门（追记「一扇门与一卷名单」）：尾槽换下箭头、关着带其余人的计数行、开着计数行走人。
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  rosterCounts,
  rosterMore,
  rosterRestCounts,
  stationRoster,
} from "@/components/workflow-timeline/roster-model.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";

afterEach(() => {
  cleanup();
});

function pill(index: number, status: StepRunStatus | undefined): TimelinePill {
  return {
    key: `phase#a:actor#1@${index}`,
    avatarIndex: index,
    lane: { id: "actor#1", laneClass: "agent" },
    laneClass: "agent",
    runtimeName: `review-${index}`,
    status,
    instance: { ordinal: index, siteId: "actor#1", sessionId: `s-${index}` },
    slot: { ordinal: index, siteId: "actor#1" },
    stepIds: ["ask#1"],
  };
}
const pills = (statuses: readonly StepRunStatus[]) =>
  statuses.map((status, index) => pill(index + 1, status));

function renderRow(
  props: Parameters<typeof WorkflowMoreRow>[0],
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowMoreRow, props),
    ),
  );
}
const faceStates = (view: ReturnType<typeof renderRow>) =>
  [...view.getByTestId("workflow-more-deck").querySelectorAll("[data-face-state]")].map((face) =>
    face.getAttribute("data-face-state"),
  );

// 钉 5：running 3、6 → failed 4 → 补位 1、2；其余 5 done、7 pending、8 done、9 done。
const STATUSES: StepRunStatus[] = [
  "done",
  "done",
  "running",
  "failed",
  "done",
  "running",
  "pending",
  "done",
  "done",
];

describe("WorkflowMoreRow", () => {
  it("有回调是按钮、整行一个 title；三张脸按注意力序、表情带状态；↗ 常驻；点一下回调", () => {
    const onOpen = vi.fn();
    const more = rosterMore(stationRoster(pills(STATUSES), { pins: 5 })!);
    const view = renderRow({ enterDelayMs: 150, more, onOpen });
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    expect(row.getAttribute("data-more-count")).toBe("4");
    expect(row.textContent).toBe("4 more");
    expect(row.getAttribute("title")).toBe("4 more subagents · list everyone in the run pane");
    expect(row.getAttribute("aria-label")).toBe(row.getAttribute("title"));
    expect(row.className).toContain("wf-pill-open");
    expect(row.style.animationDelay).toBe("150ms");
    // 叠：pending 的 7 在 done 的 5、8 前面；每张带描边的类。
    expect(faceStates(view)).toEqual(["waiting", "content", "content"]);
    const faces = view.getByTestId("workflow-more-deck").querySelectorAll("[data-face-state]");
    expect([...faces].every((face) => face.classList.contains("wf-more-face"))).toBe(true);
    expect(view.getByTestId("workflow-more-open").className).toContain("wf-pill-go-rest");
    expect(view.queryByTestId("workflow-more-failed")).toBeNull();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("藏着失败时一枚红色 `✕ n`，失败的脸排在叠的最前；没有回调时是静态的 span", () => {
    // 六个 failed、一个 running 钉在最前：两个 failed 藏在这一行后面。
    const list = pills([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "done",
      "running",
    ]);
    const view = renderRow({ more: rosterMore(stationRoster(list, { pins: 5 })!) });
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("SPAN");
    expect(row.getAttribute("type")).toBeNull();
    expect(row.className).not.toContain("wf-pill-open");
    expect(row.getAttribute("data-more-count")).toBe("3");
    const failed = view.getByTestId("workflow-more-failed");
    expect(failed.textContent).toBe("2");
    expect(failed.getAttribute("title")).toBe("2 failed");
    expect(faceStates(view)).toEqual(["sad", "sad", "content"]);
  });

  it("zh-CN：「还有 n 个」与整句 title", () => {
    const more = rosterMore(stationRoster(pills(STATUSES), { pins: 5 })!);
    const view = renderRow({ more, onOpen: vi.fn() }, "zh-CN");
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.textContent).toBe("还有 4 个");
    expect(row.getAttribute("title")).toBe("还有 4 个子代理 · 在运行侧栏里列出全部");
  });

  // ── 门（侧板）──
  it("门关着：尾槽是下箭头、aria-expanded=false、带其余人的计数行（钉住的不算）、没有 ✕ n 徽记", () => {
    // 六个 running 占满钉位：其余是第六个 running、一个 failed、一个 done。
    const list = pills([
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "failed",
      "done",
    ]);
    const roster = stationRoster(list, { pins: 5 })!;
    const onOpen = vi.fn();
    const view = renderRow({
      door: { open: false, tally: rosterCounts(roster.rest) },
      more: rosterMore(roster),
      onOpen,
    });
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.getAttribute("data-door")).toBe("closed");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.getAttribute("title")).toBe("3 more subagents · list them here");
    expect(row.getAttribute("aria-label")).toBe(row.getAttribute("title"));
    expect(row.className).toContain("bg-surface");
    expect(row.className).not.toContain("bg-surface-hover");
    expect(view.queryByTestId("workflow-more-open")).toBeNull();
    expect(view.getByTestId("workflow-more-chevron").className).not.toContain("rotate-180");
    // 其余 = 一个 running、一个 failed、一个 done。
    const tally = view.getByTestId("workflow-roster-tally");
    const items = [...tally.querySelectorAll("[data-roster-count]")];
    expect(
      items.map((item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`),
    ).toEqual(["done:1", "running:1", "failed:1"]);
    expect(view.queryByTestId("workflow-more-failed")).toBeNull();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("门开着：计数行走人、箭头转 180°、底色抬一级、名字转前景、title 说收起；zh-CN 两种文案", () => {
    const roster = stationRoster(pills(STATUSES), { pins: 5 })!;
    const view = renderRow({
      door: { open: true, tally: rosterCounts(roster.rest) },
      more: rosterMore(roster),
      onOpen: vi.fn(),
    });
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.getAttribute("data-door")).toBe("open");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("title")).toBe("4 more subagents · fold");
    expect(row.className).toContain("bg-surface-hover");
    expect(view.queryByTestId("workflow-roster-tally")).toBeNull();
    expect(view.getByTestId("workflow-more-chevron").className).toContain("rotate-180");
    expect(row.querySelector(".wf-pill-name")!.className).toContain("text-foreground");
    expect(row.textContent).toBe("4 more");
    cleanup();

    const zh = renderRow(
      {
        door: { open: false, tally: rosterCounts(roster.rest) },
        more: rosterMore(roster),
        onOpen: vi.fn(),
      },
      "zh-CN",
    );
    expect(zh.getByTestId("workflow-roster-more-row").getAttribute("title")).toBe(
      "还有 4 个子代理 · 在这里列出",
    );
    cleanup();
    const zhOpen = renderRow(
      {
        door: { open: true, tally: rosterCounts(roster.rest) },
        more: rosterMore(roster),
        onOpen: vi.fn(),
      },
      "zh-CN",
    );
    expect(zhOpen.getByTestId("workflow-roster-more-row").getAttribute("title")).toBe(
      "还有 4 个子代理 · 收起",
    );
  });

  // ── 表外的那些（docs/dynamic-workflow/presentation.md「Past six participants」）──
  it("被淘汰的子代理也在这一行后面：人数与红 ✕ 把它们算进来，叠上的脸只有表内的", () => {
    const roster = stationRoster(
      pills(["running", "running", "running", "running", "running", "failed", "done"]),
      { pins: 5, unlisted: { actors: 10, failed: 3, settled: 10 } },
    )!;
    const view = renderRow({ more: rosterMore(roster) });
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.getAttribute("data-more-count")).toBe("12");
    // 行尾那枚红 ✕ 4 也在 textContent 里。
    expect(row.textContent).toBe("12 more4");
    expect(view.getByTestId("workflow-more-failed").textContent).toBe("4");
    expect(faceStates(view)).toEqual(["sad", "content"]);
    cleanup();

    // 侧板的门：关着时的计数行同样是「其余 + 表外」。
    const door = renderRow({
      door: { open: false, tally: rosterRestCounts(roster) },
      more: rosterMore(roster),
      onOpen: vi.fn(),
    });
    const items = [
      ...door.getByTestId("workflow-roster-tally").querySelectorAll("[data-roster-count]"),
    ];
    expect(
      items.map((item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`),
    ).toEqual(["done:8", "failed:4"]);
  });
});
