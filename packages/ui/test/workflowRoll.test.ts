// @vitest-environment jsdom

// 门后的名单（docs/dynamic-workflow/presentation.md「The spine」）：按状态分组、组头是计数行
// 的那一项、行由调用方渲染、依次落地 8 ms 封顶 400。
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { rosterRoll, stationRoster } from "@/components/workflow-timeline/roster-model.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowAgentPill } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import {
  ROW_STAGGER_CAP_MS,
  ROW_STAGGER_MS,
  WorkflowRoll,
} from "@/components/workflow-timeline/WorkflowRoll.js";

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
const pills = (statuses: readonly (StepRunStatus | undefined)[]) =>
  statuses.map((status, index) => pill(index + 1, status));

function renderRoll(list: TimelinePill[], locale: "en-US" | "zh-CN" = "en-US", unlisted?: number) {
  const roster = stationRoster(list, { pins: 5 })!;
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRoll, {
        groups: rosterRoll(roster),
        ...(unlisted === undefined ? {} : { unlisted }),
        renderRow: (entry: TimelinePill, enterDelayMs: number) =>
          createElement(WorkflowAgentPill, {
            enterDelayMs,
            key: entry.key,
            laneClass: entry.laneClass,
            name: entry.runtimeName ?? "",
            open: { label: `open ${entry.runtimeName}`, onOpen: () => {} },
            size: "row",
            status: entry.status,
          }),
      }),
    ),
  );
}

describe("WorkflowRoll", () => {
  it("组序 failed → running → pending → done、空组缺席；组头带人数与状态词、语义色；两列", () => {
    // 钉 5：running 3、8 → failed 4、9 → 补位 1；其余 2 5 6 7 10 11。
    const view = renderRoll(
      pills([
        "done",
        "done",
        "running",
        "failed",
        "pending",
        "done",
        "done",
        "running",
        "failed",
        undefined,
        "done",
      ]),
    );
    const roll = view.getByTestId("workflow-roster-roll");
    expect(roll.className).toContain("grid-cols-2");
    const headings = view.getAllByTestId("workflow-roll-heading");
    expect(headings.map((heading) => heading.getAttribute("data-roll-group"))).toEqual([
      "pending",
      "done",
    ]);
    expect(headings.map((heading) => heading.textContent)).toEqual(["2pending", "4done"]);
    expect(headings[0]!.className).toContain("text-foreground-subtlest");
    expect(headings[1]!.className).toContain("text-success");
    expect(headings[1]!.getAttribute("role")).toBe("heading");
    // 每组的人数加粗、状态词照常。
    expect(headings[1]!.querySelector(".font-medium")!.textContent).toBe("4");
    const rows = view.getAllByTestId("workflow-agent-pill");
    expect(rows.map((row) => row.getAttribute("title"))).toEqual([
      "review-5",
      "review-10",
      "review-2",
      "review-6",
      "review-7",
      "review-11",
    ]);
    expect(rows.every((row) => row.getAttribute("data-pill-size") === "row")).toBe(true);
    expect(rows.every((row) => row.tagName === "BUTTON")).toBe(true);
    // 行在组头之后、依次落地。
    expect(rows[0]!.style.animationDelay).toBe("");
    expect(rows[1]!.style.animationDelay).toBe(`${ROW_STAGGER_MS}ms`);
    expect(rows[5]!.style.animationDelay).toBe(`${ROW_STAGGER_MS * 5}ms`);
  });

  it("落地延迟封顶 400 ms；zh-CN 组头本地化", () => {
    const many = Array.from({ length: 70 }, (_, i) => pill(i + 1, "done"));
    const view = renderRoll(many, "zh-CN");
    const rows = view.getAllByTestId("workflow-agent-pill");
    expect(rows).toHaveLength(65);
    expect(rows[64]!.style.animationDelay).toBe(`${ROW_STAGGER_CAP_MS}ms`);
    expect(ROW_STAGGER_MS * 64).toBeGreaterThan(ROW_STAGGER_CAP_MS);
    const heading = view.getByTestId("workflow-roll-heading");
    expect(heading.textContent).toBe("65个已完成");
    expect(heading.querySelector(".font-medium")!.textContent).toBe("65");
  });

  // 表外的那些（docs/dynamic-workflow/presentation.md「The spine」）：它们没有行，
  // 所以名单末尾说一句差额，而不是假装那些行在。
  it("表外的子代理在末尾一行淡字里交代，不占行、不进组头；没有时这一行缺席", () => {
    const list = pills(Array(9).fill("done"));
    expect(renderRoll(list).queryByTestId("workflow-roll-unlisted")).toBeNull();
    cleanup();
    expect(renderRoll(list, "en-US", 0).queryByTestId("workflow-roll-unlisted")).toBeNull();
    cleanup();

    const view = renderRoll(list, "en-US", 300);
    const line = view.getByTestId("workflow-roll-unlisted");
    expect(line.textContent).toBe("300 more agents not listed");
    expect(line.className).toContain("text-foreground-subtlest");
    // 组头照旧只数它下面的行；名单里也没有多出来的行。
    expect(view.getByTestId("workflow-roll-heading").textContent).toBe("4done");
    expect(view.getAllByTestId("workflow-agent-pill")).toHaveLength(4);
    cleanup();

    expect(renderRoll(list, "en-US", 1).getByTestId("workflow-roll-unlisted").textContent).toBe(
      "1 more agent not listed",
    );
    cleanup();
    expect(renderRoll(list, "zh-CN", 300).getByTestId("workflow-roll-unlisted").textContent).toBe(
      "另有 300 个子代理未列出",
    );
  });
});
