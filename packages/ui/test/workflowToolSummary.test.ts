// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";

const summary = {
  runId: "run-1",
  toolCallId: "tool-1",
  status: "running" as const,
  nodesTotal: 3,
  nodesSettled: 1,
  agents: 3,
};
afterEach(cleanup);
describe("WorkflowToolSummary", () => {
  it.each(["en-US", "zh-CN"] as const)("本地化子代理数并通过普通摘要打开详情：%s", (locale) => {
    const onOpen = vi.fn();
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(WorkflowToolSummary, { toolCallId: "tool-1", summary, onOpen }),
      ),
    );
    expect(view.container.textContent).toContain(locale === "en-US" ? "3 agents" : "3 个子代理");
    expect(view.container.textContent).not.toContain("step");
    const trigger = view.getByRole("button");
    expect(trigger.className).toContain("group/tool-summary");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(view.container.querySelector("[aria-expanded]")).toBeNull();
    expect(view.queryByTestId("workflow-timeline-station")).toBeNull();
  });
  it.each([
    ["en-US", "Workflow amended"],
    ["zh-CN", "工作流已调整"],
  ] as const)("修订行的种类词是「工作流已调整」：%s", (locale, word) => {
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(WorkflowToolSummary, { toolCallId: "tool-1", summary, amend: true }),
      ),
    );
    expect(view.container.textContent).toContain(word);
    expect(view.container.textContent).toContain(locale === "en-US" ? "3 agents" : "3 个子代理");
  });
  it("宿主缺少打开能力时只展示文字", () => {
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowToolSummary, { toolCallId: "tool-1", summary }),
      ),
    );
    expect(view.queryByRole("button")).toBeNull();
    expect(view.container.textContent).toContain("3 agents");
  });
  it("摘要没带子代理数：不写计数，也不写步数", () => {
    const { agents: _dropped, ...bare } = summary;
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowToolSummary, { toolCallId: "tool-1", summary: bare }),
      ),
    );
    expect(view.getByTestId("workflow-summary-agents").textContent).toBe("");
    expect(view.container.textContent).not.toContain("step");
  });
});
