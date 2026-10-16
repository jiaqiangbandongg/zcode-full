// @vitest-environment jsdom

// 子代理药丸（docs/dynamic-workflow/presentation.md「The pill」）：可打开时整枚是按钮，
// 悬停语法挂在 wf-pill-open 上、↗ 是可见证据；不可打开时是 span，inertTitle 解释为什么。
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  WorkflowAgentPill,
  avatarColor,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";

afterEach(() => {
  cleanup();
});

function renderPill(props: Parameters<typeof WorkflowAgentPill>[0]) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowAgentPill, props),
    ),
  );
}

function view_state(props: { status: Parameters<typeof WorkflowAgentPill>[0]["status"] }) {
  const view = renderPill({ laneClass: "agent", name: "Ada", avatarIndex: 0, ...props });
  const state = view.container
    .querySelector("svg[data-subagent-avatar]")!
    .getAttribute("data-face-state");
  view.unmount();
  return state;
}

describe("WorkflowAgentPill", () => {
  it("前九个编号的脸色相互不相同，第十个循环；表情读 status", () => {
    const hues = Array.from({ length: 10 }, (_, avatarIndex) => {
      const view = renderPill({ laneClass: "agent", name: "same", avatarIndex, status: "done" });
      const face = view.container.querySelector("svg[data-subagent-avatar]") as SVGSVGElement;
      expect(face.getAttribute("data-face-state")).toBe("content");
      const hue = face.style.getPropertyValue("--wf-face-body");
      view.unmount();
      return hue;
    });
    expect(new Set(hues.slice(0, 9)).size).toBe(9);
    expect(hues[9]).toBe(hues[0]);
    expect(view_state({ status: undefined })).toBe("waiting");
    expect(view_state({ status: "running" })).toBe("scanning");
    expect(view_state({ status: "failed" })).toBe("sad");
  });
  it("可打开：<button> + wf-pill-open + aria-label + ↗，点击走 onOpen", () => {
    const onOpen = vi.fn();
    const view = renderPill({
      laneClass: "agent",
      name: "Ada",
      open: {
        label: "Open the transcript of Ada",
        onOpen,
        data: { "data-agent-key": "actor#1@1" },
      },
      status: "running",
    });
    const pill = view.getByTestId("workflow-agent-pill");
    expect(view.getByTestId("workflow-pill-status").className).toContain("text-foreground-subtle");
    expect(view.getByTestId("workflow-pill-status").className).not.toContain("text-warning");
    expect(pill.querySelector(":scope > svg[data-subagent-avatar]")).not.toBeNull();
    expect(pill.querySelector("img")).toBeNull();
    expect(pill.querySelector(".wf-pill-avatar")).toBeNull();
    expect(pill.className).toContain("rounded-full");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("type")).toBe("button");
    expect(pill.getAttribute("aria-label")).toBe("Open the transcript of Ada");
    expect(pill.getAttribute("data-agent-open")).toBe("true");
    expect(pill.className).toContain("wf-pill-open");
    const go = view.getByTestId("workflow-pill-open");
    expect(go.getAttribute("data-agent-key")).toBe("actor#1@1");
    // ↗ 与状态标记叠在同一个尾槽里（悬停时顶替它），不在标记旁边另占一格。
    const tail = view.getByTestId("workflow-pill-tail");
    expect(tail.contains(go)).toBe(true);
    expect(tail.contains(view.getByTestId("workflow-pill-status"))).toBe(true);
    fireEvent.click(pill);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("尾槽只在有东西可放时在场：无标记且不可打开的药丸（草稿 / 工作区）没有尾槽", () => {
    const inert = renderPill({ laneClass: "workspace", name: "Workspace", status: undefined });
    expect(inert.queryByTestId("workflow-pill-tail")).toBeNull();
    inert.unmount();

    // 有标记、不可打开：尾槽只装标记——脚本药丸的对勾与子代理药丸的落在同一条右缘。
    const marked = renderPill({ laneClass: "workspace", name: "Workspace", status: "done" });
    const tail = marked.getByTestId("workflow-pill-tail");
    expect(tail.contains(marked.getByTestId("workflow-pill-status"))).toBe(true);
    expect(marked.queryByTestId("workflow-pill-open")).toBeNull();
  });

  it("不可打开：<span>、没有 ↗、没有悬停类；inertTitle 成为 tooltip", () => {
    const view = renderPill({
      inertTitle: "Transcript starts when the subagent does",
      laneClass: "agent",
      name: "checker",
      status: undefined,
    });
    const pill = view.getByTestId("workflow-agent-pill");
    expect(pill.tagName).toBe("SPAN");
    expect(pill.getAttribute("data-agent-open")).toBeNull();
    expect(pill.className).not.toContain("wf-pill-open");
    expect(view.queryByTestId("workflow-pill-open")).toBeNull();
    expect(pill.getAttribute("title")).toBe("Transcript starts when the subagent does");
  });

  it("到场与弹入：药丸带 wf-arrive，状态标记带 wf-mark 且带可读文字", () => {
    const view = renderPill({ laneClass: "agent", name: "Ada", status: "done" });
    expect(view.getByTestId("workflow-agent-pill").className).toContain("wf-arrive");
    const mark = view.getByTestId("workflow-pill-status");
    expect(mark.className).toContain("wf-mark");
    expect(mark.getAttribute("aria-label")).toBe("done");
    expect(mark.className).toContain("text-foreground-subtle");
    expect(mark.className).not.toContain("text-success");
  });

  it("脚本药丸没有头像色相；子代理悬停色相与脸同源：编号优先，无编号退回名字散列", () => {
    const view = renderPill({ laneClass: "workspace", name: "Workspace", status: undefined });
    expect(view.getByTestId("workflow-agent-pill").getAttribute("style")).toBeNull();
    expect(view.container.querySelector("svg[data-subagent-avatar]")).toBeNull();
    expect(avatarColor("Ada")).toBe(avatarColor("Ada"));
    expect(avatarColor("Ada")).not.toBe(avatarColor("Bob"));
    view.unmount();
    const numbered = renderPill({
      laneClass: "agent",
      name: "Ada",
      avatarIndex: 2,
      status: "done",
    });
    expect(numbered.getByTestId("workflow-agent-pill").getAttribute("style")).toContain("#6464EF");
    numbered.unmount();
    const unnumbered = renderPill({ laneClass: "agent", name: "Ada", status: "done" });
    expect(unnumbered.getByTestId("workflow-agent-pill").getAttribute("style")).toContain(
      avatarColor("Ada"),
    );
  });
});
