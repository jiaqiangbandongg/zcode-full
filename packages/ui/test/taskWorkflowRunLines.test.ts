// @vitest-environment jsdom

// 侧栏运行行的 DOM（docs/dynamic-workflow/presentation.md「The sidebar run line」）：图标 + 迷你轨道 +
// 当前 phase 名；隐含站点；结束行的中性词；确认折叠；点击 = 打开 run（不冒泡成普通选中）。
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionWorkflowActivity,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  createWorkflowRunAckStore,
  setWorkflowRunAckStoreForTesting,
  type WorkflowRunAckStore,
} from "@/lib/workflowRunAckStore.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";

const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
    switch (id) {
      case "chat.toolCall.workflow.graph.phase.workflow":
        return "Workflow";
      case "chat.toolCall.workflow.run.status.running":
        return "Running";
      case "chat.toolCall.workflow.run.status.pending":
        return "Pending";
      case "chat.toolCall.workflow.run.status.completed":
        return "Completed";
      case "chat.toolCall.workflow.run.status.errored":
        return "Errored";
      case "chat.toolCall.workflow.run.status.stopped":
        return "Stopped";
      case "chat.toolCall.workflow.run.stopReason.user":
        return "by you";
      case "taskList.workflowRun.moreRuns":
        return `+${values?.count} more`;
      case "taskList.workflowRun.moreStations":
        return `+${values?.count}`;
      default:
        return id;
    }
  },
};

const SESSION = { workspacePath: "/ws", sessionId: "s1" };

function run(
  overrides: Partial<SessionWorkflowRunSummary> & { runId: string },
): SessionWorkflowRunSummary {
  return { status: "running", phases: [], agentsWorking: 0, ...overrides };
}

function wrap(node: ReactNode, onOpenRun?: (target: WorkflowRunOpenTarget) => void) {
  const inner = onOpenRun ? createElement(WorkflowRunOpenProvider, { onOpenRun }, node) : node;
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(TooltipProvider, null, inner),
  );
}

let store: WorkflowRunAckStore;

beforeEach(() => {
  store = createWorkflowRunAckStore(null);
  setWorkflowRunAckStoreForTesting(store);
});

afterEach(() => {
  cleanup();
  setWorkflowRunAckStoreForTesting(null);
});

