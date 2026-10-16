// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookInvocationRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";

const tooltipCapture = vi.hoisted(() => ({ opens: [] as Array<boolean | undefined> }));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children, open }: { children: ReactNode; open?: boolean }) => {
    tooltipCapture.opens.push(open);
    return createElement("div", { "data-tooltip-open": String(open) }, children);
  },
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) =>
    createElement("span", { "data-testid": "hook-tooltip" }, children),
}));

function hookRow(
  rowId: number,
  options: {
    didExecute?: boolean;
    displayName: string;
    durationMs?: number;
    event?: HookInvocationRow["hookEventName"];
    outcome?: HookInvocationRow["executions"][number]["outcome"];
    blockReason?: string;
    pluginName?: string;
    sourceKind: HookInvocationRow["executions"][number]["sourceKind"];
    toolName?: string;
  },
): HookInvocationRow {
  const didExecute = options.didExecute ?? true;
  const durationMs = options.durationMs ?? 25;
  const outcome = options.outcome ?? "success";
  return {
    rowId,
    turnId: "turn-1",
    entityId: `hook-invocation-${rowId}`,
    productTurnId: "turn-1",
    visibility: "visible",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "hookInvocation",
    hookInvocationId: `hook-invocation-${rowId}`,
    hookEventName: options.event ?? "UserPromptSubmit",
    hookCount: 1,
    state: outcome === "failed" || outcome === "timed_out" ? "failed" : "completed",
    startedAt: 1_700_000_000_000 + rowId,
    endedAt: 1_700_000_000_000 + rowId + durationMs,
    durationMs,
    lane: options.toolName ? "toolBefore" : "assistantWork",
    ...(options.toolName ? { anchorToolCallId: `tool-${rowId}` } : {}),
    executions: [
      {
        hookRunId: `hook-run-${rowId}`,
        hookIndex: 0,
        didExecute,
        state: outcome === "failed" || outcome === "timed_out" ? "failed" : "completed",
        outcome,
        startedAt: 1_700_000_000_000 + rowId,
        endedAt: 1_700_000_000_000 + rowId + durationMs,
        durationMs,
        displayName: options.displayName,
        sourceKind: options.sourceKind,
        ...(options.blockReason ? { blockReason: options.blockReason } : {}),
        ...(options.pluginName ? { pluginName: options.pluginName } : {}),
        ...(options.toolName ? { toolName: options.toolName } : {}),
      },
    ],
  };
}

function renderAction(rows: readonly HookInvocationRow[], locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(actionElement(rows, locale));
}

function actionElement(rows: readonly HookInvocationRow[], locale: "zh-CN" | "en-US" = "zh-CN") {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(ConversationHookDetailsAction, {
      rows,
      turnId: "turn-1",
    }),
  );
}

afterEach(() => {
  cleanup();
  tooltipCapture.opens.length = 0;
});

