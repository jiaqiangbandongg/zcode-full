// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTrajectoryInputMessages } from "@/ModelTrajectoryPane.js";
import { ExpandableTrajectoryMessage } from "@/ModelTrajectoryExpandableMessage.js";
import {
  createTrajectoryExpansionCommands,
  TrajectoryExpansionCommandContext,
} from "@/ModelTrajectoryExpansion.js";
import { CallCard } from "@/ModelTrajectoryPaneParts.js";
import { TrajectorySearchRevealContext } from "@/ModelTrajectorySearch.js";
import { trajectoryToolOutputs } from "@/ModelTrajectoryToolPayload.js";

const messages: Record<string, string> = {
  "modelTrajectory.inputSection": "输入",
  "modelTrajectory.attempt": "第 {attempt} 次尝试",
  "modelTrajectory.outputSection": "输出",
  "modelTrajectory.message": "消息",
  "modelTrajectory.reasoning": "思考过程",
  "modelTrajectory.role.assistant": "助手消息",
  "modelTrajectory.role.system": "系统提示词",
  "modelTrajectory.role.tool": "工具结果",
  "modelTrajectory.role.user": "用户消息",
  "modelTrajectory.source.main": "主会话",
  "modelTrajectory.source.sessionTitle": "标题生成",
  "modelTrajectory.finish.toolCalls": "工具调用",
  "modelTrajectory.toolCall": "工具调用",
  "modelTrajectory.toolId": "ID",
  "modelTrajectory.toolInput": "输入",
  "modelTrajectory.toolOutput": "输出",
  "modelTrajectory.toolResult": "工具结果",
  "modelTrajectory.showAll": "展开",
  "modelTrajectory.collapseContent": "收起",
  "modelTrajectory.copyContent": "复制内容",
  "chat.message.copy": "复制",
};

const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, value),
      messages[id] ?? id,
    ),
};

afterEach(() => {
  cleanup();
});

