// @vitest-environment jsdom

// 名册的两件小零件（docs/dynamic-workflow/presentation.md「Past six participants」、「一扇门与一卷名单」）：
// 计数行只列非零项、每项 title 是整句；量条段序与段宽按计数、迷你版同一份 aria 文案。
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { RosterMeter, RosterTally } from "@/components/workflow-timeline/WorkflowRosterParts.js";

afterEach(() => {
  cleanup();
});

function renderPart(
  element: ReturnType<typeof createElement>,
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(createElement(ZCodeIntlProvider, { initialLocale: locale }, element));
}

describe("RosterTally", () => {
  it("只列非零项，顺序 done · running · failed · pending；每项 title 是整句；可加 className", () => {
    const view = renderPart(
      createElement(RosterTally, {
        className: "mr-0.5",
        counts: { done: 6, failed: 1, pending: 0, running: 2 },
      }),
    );
    const tally = view.getByTestId("workflow-roster-tally");
    expect(tally.className).toContain("mr-0.5");
    const items = [...tally.querySelectorAll("[data-roster-count]")];
    expect(items.map((item) => item.getAttribute("data-roster-count"))).toEqual([
      "done",
      "running",
      "failed",
    ]);
    expect(items.map((item) => item.textContent)).toEqual(["6", "2", "1"]);
    expect(items[2]!.getAttribute("title")).toBe("1 failed");
  });

  it("zh-CN：整句 title 本地化", () => {
    const view = renderPart(
      createElement(RosterTally, { counts: { done: 0, failed: 0, pending: 4, running: 0 } }),
      "zh-CN",
    );
    const items = [
      ...view.getByTestId("workflow-roster-tally").querySelectorAll("[data-roster-count]"),
    ];
    expect(items).toHaveLength(1);
    expect(items[0]!.getAttribute("title")).toBe("4 个待开始");
  });
});

describe("RosterMeter", () => {
  it("段序 done · failed · running · pending，零段缺席，段宽按计数；role=img 带整句", () => {
    const view = renderPart(
      createElement(RosterMeter, { counts: { done: 6, failed: 1, pending: 0, running: 2 } }),
    );
    const meter = view.getByTestId("workflow-roster-meter");
    expect(meter.getAttribute("role")).toBe("img");
    expect(meter.getAttribute("aria-label")).toBe("6 done, 2 running, 1 failed, 0 pending");
    const segments = [...meter.querySelectorAll("[data-meter-segment]")];
    expect(segments.map((segment) => segment.getAttribute("data-meter-segment"))).toEqual([
      "done",
      "failed",
      "running",
    ]);
    expect((segments[0] as HTMLElement).style.flexGrow).toBe("6");
    expect(segments[0]!.className).toContain("wf-meter-seg");
  });

  it("迷你量条：折叠节头上的 44 px 版本，同一份 aria 文案", () => {
    const view = renderPart(
      createElement(RosterMeter, {
        counts: { done: 40, failed: 2, pending: 0, running: 6 },
        mini: true,
      }),
      "zh-CN",
    );
    const meter = view.getByTestId("workflow-roster-meter-mini");
    expect(meter.className).toContain("w-11");
    expect(meter.getAttribute("aria-label")).toBe(
      "40 个已完成, 6 个运行中, 2 个已失败, 0 个待开始",
    );
  });
});