describe("ConversationHookDetailsAction", () => {
  it("shows executed Hooks in order without exposing implementation details or aggregating repeats", async () => {
    renderAction([
      hookRow(1, { displayName: "prepare-context", sourceKind: "user" }),
      hookRow(4, { displayName: "prepare-context", sourceKind: "user" }),
      hookRow(2, {
        displayName: "validate-write",
        event: "PreToolUse",
        outcome: "failed",
        sourceKind: "project",
        toolName: "Write",
      }),
      hookRow(5, {
        displayName: "validate-write",
        event: "PreToolUse",
        outcome: "failed",
        sourceKind: "project",
        toolName: "Read",
      }),
      hookRow(3, {
        displayName: "plugin-check",
        event: "PostToolUse",
        pluginName: "Quality Plugin",
        sourceKind: "plugin",
        toolName: "Write",
      }),
    ]);

    expect(screen.getByTestId("hook-tooltip").textContent).toBe("钩子");
    expect(screen.queryByTestId("v4-hook-details-content-turn-1")).toBeNull();

    fireEvent.click(screen.getByTestId("v4-hook-details-trigger-turn-1"));

    const content = await screen.findByTestId("v4-hook-details-content-turn-1");
    expect(content.className).toContain("max-w-[calc(100vw-2rem)]");
    expect(content.style.maxHeight).toBe(
      "min(20rem, var(--radix-popover-content-available-height))",
    );
    expect(content.textContent).toContain("钩子");
    expect(content.textContent).not.toContain("本轮钩子");
    expect(content.textContent).not.toContain("共 ");
    expect([...content.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "UserPromptSubmit用户25ms",
      "UserPromptSubmit用户25ms",
      "PreToolUse工作区25ms失败",
      "PreToolUse工作区25ms失败",
      "PostToolUse插件25ms",
    ]);
    expect(content.textContent).not.toContain("prepare-context");
    expect(content.textContent).not.toContain("validate-write");
    expect(content.textContent).not.toContain("Quality Plugin");
    expect(content.textContent).not.toContain("Write");
    expect(content.textContent).not.toContain("Read");
    expect(content.textContent).not.toContain("×");
    expect(content.textContent).not.toContain("项目");
    expect(content.textContent).not.toContain("已完成");
    expect(content.textContent).toContain("25ms");
    await waitFor(() => expect(tooltipCapture.opens.at(-1)).toBe(false));
  });

  it("does not render the action when no client-visible Hook actually executed", () => {
    const { container } = renderAction([
      hookRow(1, {
        didExecute: false,
        displayName: "blocked-project-hook",
        outcome: "blocked",
        sourceKind: "project",
      }),
    ]);

    expect(container.innerHTML).toBe("");
  });

  it("keeps the block reason in Hook details while the chat error owns the primary message", async () => {
    renderAction([
      hookRow(1, {
        displayName: "prompt-block",
        event: "UserPromptSubmit",
        outcome: "blocked",
        blockReason: "HOOK_PROMPT_BLOCK_REASON",
        sourceKind: "user",
      }),
    ]);

    expect(screen.queryByText("：HOOK_PROMPT_BLOCK_REASON")).toBeNull();

    fireEvent.click(screen.getByTestId("v4-hook-details-trigger-turn-1"));
    const content = await screen.findByTestId("v4-hook-details-content-turn-1");
    const row = content.querySelector("li");

    expect(screen.getAllByText("：HOOK_PROMPT_BLOCK_REASON")).toHaveLength(1);
    expect(row?.textContent).toContain("已阻止");
    expect(row?.textContent).toContain("HOOK_PROMPT_BLOCK_REASON");
    expect(screen.getByTestId("hook-tooltip").textContent).toBe("钩子");
  });

  it("lists executions from one invocation by hookIndex without deduplicating them", async () => {
    const row = hookRow(1, {
      displayName: "late-plugin-hook",
      event: "PreToolUse",
      sourceKind: "plugin",
    });
    row.executions = [
      { ...row.executions[0]!, hookIndex: 2, hookRunId: "hook-run-plugin" },
      {
        ...row.executions[0]!,
        displayName: "first-user-hook",
        hookIndex: 0,
        hookRunId: "hook-run-user",
        sourceKind: "user",
      },
      {
        ...row.executions[0]!,
        displayName: "failed-workspace-hook",
        hookIndex: 1,
        hookRunId: "hook-run-workspace",
        outcome: "failed",
        sourceKind: "project",
        state: "failed",
      },
    ];

    renderAction([row]);
    fireEvent.click(screen.getByTestId("v4-hook-details-trigger-turn-1"));
    const content = await screen.findByTestId("v4-hook-details-content-turn-1");

    expect([...content.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "PreToolUse用户25ms",
      "PreToolUse工作区25ms失败",
      "PreToolUse插件25ms",
    ]);
  });

  it("uses localized English source and state labels", async () => {
    renderAction(
      [
        hookRow(1, {
          displayName: "cancelled-check",
          durationMs: 1_250,
          outcome: "cancelled",
          sourceKind: "user",
        }),
        hookRow(2, {
          displayName: "workspace-check",
          event: "PreToolUse",
          sourceKind: "project",
        }),
      ],
      "en-US",
    );

    fireEvent.click(screen.getByTestId("v4-hook-details-trigger-turn-1"));
    const content = await screen.findByTestId("v4-hook-details-content-turn-1");
    expect(content.textContent).toContain("Hooks");
    expect(content.textContent).not.toContain("Hooks in this turn");
    expect(content.textContent).toContain("User");
    expect(content.textContent).toContain("Workspace");
    expect(content.textContent).toContain("1.25s");
    expect(content.textContent).toContain("Cancelled");
  });

  it("HK13 keeps the Popover open while an async Hook terminal updates in place", async () => {
    const running = hookRow(1, {
      displayName: "async-check",
      sourceKind: "user",
    });
    running.state = "running";
    const runningExecution = {
      ...running.executions[0]!,
      state: "running",
    };
    delete runningExecution.outcome;
    delete runningExecution.durationMs;
    delete runningExecution.endedAt;
    running.executions[0] = runningExecution;
    const view = renderAction([running]);
    fireEvent.click(screen.getByTestId("v4-hook-details-trigger-turn-1"));
    expect((await screen.findByTestId("v4-hook-details-content-turn-1")).textContent).toContain(
      "运行中",
    );
    expect(screen.getByTestId("v4-hook-details-content-turn-1").textContent).not.toContain("25ms");

    const completed = hookRow(1, {
      displayName: "async-check",
      sourceKind: "user",
    });
    view.rerender(actionElement([completed]));

    const content = await screen.findByTestId("v4-hook-details-content-turn-1");
    expect(content.textContent).not.toContain("运行中");
    expect(content.textContent).not.toContain("已完成");
    expect(content.textContent).toContain("25ms");
    expect(screen.getByTestId("v4-hook-details-trigger-turn-1").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