describe("TaskWorkflowRunLines", () => {
  it("draws the rail in declared order with the current phase name on the line", () => {
    const activity: SessionWorkflowActivity = {
      runs: [
        run({
          runId: "r1",
          toolCallId: "tc-1",
          name: "Deep research",
          phases: [
            { name: "Research", status: "done" },
            { name: "Draft", status: "running" },
            { name: "Review", status: "pending" },
          ],
          currentPhase: "Draft",
          agentsWorking: 2,
        }),
      ],
    };
    const { container } = render(
      wrap(
        createElement(TaskWorkflowRunLines, { activity, isActive: false, intl, session: SESSION }),
      ),
    );
    const line = container.querySelector<HTMLElement>("[data-workflow-run-line]");
    expect(line?.dataset.runStatus).toBe("running");
    expect(line?.tagName).toBe("SPAN");
    expect(line?.textContent).toBe("Draft");
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-rail-station]")).map(
        (station) => station.dataset.railStation,
      ),
    ).toEqual(["done", "running", "pending"]);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-rail-segment]")).map(
        (segment) => segment.dataset.railSegment,
      ),
    ).toEqual(["strong", "faint"]);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("a station entered beside the previous one rides a twin segment", () => {
    const activity: SessionWorkflowActivity = {
      runs: [
        run({
          runId: "r1",
          phases: [
            { name: "A", status: "done" },
            { name: "B", status: "running", alongside: [0] },
            { name: "C", status: "pending" },
          ],
          currentPhase: "B",
        }),
      ],
    };
    const { container } = render(
      wrap(createElement(TaskWorkflowRunLines, { activity, isActive: false, intl })),
    );
    const segments = Array.from(container.querySelectorAll<HTMLElement>("[data-rail-segment]"));
    // 段数不变（每站之前一段），墨色规则不变：进 B 的那段是双线，进 C 的那段是普通段。
    expect(segments.map((segment) => segment.dataset.railSegment)).toEqual(["strong", "faint"]);
    expect(segments.map((segment) => segment.dataset.railTwin)).toEqual(["true", undefined]);
    // 双线段真的是两条 1px 线（相距 2px），而不是一条加了属性的线。
    expect(segments[0]!.childElementCount).toBe(2);
    expect(segments[1]!.childElementCount).toBe(0);
  });

  it("a script without phases draws the implicit Workflow station", () => {
    const { container } = render(
      wrap(
        createElement(TaskWorkflowRunLines, {
          activity: { runs: [run({ runId: "r1" })] },
          isActive: false,
          intl,
        }),
      ),
    );
    expect(container.querySelector("[data-workflow-run-rail]")?.getAttribute("data-implicit")).toBe(
      "true",
    );
    expect(container.querySelector("[data-workflow-run-line]")?.textContent).toBe("Workflow");
  });

  it("past six stations the rail folds to five lamps and a +n tail", () => {
    const phases = Array.from({ length: 9 }, (_, index) => ({
      name: `p${index}`,
      status:
        index < 4 ? ("done" as const) : index === 4 ? ("running" as const) : ("pending" as const),
    }));
    const { container } = render(
      wrap(
        createElement(TaskWorkflowRunLines, {
          activity: { runs: [run({ runId: "r1", phases, currentPhase: "p4" })] },
          isActive: false,
          intl,
        }),
      ),
    );
    expect(container.querySelectorAll("[data-rail-station]")).toHaveLength(5);
    expect(container.querySelector("[data-workflow-run-rail]")?.textContent).toBe("+4");
  });

  it("ended runs show a neutral word, and linger only until acknowledged", () => {
    const activity: SessionWorkflowActivity = {
      runs: [
        run({ runId: "err", status: "errored", currentPhase: "Draft" }),
        run({ runId: "stop", status: "stopped", stopReason: "user" }),
        run({ runId: "done", status: "completed" }),
      ],
    };
    const { container, rerender } = render(
      wrap(createElement(TaskWorkflowRunLines, { activity, isActive: false, intl })),
    );
    const texts = () =>
      Array.from(container.querySelectorAll("[data-workflow-run-line]")).map(
        (line) => line.textContent,
      );
    expect(texts()).toEqual(["Errored · Draft", "Stopped · by you"]);
    expect(container.querySelector("[data-workflow-run-overflow]")?.textContent).toBe("+1 more");

    act(() => {
      store.acknowledge(["err"]);
    });
    expect(texts()).toEqual(["Stopped · by you", "Completed"]);

    // 会话被打开：剩下的已结束 run 整批确认，行随之消失。
    rerender(wrap(createElement(TaskWorkflowRunLines, { activity, isActive: true, intl })));
    expect(store.isAcknowledged("stop")).toBe(true);
    expect(store.isAcknowledged("done")).toBe(true);
    expect(container.querySelector("[data-workflow-run-lines]")).toBeNull();
  });

  it("a live run is never hidden by the acknowledgement set", () => {
    store.acknowledge(["live"]);
    const { container } = render(
      wrap(
        createElement(TaskWorkflowRunLines, {
          activity: { runs: [run({ runId: "live" })] },
          isActive: true,
          intl,
        }),
      ),
    );
    expect(container.querySelector("[data-workflow-run-line]")).not.toBeNull();
  });

  it("with an open handler the line is a button that opens the run without bubbling to the row", () => {
    const opened: WorkflowRunOpenTarget[] = [];
    const rowClicks = vi.fn();
    const activity: SessionWorkflowActivity = {
      runs: [run({ runId: "r1", toolCallId: "tc-1", name: "Deep research" })],
    };
    const { container } = render(
      wrap(
        createElement(
          "div",
          { onClick: rowClicks },
          createElement(TaskWorkflowRunLines, {
            activity,
            isActive: false,
            intl,
            session: { workspacePath: "/ws", workspaceIdentity: "id-1", sessionId: "s1" },
          }),
        ),
        (target) => opened.push(target),
      ),
    );
    const line = container.querySelector<HTMLElement>("[data-workflow-run-line]");
    expect(line?.tagName).toBe("BUTTON");
    fireEvent.click(line!);
    expect(rowClicks).not.toHaveBeenCalled();
    expect(opened).toEqual([
      {
        workspacePath: "/ws",
        workspaceIdentity: "id-1",
        sessionId: "s1",
        run: activity.runs[0],
      },
    ]);
  });
});
