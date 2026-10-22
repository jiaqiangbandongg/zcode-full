// @vitest-environment jsdom

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
    expect(systemCopy?.className).toContain("group-data-[state=open]:inline-flex");
    expect(systemContainer?.querySelector('[data-trajectory-overflow-copy=""]')).toBeNull();
    fireEvent.click(systemCopy as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith(" \n system summary\nfull system prompt\n \n");
    expect(systemContainer?.querySelector('[data-trajectory-overflow-toggle=""]')).toBeNull();
    const systemContent = systemContainer?.querySelector('[data-trajectory-message-content=""]');
    expect(systemContent?.textContent).toBe("system summary\nfull system prompt");
    expect(systemContent?.className).toContain("max-h-64");
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
    const userMetadata = container.querySelector('[data-trajectory-user-call-metadata=""]');
    expect(userMetadata?.textContent).toContain("21.7s");
    expect(
      container.querySelector('[data-trajectory-user-call-datetime=""]')?.getAttribute("title"),
    ).toBe("2026-06-03T12:00:00.000Z");
    const copyButton = userContainer?.querySelector<HTMLButtonElement>(
      '[data-trajectory-message-copy=""]',
    );
    expect(container.querySelector('[data-trajectory-user-summary-card=""]')).toBeTruthy();
    const userContent = container.querySelector('[data-trajectory-user-content-card=""]');
    expect(userContent).toBeTruthy();
    expect(userContent?.className).toContain("max-h-64");
    Object.defineProperties(userContent as HTMLElement, {
      clientHeight: { configurable: true, value: 256 },
      scrollHeight: { configurable: true, value: 512 },
    });
    fireEvent(window, new Event("resize"));
    expect(userContent?.className).toContain("pb-14");
    expect(userContainer?.querySelector('[data-trajectory-content-actions=""]')).toBeNull();
    expect(userContent?.getAttribute("data-overflow-clipped")).toBe("true");
    expect(userContainer?.querySelector('[data-trajectory-overflow-copy=""]')).toBeNull();
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
    expect(toolName?.textContent).toBe("Read");
    expect(toolCallId?.textContent).toBe("tool-call-1");
    expect(toolName?.className).toContain("group-data-[state=open]:hidden");
    expect(toolCallId?.className).toContain("group-data-[state=open]:hidden");
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
    expect(
      assistantToolContent?.querySelector('[data-trajectory-expanded-tool-name=""]')?.textContent,
    ).toBe("Read");
    expect(
      assistantToolContent?.querySelector('[data-trajectory-expanded-tool-id=""]')?.textContent,
    ).toBe("tool-call-1");
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