describe("ModelTrajectoryPaneParts", () => {
  it("temporarily reveals the active search target without changing local expansion", () => {
    const props = {
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: "hidden text" }] },
      role: "user" as const,
      roleLabel: "用户消息",
      callDurationLabel: "1.00s",
      callDatetimeLabel: "08:00:00 PM",
      callDatetimeTitle: "2026-06-03T12:00:00.000Z",
      expansionKey: "req:0:input:0",
      intl: intl as never,
    };
    const { rerender } = render(
      createElement(
        TrajectorySearchRevealContext.Provider,
        { value: "req:0:input:0" },
        createElement(ExpandableTrajectoryMessage, props),
      ),
    );
    expect(screen.getByRole("button", { name: /用户消息/ }).dataset.state).toBe("open");
    expect(document.querySelector('[data-trajectory-message-content=""]')?.className).not.toContain(
      "max-h-64",
    );

    rerender(
      createElement(
        TrajectorySearchRevealContext.Provider,
        { value: null },
        createElement(ExpandableTrajectoryMessage, props),
      ),
    );
    expect(screen.getByRole("button", { name: /用户消息/ }).dataset.state).toBe("open");
  });

  it("uses error-text values for tool result summaries and expanded content", () => {
    const message = {
      role: "tool" as const,
      parts: [
        {
          kind: "tool-result" as const,
          toolCallId: "call_busy",
          toolName: "open_application",
          output: {
            type: "error-text",
            value: "MCP tool returned an error:\nCUA_CONTROLLER_BUSY: action_sent=false.",
          },
        },
      ],
    };

    expect(trajectoryToolOutputs(message)).toEqual([
      "MCP tool returned an error:\nCUA_CONTROLLER_BUSY: action_sent=false.",
    ]);

    const { container } = render(
      createElement(ExpandableTrajectoryMessage, {
        message,
        role: "tool",
        roleLabel: "工具结果",
        callDurationLabel: "1.00s",
        callDatetimeLabel: "08:00:00 PM",
        callDatetimeTitle: "2026-06-03T12:00:00.000Z",
        intl: intl as never,
      }),
    );
    const trigger = screen.getByRole("button", {
      name: /工具结果输出MCP tool returned an error/,
    });
    expect(trigger.querySelector('[data-trajectory-payload-error-icon=""]')).toBeTruthy();
    expect(trigger.querySelector('[data-trajectory-payload-direction=""]')?.className).toContain(
      "text-destructive",
    );
    const errorPayload = container.querySelector('[data-trajectory-tool-error-content=""]');
    expect(errorPayload?.className).toContain("rounded-lg");
    expect(errorPayload?.className).toContain("bg-destructive/10");
    expect(errorPayload?.className).toContain("text-destructive");

    const toolCallRender = render(
      createElement(ExpandableTrajectoryMessage, {
        message: {
          role: "assistant",
          parts: [
            {
              kind: "tool-call",
              toolCallId: "call_invalid",
              toolName: "broken_tool",
              input: { type: "error-text", value: "Invalid tool input\nmissing path" },
            },
          ],
        },
        role: "assistant",
        roleLabel: "工具调用",
        callDurationLabel: "1.00s",
        callDatetimeLabel: "08:00:00 PM",
        callDatetimeTitle: "2026-06-03T12:00:00.000Z",
        intl: intl as never,
      }),
    );
    expect(
      toolCallRender.container.querySelector('[data-trajectory-message-preview=""]')?.textContent,
    ).toBe("Invalid tool input missing path");
    expect(
      toolCallRender.container.querySelector('[data-trajectory-payload-error-icon=""]'),
    ).toBeTruthy();
  });

  it("applies versioned expand-all and collapse-all commands to message rows", () => {
    const message = createElement(ExpandableTrajectoryMessage, {
      message: { role: "user", parts: [{ kind: "text", text: "full message" }] },
      role: "user",
      roleLabel: "用户",
      callDurationLabel: "1.00s",
      callDatetimeLabel: "12:00:00",
      callDatetimeTitle: "2026-06-03T12:00:00.000Z",
      intl: intl as never,
    });
    const renderCommand = (expanded: boolean, version: number) =>
      createElement(
        TrajectoryExpansionCommandContext.Provider,
        {
          value: {
            system: { expanded: false, version: 0 },
            user: { expanded, version },
            reasoning: { expanded: false, version: 0 },
            assistant: { expanded: false, version: 0 },
            "tool-call": { expanded: false, version: 0 },
            "tool-result": { expanded: false, version: 0 },
          },
        },
        message,
      );
    const renderInitialCommands = () =>
      createElement(
        TrajectoryExpansionCommandContext.Provider,
        { value: createTrajectoryExpansionCommands() },
        message,
      );
    const { container, rerender } = render(renderInitialCommands());
    const row = () => container.querySelector('[data-trajectory-message-collapsible=""]');

    expect(row()?.getAttribute("data-state")).toBe("open");
    rerender(renderCommand(false, 1));
    expect(row()?.getAttribute("data-state")).toBe("closed");
    rerender(renderCommand(true, 2));
    expect(row()?.getAttribute("data-state")).toBe("open");
    fireEvent.click(row()?.querySelector('[data-trajectory-message-trigger=""]') as HTMLElement);
    expect(row()?.getAttribute("data-state")).toBe("closed");
    rerender(renderCommand(true, 2));
    expect(row()?.getAttribute("data-state")).toBe("closed");
    rerender(renderCommand(false, 3));
    expect(row()?.getAttribute("data-state")).toBe("closed");
    rerender(renderCommand(true, 4));
    expect(row()?.getAttribute("data-state")).toBe("open");

    const source = readFileSync("packages/ui/src/ModelTrajectoryExpandableMessage.tsx", "utf8");
    expect(source).not.toContain("useEffect");
    expect(source).toContain("expansionCommand.version > rowExpansion.commandVersion");
    expect(source).toContain("expansionRegistry?.overrides.get(expansionKey)");
  });

  it("uses distinct semantic colors for reasoning, tool calls, and tool results", () => {
    const renderRole = (
      visualRole: "reasoning" | "tool-call" | "tool-result",
      message: Parameters<typeof ExpandableTrajectoryMessage>[0]["message"],
    ) =>
      renderToStaticMarkup(
        createElement(ExpandableTrajectoryMessage, {
          message,
          role: visualRole === "tool-result" ? "tool" : "assistant",
          visualRole,
          roleLabel: visualRole,
          callDurationLabel: "1.00s",
          callDatetimeLabel: "12:00:00",
          callDatetimeTitle: "2026-06-03T12:00:00.000Z",
          intl: intl as never,
        }),
      );

    expect(
      renderRole("reasoning", {
        role: "assistant",
        parts: [{ kind: "text", text: "inspect context" }],
      }),
    ).toContain(
      'data-trajectory-role-label="reasoning" class="pr-1 font-mono text-ui-sm uppercase text-trajectory-reasoning/80"',
    );
    expect(
      renderRole("tool-call", {
        role: "assistant",
        parts: [{ kind: "tool-call", toolCallId: "call-1", toolName: "Read", input: {} }],
      }),
    ).toContain("text-trajectory-tool-call/80");
    expect(
      renderRole("tool-result", {
        role: "tool",
        parts: [
          {
            kind: "tool-result",
            toolCallId: "call-1",
            toolName: "Read",
            output: "done",
          },
        ],
      }),
    ).toContain("text-trajectory-tool-result/80");
  });

  it("renders model call errors as a borderless translucent error", () => {
    const html = renderToStaticMarkup(
      createElement(CallCard, {
        index: 0,
        intl: intl as never,
        inputMessages: [],
        record: {
          requestId: "req-error",
          attempt: 1,
          startedAt: "2026-06-03T12:00:00.000Z",
          model: {},
          request: { messages: [], toolNames: [] },
          error: { name: "ProviderError", message: "Rate limited", stack: "stack line" },
        },
      }),
    );

    expect(html).toContain('data-trajectory-call-error=""');
    expect(html).toContain("flex items-start gap-2 rounded-lg bg-destructive/10 px-2 py-1.5");
    expect(html).toContain('data-trajectory-call-error-icon=""');
    expect(html).toContain("size-4 shrink-0 text-destructive");
    expect(readFileSync("packages/ui/src/ModelTrajectoryErrorBlock.tsx", "utf8")).toContain(
      "CircleAlertIcon",
    );
    expect(html).toContain("text-ui-base font-medium text-destructive");
    expect(html).toContain("text-destructive/80");
    expect(html).not.toContain("border-destructive");
  });

  it("omits the call_ prefix from displayed tool call ids", () => {
    const html = renderToStaticMarkup(
      createElement(ExpandableTrajectoryMessage, {
        message: {
          role: "assistant",
          parts: [
            {
              kind: "tool-call",
              toolCallId: "call_345f37b9dc314d09",
              toolName: "Skill",
              input: {},
            },
          ],
        },
        role: "assistant",
        roleLabel: "工具调用",
        callDurationLabel: "1.00s",
        callDatetimeLabel: "12:00:00",
        callDatetimeTitle: "2026-06-03T12:00:00.000Z",
        intl: intl as never,
      }),
    );

    expect(html).toContain(">345f37b9dc314d09</span>");
    expect(html).not.toContain(">call_345f37b9dc314d09</span>");
  });

  it("renders response reasoning with the shared expandable row and purple role color", () => {
    const html = renderToStaticMarkup(
      createElement(CallCard, {
        index: 0,
        intl: intl as never,
        inputMessages: [],
        record: {
          attempt: 1,
          callSource: { kind: "main" },
          model: { modelId: "glm-test" },
          request: { messages: [], toolNames: [] },
          requestId: "req-reasoning",
          startedAt: "2026-06-03T12:00:00.000Z",
          response: {
            finishReason: "stop",
            reasoningText: "inspect context\nverify result",
            toolCalls: [],
          },
        },
      }),
    );

    expect(html).toContain('data-trajectory-role-label="reasoning"');
    expect(html).toContain("text-trajectory-reasoning/80");
    expect(html).toContain('data-trajectory-message-trigger=""');
    expect(html).toContain('data-trajectory-message-expanded=""');
  });

  it("renders a compact expandable call log with semantic colors", () => {
    const html = renderToStaticMarkup(
      createElement(CallCard, {
        index: 0,
        intl: intl as never,
        inputMessages: [
          {
            role: "system",
            parts: [{ kind: "text", text: "system prompt" }],
          },
          {
            role: "user",
            parts: [{ kind: "text", text: "read file" }],
          },
          {
            role: "tool",
            parts: [
              {
                kind: "tool-result",
                toolCallId: "tool-call-1",
                toolName: "Read",
                output: { content: "file body" },
              },
            ],
          },
        ],
        record: {
          attempt: 2,
          callSource: { kind: "sidecar", querySource: "session_title" },
          model: { modelId: "glm-test" },
          request: { messages: [], toolNames: ["Read"] },
          requestId: "req-1",
          startedAt: "2026-06-03T12:00:00.000Z",
          durationMs: 21700,
          response: {
            finishReason: "tool-calls",
            usage: { inputTokens: 40077, outputTokens: 354 },
            toolCalls: [
              {
                kind: "tool-call",
                toolCallId: "tool-call-1",
                toolName: "Read",
                input: { path: "/tmp/a.ts" },
              },
            ],
          },
        },
      }),
    );

    expect(html).toContain("标题生成");
    expect(html).toContain("IN 40,077");
    expect(html).toContain("OUT 354");
    expect(html).toContain("21.7s");
    expect(html).not.toContain("第 2 次尝试");
    expect(html).not.toContain('data-trajectory-model-pill=""');
    expect(html).toContain('data-trajectory-finish-pill=""');
    expect(html).toContain('data-trajectory-finish-reason="tool-calls"');
    expect(html).toContain("rounded-full border-border bg-tag");
    expect(html).toContain("flex size-5 shrink-0 items-center justify-center");
    expect(html).toContain("truncate text-ui-sm font-medium text-foreground");
    expect(html).toContain('data-trajectory-source-title=""');
    expect(html).toContain('data-trajectory-source-kind="sidecar"');
    expect(html).toContain('data-trajectory-query-source="session_title"');
    expect(html).not.toContain('data-trajectory-source-title="" class="min-w-0 flex-1 truncate');
    expect(html).toContain("items-center gap-1.5 border-b border-border/50");
    expect(html).toContain('data-trajectory-call-metadata=""');
    expect(html.indexOf("IN 40,077")).toBeLessThan(html.indexOf("OUT 354"));
    expect(html.indexOf("OUT 354")).toBeLessThan(html.indexOf("21.7s"));
    expect(html.indexOf("21.7s")).toBeLessThan(html.indexOf('title="2026-06-03T12:00:00.000Z"'));
    expect(html).toContain('data-trajectory-message-role="tool"');
    expect(html).toContain('data-trajectory-message-role="assistant"');
    expect(html).not.toContain('data-trajectory-assistant-title=""');
    expect(html).toContain('data-trajectory-call="" class="col-span-full grid grid-cols-subgrid"');
    expect(html).toContain('data-trajectory-call-summary=""');
    expect(html).toContain(
      'data-trajectory-call-content="" class="col-span-full grid grid-cols-subgrid gap-y-2 p-2"',
    );
    expect(html).not.toContain("grid-cols-subgrid py-2");
    expect(html).not.toContain("flex flex-col gap-2 pb-2 pl-7 pr-1 pt-1");
    expect(html).toContain("sticky top-0 z-10");
    expect(html).toContain("gap-1.5 border-b border-border/50 bg-surface/90 px-3 py-2 text-left");
    expect(html).toContain("bg-surface/90");
    expect(html).toContain("supports-[backdrop-filter]:backdrop-blur-sm");
    expect(html).toContain('data-trajectory-call-divider=""');
    expect(html).toContain("h-px bg-border");
    expect(html).toContain('data-trajectory-message-role="system"');
    expect(html).toContain('data-trajectory-message-role="user"');
    expect(html).toContain('data-trajectory-message-role="tool"');
    expect(html).toContain(
      'data-trajectory-section="" class="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"',
    );
    expect(html).toContain(
      'data-trajectory-response-section="" class="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"',
    );
    expect(html).toContain("group relative col-span-full grid w-full min-w-0 grid-cols-subgrid");
    expect(html).toContain("col-span-2 grid min-h-8 min-w-0 grid-cols-subgrid");
    expect(html).not.toContain("min-h-7");
    expect(html).toContain(
      'data-trajectory-message-actions="" class="relative -ml-1 mr-1 flex items-center justify-end"',
    );
    expect(html).not.toContain("grid-cols-[5rem_minmax(0,1fr)]");
    expect(html.match(/data-trajectory-section-title=""/g)).toHaveLength(2);
    expect(html).toContain('data-trajectory-section-kind="input"');
    expect(html).toContain('data-trajectory-section-kind="output"');
    expect(html).not.toContain("data-trajectory-section-icon");
    expect(html).not.toContain('data-trajectory-section-line=""');
    expect(html).toContain("bg-surface");
    expect(html).not.toContain("bg-surface/50");
    expect(html).not.toContain("border-l-3 border-foreground");
    expect(html).not.toContain("border-l-4");
    expect(html).not.toContain("border-l-2");
    expect(html).toContain(
      "col-span-full flex h-8 items-center bg-surface px-3 font-mono text-ui-sm uppercase text-foreground",
    );
    expect(html).not.toContain('data-trajectory-section-title="" class="col-span-full mb-');
    expect(html).not.toContain('data-trajectory-section-title="" class="mt-');
    expect(html).toContain(">输入</span>");
    expect(html).toContain(">输出</span>");
    expect(html).toContain('data-trajectory-response-section=""');
    expect(html).not.toContain('data-trajectory-section-rows=""');
    expect(html.match(/data-trajectory-expandable-role=/g)).toHaveLength(4);
    expect(html.match(/data-trajectory-row-alt="true"/g)).toHaveLength(2);
    expect(html).toContain("bg-surface/30");
    expect(html).not.toContain("border-trajectory-system/80");
    expect(html).not.toContain("border-trajectory-user/80");
    expect(html).not.toContain("border-trajectory-tool-call/80");
    expect(html).not.toContain("border-trajectory-tool-result/80");
    expect(html).not.toContain("text-trajectory-system/80");
    expect(html).toContain(
      'data-trajectory-role-label="system" class="pr-1 font-mono text-ui-sm uppercase text-foreground-subtle"',
    );
    expect(html).toContain("text-trajectory-user/80");
    expect(html).toContain("text-trajectory-tool-call/80");
    expect(html).toContain("text-trajectory-tool-result/80");
    expect(html).not.toContain("data-trajectory-role-line");
    expect(html.match(/data-trajectory-row-divider=""/g)).toHaveLength(4);
    expect(html).toContain("col-span-full h-px bg-border/50");
    const partsSource = readFileSync("packages/ui/src/ModelTrajectoryPaneParts.tsx", "utf8");
    const sectionTitleSource = readFileSync(
      "packages/ui/src/ModelTrajectorySectionTitle.tsx",
      "utf8",
    );
    const stylesSource = readFileSync("packages/ui/src/styles.css", "utf8");
    for (const token of [
      "--color-trajectory-user",
      "--color-trajectory-assistant",
      "--color-trajectory-reasoning",
      "--color-trajectory-tool-call",
      "--color-trajectory-tool-result",
    ]) {
      expect(stylesSource.match(new RegExp(`${token}:`, "g"))).toHaveLength(4);
    }
    expect(stylesSource.match(/--color-trajectory-assistant: #0f766e/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-assistant: #2dd4bf/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-reasoning: #7c3aed/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-reasoning: #a78bfa/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-tool-call: #d97706/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-tool-call: #f59e0b/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-tool-result: #0284c7/g)).toHaveLength(2);
    expect(stylesSource.match(/--color-trajectory-tool-result: #38bdf8/g)).toHaveLength(2);
    expect(sectionTitleSource).not.toContain("SquareArrowRightEnterIcon");
    expect(sectionTitleSource).not.toContain("SquareArrowRightExitIcon");
    expect(sectionTitleSource).not.toContain("ArrowDownToLineIcon");
    expect(sectionTitleSource).not.toContain("ArrowUpFromLineIcon");
    const paneSource = readFileSync("packages/ui/src/ModelTrajectoryPane.tsx", "utf8");
    const timelineSource = readFileSync("packages/ui/src/ModelTrajectoryTimeline.tsx", "utf8");
    const expansionMenuSource = readFileSync(
      "packages/ui/src/ModelTrajectoryExpansionMenu.tsx",
      "utf8",
    );
    expect(paneSource).toContain('data-trajectory-toggle-all=""');
    expect(paneSource).toContain("modelTrajectory.expandAll");
    expect(paneSource).toContain("modelTrajectory.collapseAll");
    expect(expansionMenuSource).toContain("modelTrajectory.customExpansion");
    expect(expansionMenuSource).toContain('data-trajectory-custom-expansion=""');
    expect(expansionMenuSource).toContain("TRAJECTORY_EXPANSION_KINDS.map");
    expect(expansionMenuSource).toContain('size="sm"');
    expect(paneSource).toContain("const willExpandAll = TRAJECTORY_EXPANSION_KINDS.some");
    expect(paneSource).toContain("Maximize2Icon");
    expect(paneSource).toContain("Minimize2Icon");
    expect(paneSource).toContain('className="shrink-0 text-foreground"');
    expect(paneSource).not.toContain(
      'data-trajectory-toggle-all=""\n              type="button"\n              variant="ghost"\n              size="icon-sm"\n              className="shrink-0 text-foreground-subtle',
    );
    expect(paneSource.indexOf('data-trajectory-toggle-all=""')).toBeLessThan(
      paneSource.indexOf("sourceDirectory ?"),
    );
    expect(timelineSource).toContain('data-trajectory-timeline=""');
    expect(timelineSource).toContain(
      'className="grid grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2"',
    );
    expect(timelineSource).toContain("grid w-full grid-cols-subgrid");
    expect(partsSource).not.toContain("AssistantDetailCard");
    expect(partsSource).not.toContain("flex min-w-0 flex-col gap-1.5 p-3 pt-0");
    expect(partsSource).not.toContain("ChevronDownIcon");
    expect(html).toContain('class="sr-only group-data-[state=open]:hidden"');
    expect(html).toContain('data-trajectory-message-trigger=""');
    expect(html).toContain('data-trajectory-message-expanded=""');
    expect(partsSource).not.toContain('data-trajectory-message-expanded-card=""');
    expect(partsSource).not.toContain('className="min-w-0 px-3 py-1"');
    expect(partsSource).not.toContain('className="min-w-0 px-3 pb-1"');
    expect(partsSource).not.toContain('<div aria-hidden="true" />');
    expect(html.match(/data-trajectory-message-collapsible=""/g)).toHaveLength(4);
    expect(partsSource).not.toContain("responseMessagePreview");
    expect(partsSource).not.toContain("responseToolCallNames");
    expect(html).not.toContain('data-trajectory-assistant-tool-tag=""');
    expect(partsSource).not.toContain('<span className="flex min-w-0 items-start">');
    expect(partsSource).not.toContain("data-trajectory-model-pill");
    expect(html).toContain(
      'data-trajectory-user-summary-card="" class="col-span-full grid min-h-8 w-full min-w-0 grid-cols-subgrid items-center"',
    );
    expect(html).not.toContain("data-[state=open]:bg-selected");
    expect(html).not.toContain("bg-card-selected");
    expect(html).not.toContain("bg-accent");
  });

  it("uses the user message layout for expandable system messages", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      createElement(CallCard, {
        index: 0,
        intl: intl as never,
        inputMessages: [
          {
            role: "system",
            parts: [{ kind: "text", text: " \n system summary\nfull system prompt\n \n" }],
          },
        ],
        record: {
          attempt: 1,
          durationMs: 2_000,
          model: { modelId: "glm-test" },
          request: { messages: [], toolNames: [] },
          requestId: "req-system",
          startedAt: "2026-06-03T12:00:00.000Z",
        },
      }),
    );

    const systemContainer = container.querySelector('[data-trajectory-expandable-role="system"]');
    expect(systemContainer).toBeTruthy();
    const systemTrigger = screen.getByRole("button", { name: /系统提示词system summary/ });
    expect(systemTrigger.dataset.state).toBe("open");
    expect(screen.getByText(/full system prompt/)).toBeTruthy();
    expect(
      systemContainer?.querySelector('[data-trajectory-call-metadata=""]')?.textContent,
    ).toContain("2.00s");
    const systemCopy = systemContainer?.querySelector<HTMLButtonElement>(
      '[data-trajectory-message-copy=""]',
    );
    expect(systemCopy).toBeTruthy();
    expect(systemCopy?.className).toContain("absolute right-full mr-1");
    expect(systemCopy?.className).toContain("group-data-[state=open]:inline-flex");
    expect(systemCopy?.dataset.size).toBe("icon-sm");
    expect(systemContainer?.querySelector('[data-trajectory-overflow-copy=""]')).toBeNull();
    fireEvent.click(systemCopy as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith(" \n system summary\nfull system prompt\n \n");
    expect(systemContainer?.querySelector('[data-trajectory-overflow-toggle=""]')).toBeNull();
    const systemContent = systemContainer?.querySelector('[data-trajectory-message-content=""]');
    expect(systemContent?.textContent).toBe("system summary\nfull system prompt");
    expect(systemContent?.className).toContain("max-h-64");
    expect(systemContent?.className).toContain("px-3");
    expect(systemContent?.className).toContain("pt-0");
    expect(systemContent?.className).toContain("pb-2");
    expect(systemContent?.className).not.toContain("p-3");
    expect(systemContent?.className).not.toContain("pt-1");
    expect(systemContent?.className).not.toContain("bg-surface");
    expect(systemContainer?.querySelector('[data-trajectory-message-expanded-card=""]')).toBeNull();
  });

  it("renders assistant output as independent expandable message rows", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      createElement(CallCard, {
        index: 0,
        intl: intl as never,
        inputMessages: [
          {
            role: "user",
            parts: [{ kind: "text", text: "summary message\nfull user message" }],
          },
          {
            role: "tool",
            parts: [
              {
                kind: "tool-result",
                toolCallId: "tool-call-1",
                toolName: "Read",
                output: { content: "file body\nsecond output line" },
              },
            ],
          },
        ],
        record: {
          attempt: 1,
          durationMs: 21_700,
          model: { modelId: "glm-test" },
          request: { messages: [], toolNames: ["Read"] },
          requestId: "req-expand",
          startedAt: "2026-06-03T12:00:00.000Z",
          response: {
            reasoningText: "inspect the file\nreasoning detail",
            text: "file inspected\nmessage detail",
            toolCalls: [
              {
                kind: "tool-call",
                toolCallId: "tool-call-1",
                toolName: "Read",
                input: { path: "/tmp/a.ts" },
              },
            ],
          },
        },
      }),
    );

    const userTrigger = screen.getByRole("button", { name: /用户消息summary message/ });
    expect(userTrigger.dataset.state).toBe("open");
    expect(userTrigger.querySelector('[data-trajectory-message-preview=""]')?.textContent).toBe(
      "summary message full user message",
    );
    expect(
      userTrigger
        .closest('[data-trajectory-message-collapsible=""]')
        ?.querySelector('[data-trajectory-message-content=""]'),
    ).toBeTruthy();
    expect(screen.getAllByText(/full user message/)).toHaveLength(2);
    const userContainer = container.querySelector('[data-trajectory-user-container=""]');
    expect(userContainer?.className).toContain("w-full");
    expect(userContainer?.className).not.toContain("bg-surface");
    expect(userContainer?.className).not.toContain("mx-3");
    expect(userContainer?.className).not.toContain("rounded");
    const userMetadata = container.querySelector('[data-trajectory-user-call-metadata=""]');
    expect(userMetadata?.textContent).toContain("21.7s");
    expect(userMetadata?.className).toContain("mr-7");
    expect(
      container.querySelector('[data-trajectory-user-call-datetime=""]')?.getAttribute("title"),
    ).toBe("2026-06-03T12:00:00.000Z");
    expect(userMetadata?.className).toContain("ml-auto");
    const copyButton = userContainer?.querySelector<HTMLButtonElement>(
      '[data-trajectory-message-copy=""]',
    );
    expect(copyButton?.dataset.size).toBe("icon-sm");
    const chevronButton = container.querySelector('[data-trajectory-user-chevron-trigger=""]');
    expect(chevronButton?.classList.contains("size-5")).toBe(true);
    expect(container.querySelector('[data-trajectory-user-summary-card=""]')).toBeTruthy();
    const userContent = container.querySelector('[data-trajectory-user-content-card=""]');
    expect(userContent).toBeTruthy();
    expect(userContent?.className).toContain("max-h-64");
    expect(userContent?.className).toContain("overflow-hidden");
    expect(userContent?.className).not.toContain("overflow-auto");
    expect(userContent?.className).toContain("px-3");
    expect(userContent?.className).toContain("pt-0");
    expect(userContent?.className).toContain("pb-2");
    expect(userContent?.className).not.toContain("bg-surface");
    expect(userContent?.className).not.toContain("rounded-md");
    Object.defineProperties(userContent as HTMLElement, {
      clientHeight: { configurable: true, value: 256 },
      scrollHeight: { configurable: true, value: 512 },
    });
    fireEvent(window, new Event("resize"));
    expect(userContent?.className).toContain("pb-14");
    expect(userContainer?.querySelector('[data-trajectory-content-actions=""]')).toBeNull();
    expect(userContent?.getAttribute("data-overflow-clipped")).toBe("true");
    expect(readFileSync("packages/ui/src/ModelTrajectoryExpandedContent.tsx", "utf8")).toContain(
      "black calc(100% - 72px)",
    );
    expect(userContainer?.querySelector('[data-trajectory-overflow-copy=""]')).toBeNull();
    const overflowToggle = userContainer?.querySelector<HTMLButtonElement>(
      '[data-trajectory-overflow-toggle=""]',
    );
    expect(overflowToggle?.dataset.size).toBe("sm");
    expect(overflowToggle?.className).toContain("bg-surface/90");
    expect(overflowToggle?.className).toContain("supports-[backdrop-filter]:bg-surface/70");
    expect(overflowToggle?.className).toContain("supports-[backdrop-filter]:backdrop-blur-md");
    expect(overflowToggle?.parentElement?.className).toContain(
      "bottom-3 left-1/2 -translate-x-1/2",
    );
    fireEvent.click(copyButton as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith("summary message\nfull user message");
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(userContent?.className).not.toContain("max-h-64");
    expect(userContent?.hasAttribute("data-overflow-clipped")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(userContent?.className).toContain("max-h-64");

    const toolTrigger = screen.getByRole("button", {
      name: /工具结果输出file body second output line/,
    });
    const toolName = toolTrigger.querySelector('[data-trajectory-tool-result-name=""]');
    const toolCallId = toolTrigger.querySelector('[data-trajectory-tool-result-id=""]');
    expect(toolTrigger.querySelector('[data-trajectory-payload-direction=""]')?.textContent).toBe(
      "输出",
    );
    expect(
      toolTrigger.querySelector('[data-trajectory-payload-direction=""]')?.className,
    ).toContain("text-foreground");
    expect(
      toolTrigger.querySelector('[data-trajectory-payload-direction=""]')?.className,
    ).toContain("text-ui-sm");
    expect(
      toolTrigger.querySelector('[data-trajectory-payload-direction=""]')?.className,
    ).not.toContain("w-12");
    expect(
      toolTrigger.querySelector('[data-trajectory-payload-arrow=""]')?.className.baseVal,
    ).toContain("text-foreground-subtlest");
    expect(toolName?.textContent).toBe("Read");
    expect(toolCallId?.textContent).toBe("tool-call-1");
    expect(toolName?.className).toContain("rounded-full");
    expect(toolName?.className).not.toContain("truncate");
    expect(toolName?.className).not.toContain("max-w-");
    expect(toolName?.className).toContain("group-data-[state=open]:hidden");
    expect(toolCallId?.className).toContain("rounded-full");
    expect(toolCallId?.className).toContain("group-data-[state=open]:hidden");
    expect(
      toolName?.compareDocumentPosition(toolCallId as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(toolTrigger.dataset.state).toBe("open");
    const toolContainer = container.querySelector(
      '[data-trajectory-expandable-role="tool-result"]',
    );
    expect(toolContainer?.getAttribute("data-trajectory-row-alt")).toBe("true");
    const toolContent = toolContainer?.querySelector('[data-trajectory-message-content=""]');
    expect(toolContent?.textContent).toContain("file body\nsecond output line");
    expect(toolContent?.querySelector('[data-trajectory-expanded-tool-name=""]')?.textContent).toBe(
      "Read",
    );
    expect(toolContent?.querySelector('[data-trajectory-expanded-tool-id=""]')?.textContent).toBe(
      "tool-call-1",
    );
    const toolCopy = toolContainer?.querySelector<HTMLButtonElement>(
      '[data-trajectory-message-copy=""]',
    );
    expect(toolCopy).toBeTruthy();
    fireEvent.click(toolCopy as HTMLButtonElement);
    expect(writeText).toHaveBeenLastCalledWith("file body\nsecond output line");
    expect(toolContainer?.querySelector('[data-trajectory-message-expanded-card=""]')).toBeNull();

    expect(container.querySelector('[data-trajectory-assistant-title=""]')).toBeNull();
    expect(container.querySelector('[data-trajectory-assistant-detail-card=""]')).toBeNull();
    const reasoningRow = screen.getByRole("button", { name: /思考过程inspect the file/ });
    const assistantMessageRow = screen.getByRole("button", { name: /助手消息file inspected/ });
    const assistantToolRow = screen.getByRole("button", {
      name: /工具调用输入.*path.*\/tmp\/a\.ts/,
    });
    expect(container.querySelector('[data-trajectory-role-line="assistant"]')).toBeNull();
    expect(
      container.querySelector('[data-trajectory-role-label="assistant"]')?.className,
    ).toContain("text-trajectory-assistant/80");
    expect(container.querySelector('[data-trajectory-role-line="tool"]')).toBeNull();
    expect(assistantToolRow.textContent).toContain('{"path":"/tmp/a.ts"}');
    expect(
      assistantToolRow.querySelector('[data-trajectory-payload-direction=""]')?.textContent,
    ).toBe("输入");
    expect(
      assistantToolRow.querySelector('[data-trajectory-payload-arrow=""]')?.className.baseVal,
    ).toContain("group-data-[state=open]:hidden");
    expect(reasoningRow.dataset.state).toBe("open");
    expect(assistantMessageRow.dataset.state).toBe("open");
    expect(assistantToolRow.dataset.state).toBe("open");
    expect(reasoningRow.querySelector('[data-trajectory-message-preview=""]')?.textContent).toBe(
      "inspect the file reasoning detail",
    );
    expect(
      assistantMessageRow.querySelector('[data-trajectory-message-preview=""]')?.textContent,
    ).toBe("file inspected message detail");
    expect(
      reasoningRow
        .closest('[data-trajectory-message-collapsible=""]')
        ?.querySelector('[data-trajectory-message-content=""]'),
    ).toBeTruthy();
    expect(
      assistantMessageRow
        .closest('[data-trajectory-message-collapsible=""]')
        ?.querySelector('[data-trajectory-message-content=""]'),
    ).toBeTruthy();
    expect(screen.getAllByText(/reasoning detail/)).toHaveLength(2);
    expect(screen.getAllByText(/message detail/)).toHaveLength(2);
    expect(
      container.querySelector('[data-trajectory-response-section=""] [data-state="open"]'),
    ).toBeTruthy();
    expect(
      assistantToolRow.querySelector('[data-trajectory-tool-result-name=""]')?.textContent,
    ).toBe("Read");
    expect(assistantToolRow.querySelector('[data-trajectory-tool-result-id=""]')?.textContent).toBe(
      "tool-call-1",
    );

    expect(screen.queryByText("工具结果 · Read")).toBeNull();
    expect(screen.queryByText("工具调用 · Read")).toBeNull();
    expect(
      assistantToolRow
        .closest('[data-trajectory-message-collapsible=""]')
        ?.querySelector('[data-trajectory-message-content=""]')?.textContent,
    ).toContain("/tmp/a.ts");
    const assistantToolContent = assistantToolRow
      .closest('[data-trajectory-message-collapsible=""]')
      ?.querySelector('[data-trajectory-message-content=""]');
    const assistantToolPayload = assistantToolContent?.querySelector("pre");
    expect(
      assistantToolContent?.querySelector('[data-trajectory-expanded-tool-name=""]')?.textContent,
    ).toBe("Read");
    expect(
      assistantToolContent?.querySelector('[data-trajectory-expanded-tool-id=""]')?.textContent,
    ).toBe("tool-call-1");
    expect(assistantToolPayload?.className).toContain("whitespace-pre-wrap");
    expect(assistantToolPayload?.className).not.toContain("bg-surface");
    expect(assistantToolPayload?.className).not.toContain("rounded");
    expect(assistantToolContent?.textContent).not.toContain("输入");
  });

  it("shows full sidecar prompts instead of applying main-session deltas", () => {
    const result = resolveTrajectoryInputMessages({
      index: 1,
      previousConversationMessageCount: 5,
      record: {
        attempt: 1,
        callSource: { kind: "sidecar", querySource: "session_title" },
        model: { modelId: "glm-test", role: "lite" },
        request: {
          messages: [
            {
              role: "system",
              parts: [{ kind: "text", text: "Generate a concise title" }],
            },
            { role: "user", parts: [{ kind: "text", text: "你好" }] },
          ],
          toolNames: [],
        },
        requestId: "req-title",
        startedAt: "2026-06-03T12:00:01.000Z",
      },
    });

    expect(result.inputMessages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(result.nextConversationMessageCount).toBe(5);
  });
});
