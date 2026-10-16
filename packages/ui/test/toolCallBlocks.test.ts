// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ToolCallBlock } from "../src/ToolCallBlocks.js";
import { ToolCallBody } from "../src/ToolCallBlocks/ToolCallBody.js";
import { readRawToolCallFileSummaries } from "../src/ToolCallBlocks/shared.js";
import { isExploreToolCall } from "../src/lib/exploreToolCall.js";
import { buildToolDisplayModel } from "../src/lib/toolDisplay.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";

vi.mock("@/ToolCallBlocks/renderers/switch-mode.js", () => ({
  SwitchModeToolCallBlock: ({
    toolCallNode,
  }: {
    toolCallNode: {
      toolCall: {
        toolId: string;
        title?: string;
        kind: string;
      };
    };
  }) =>
    createElement(
      "div",
      { "data-testid": "mock-switch-mode-panel" },
      `switch-mode:${toolCallNode.toolCall.toolId}:${toolCallNode.toolCall.title ?? ""}:${toolCallNode.toolCall.kind}`,
    ),
}));

// CreateWorkflow renderer 只回显它**收到的上下文**：这条 mock 存在的理由是一个真实 bug——
// onOpenWorkflowRun 曾经被透传给子工具卡却从未进 renderContext，于是聊天卡永远拿不到
// run 详情入口（表现是「入口找不到」，成因却在这层装配里）。
vi.mock("@/ToolCallBlocks/renderers/create-workflow.js", () => ({
  CreateWorkflowToolCallBlock: ({
    onOpenWorkflowRun,
    workflowRun,
  }: {
    onOpenWorkflowRun?: () => void;
    workflowRun?: { runId: string };
  }) =>
    createElement("div", {
      "data-testid": "mock-create-workflow-panel",
      "data-has-open-run": String(typeof onOpenWorkflowRun === "function"),
      "data-run-id": workflowRun?.runId ?? "",
    }),
}));

vi.mock("@/ToolCallBlocks/renderers/plan-guidance.js", () => ({
  PlanGuidanceToolCallBlock: ({
    toolCallNode,
  }: {
    toolCallNode: {
      toolCall: {
        toolId: string;
        title?: string;
        kind: string;
      };
    };
  }) =>
    createElement(
      "div",
      { "data-testid": "mock-plan-guidance-panel" },
      `plan-guidance:${toolCallNode.toolCall.toolId}:${toolCallNode.toolCall.title ?? ""}:${toolCallNode.toolCall.kind}`,
    ),
}));

vi.mock("@/ToolCallBlocks/renderers/agent.js", () => ({
  AgentToolCallBlock: ({
    toolCallNode,
    sourceLabel,
  }: {
    toolCallNode: {
      toolCall: {
        toolId: string;
        title?: string;
        kind: string;
      };
    };
    sourceLabel?: string;
  }) =>
    createElement(
      "div",
      { "data-testid": "mock-agent-panel" },
      `agent:${toolCallNode.toolCall.toolId}:${toolCallNode.toolCall.title ?? ""}:${toolCallNode.toolCall.kind}:source:${sourceLabel ?? "none"}`,
    ),
}));

afterEach(cleanup);

describe("isExploreToolCall", () => {
  it("does not classify redirect write commands as explore", () => {
    const result = isExploreToolCall({
      kind: "execute",
      input: {
        command: ["/bin/zsh", "-lc", "cat > index.html <<'EOF' <!doctype html>"],
      },
    });

    expect(result).toBe(false);
  });
});

describe("ToolCallBlock agent routing", () => {
  it("renders compact trusted MCP labels from the real plugin-scoped payload", () => {
    const row: ToolCallRow = {
      rowId: 3,
      turnId: "turn-1",
      createdAt: 1_700_000_000_002,
      createdAtSeq: 3,
      kind: "toolCall",
      toolCallId: "call-mcp",
      toolName: "mcp__plugin_firebase_firebase__firebase_get_environment",
      status: "success",
      inputText: '{"query":"is:open"}',
      input: { query: "is:open" },
      output: { text: "12 issues" },
      display: {
        kind: "mcp_tool",
        serverName: "plugin:firebase:firebase",
        toolName: "firebase_get_environment",
        description: "Retrieve the current Firebase environment configuration.",
      },
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(ToolCallBlock, {
            toolCallNode: toolCallRowToLegacyNode(row),
            workspacePath: "/workspace",
          }),
        ),
      ),
    );

    expect(html).toContain(">MCP<");
    expect(html).toContain("Get environment");
    expect(html).toContain('class="text-foreground-subtle">Firebase</span>');
    expect(html).not.toContain('class="text-foreground-subtlest">·</span><span class="text-foreground-subtle">Firebase</span>');
    expect(html).not.toMatch(/class="[^"]*(?:border|bg-background-alt)[^"]*">Firebase<\/span>/u);
    expect(html).not.toContain("Plugin:firebase:firebase");
    expect(html).not.toContain("Firebase get environment");
    expect(html).not.toContain(">mcp__plugin_firebase_firebase__firebase_get_environment<");
    expect(html).not.toContain("&quot;toolId&quot;");
    expect(html).not.toContain("已执行");
  });

  it("renders historical MCP rows without display through the MCP summary and detail", () => {
    const syntheticName = "mcp__plugin_firebase_firebase__firebase_get_environment";
    const row: ToolCallRow = {
      rowId: 31,
      turnId: "turn-legacy",
      createdAt: 1_700_000_000_031,
      createdAtSeq: 31,
      kind: "toolCall",
      toolCallId: "call-mcp-legacy-stopped",
      toolName: syntheticName,
      status: "cancelled",
      inputText: "{}",
      input: {},
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: toolCallRowToLegacyNode(row),
          workspacePath: "/workspace",
        }),
      ),
    );

    const summary = screen.getByTestId("tool-summary-trigger-call-mcp-legacy-stopped");
    expect(summary.textContent).toContain("MCP");
    expect(summary.textContent).toContain("Firebase");
    expect(summary.textContent).toContain("Get environment");
    expect(summary.textContent).toContain("已停止");
    expect(summary.innerHTML).toContain(">·</span>");
    expect(summary.textContent).not.toContain(syntheticName);

    fireEvent.click(summary);
    expect(screen.queryByTestId("mcp-expanded-content")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看调用详情" })).toBeNull();
    expect(screen.queryByText("PARAMETERS")).toBeNull();
    expect(screen.queryByText(syntheticName)).toBeNull();
    expect(screen.queryByText(/toolId/u)).toBeNull();
  });

  it("shows only the result first and keeps MCP metadata in secondary call details", () => {
    const description = "Retrieve the current Firebase environment configuration.";
    const row: ToolCallRow = {
      rowId: 4,
      turnId: "turn-1",
      createdAt: 1_700_000_000_003,
      createdAtSeq: 4,
      kind: "toolCall",
      toolCallId: "call-mcp-detail",
      toolName: "mcp__plugin_firebase_firebase__firebase_get_environment",
      status: "success",
      inputText: '{"projectId":"demo"}',
      input: { projectId: "demo" },
      output: { text: "No firebase.json file was found." },
      display: {
        kind: "mcp_tool",
        serverName: "plugin:firebase:firebase",
        toolName: "firebase_get_environment",
        description,
      },
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: toolCallRowToLegacyNode(row),
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(screen.queryByText(description)).toBeNull();
    const summary = screen.getByTestId("tool-summary-trigger-call-mcp-detail");
    fireEvent.click(summary);
    expect(screen.getByTestId("mcp-result-surface").className).toContain("rounded-xl");
    expect(screen.getByTestId("mcp-result-surface").className).toContain("border-border");
    expect(screen.queryByText("Result")).toBeNull();
    expect(screen.queryByText("Parameters")).toBeNull();
    expect(screen.queryByText(description)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看调用详情" }));
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByText("调用参数")).toBeTruthy();
  });

  it.each([
    ["inputStreaming", "等待中", false],
    ["pendingApproval", "等待中", false],
    ["running", "执行中", true],
    ["cancelled", "已停止", false],
  ] as const)("controls %s MCP detail availability", (status, label, canExpand) => {
    const row: ToolCallRow = {
      rowId: 5,
      turnId: "turn-1",
      createdAt: 1_700_000_000_004,
      createdAtSeq: 5,
      kind: "toolCall",
      toolCallId: `call-mcp-${status}`,
      toolName: "opaque-provider-name",
      status,
      inputText: "{}",
      input: {},
      display: {
        kind: "mcp_tool",
        serverName: "firebase",
        toolName: "get_environment",
      },
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: toolCallRowToLegacyNode(row),
          workspacePath: "/workspace",
        }),
      ),
    );

    const summary = screen.getByTestId(`tool-summary-trigger-call-mcp-${status}`);
    if (status === "inputStreaming" || status === "pendingApproval" || status === "running") {
      expect(summary.textContent).not.toContain(label);
    } else {
      expect(summary.textContent).toContain(label);
      expect(
        Array.from(summary.querySelectorAll("span")).filter(
          (element) => element.textContent === "·",
        ),
      ).toHaveLength(2);
    }
    fireEvent.click(summary);
    if (canExpand) {
      expect(screen.getByTestId("mcp-expanded-content").textContent).toContain(label);
    } else {
      expect(screen.queryByTestId("mcp-expanded-content")).toBeNull();
    }
  });

  it("shows the MCP failure result before call details", () => {
    const row: ToolCallRow = {
      rowId: 6,
      turnId: "turn-1",
      createdAt: 1_700_000_000_005,
      createdAtSeq: 6,
      kind: "toolCall",
      toolCallId: "call-mcp-failed",
      toolName: "opaque-provider-name",
      status: "error",
      inputText: "{}",
      input: {},
      error: { code: "tool_failed", message: "Firebase authentication failed." },
      display: {
        kind: "mcp_tool",
        serverName: "firebase",
        toolName: "get_environment",
      },
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: toolCallRowToLegacyNode(row),
          workspacePath: "/workspace",
        }),
      ),
    );

    const summary = screen.getByTestId("tool-summary-trigger-call-mcp-failed");
    expect(
      Array.from(summary.querySelectorAll("span")).filter(
        (element) => element.textContent === "·",
      ),
    ).toHaveLength(2);
    fireEvent.click(summary);
    const detail = screen.getByTestId("mcp-expanded-content");
    expect(detail.textContent).toContain("Firebase authentication failed.");
    expect(detail.textContent).toContain("查看调用详情");
    expect(screen.getByTestId("mcp-error-surface").className).toContain("bg-destructive/10");
  });

  it("uses the BUA bounded code surface for multiline MCP results", () => {
    const row: ToolCallRow = {
      rowId: 7,
      turnId: "turn-1",
      createdAt: 1_700_000_000_006,
      createdAtSeq: 7,
      kind: "toolCall",
      toolCallId: "call-mcp-long-result",
      toolName: "opaque-provider-name",
      status: "success",
      inputText: "{}",
      input: {},
      output: { text: '{\n  "project": "demo"\n}' },
      display: {
        kind: "mcp_tool",
        serverName: "firebase",
        toolName: "get_environment",
      },
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(ToolCallBlock, {
            toolCallNode: toolCallRowToLegacyNode(row),
            workspacePath: "/workspace",
          }),
        ),
      ),
    );

    fireEvent.click(screen.getByTestId("tool-summary-trigger-call-mcp-long-result"));
    const surface = screen.getByTestId("mcp-result-surface");
    expect(surface.className).toContain("max-h-72");
    expect(screen.getByRole("button", { name: "复制结果" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换自动换行" })).toBeTruthy();
  });

  it("renders adapted v4 output-only tool failures as an error surface", () => {
    const row: ToolCallRow = {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "toolCall",
      toolCallId: "call-failed",
      toolName: "Bash",
      status: "error",
      inputText: '{"command":"cat /workspace/secret.txt"}',
      input: { command: "cat /workspace/secret.txt" },
      output: {
        text: "<tool_use_error>Permission denied: /workspace/secret.txt</tool_use_error>",
      },
    };

    const toolCall = toolCallRowToLegacyNode(row).toolCall;
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBody, {
          childToolList: null,
          displayModel: buildToolDisplayModel(toolCall),
          toolCall,
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("Error");
    expect(html).toContain("Permission denied: /workspace/secret.txt");
    expect(html).not.toContain("&lt;tool_use_error&gt;");
  });

  it("keeps adapted v4 successful tool output on the normal result surface", () => {
    const row: ToolCallRow = {
      rowId: 2,
      turnId: "turn-1",
      createdAt: 1_700_000_000_001,
      createdAtSeq: 2,
      kind: "toolCall",
      toolCallId: "call-success",
      toolName: "Bash",
      status: "success",
      inputText: '{"command":"echo ok"}',
      input: { command: "echo ok" },
      output: { text: "ok" },
    };

    const toolCall = toolCallRowToLegacyNode(row).toolCall;
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBody, {
          childToolList: null,
          displayModel: buildToolDisplayModel(toolCall),
          toolCall,
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("Result");
    expect(html).not.toContain("Error");
  });

  it("routes Task tool calls to the agent renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-task-agent",
              kind: "think",
              title: "Task",
              input: {
                prompt: "搜索今日新闻",
                run_in_background: true,
              },
              output: [],
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("agent:tool-task-agent:Task:think:source:none");
  });

  it("routes GLM Agent tool calls to the agent renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-glm-agent",
              kind: "think",
              title: "Agent",
              input: {
                description: "Find runtime loop",
                prompt: "Find where the runtime injects tool results.",
              },
              output: {
                status: "completed",
                agentId: "agent-glm-explore",
                agentType: "Explore",
              },
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("agent:tool-glm-agent:Agent:think:source:none");
  });

  it("routes spawn_agent tool calls to the agent renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-spawn-agent",
              kind: "spawn_agent",
              title: "spawn_agent",
              input: {
                agent_type: "explorer",
                message: "检查当前项目结构",
              },
              output: {
                agent_id: "agent-1",
                nickname: "Locke",
              },
              status: "completed",
              raw: {
                name: "spawn_agent",
                _meta: {
                  zcode: {
                    toolName: "spawn_agent",
                    nickname: "Locke",
                  },
                },
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("agent:tool-spawn-agent:spawn_agent:spawn_agent:source:none");
  });
});

describe("readRawToolCallFileSummaries", () => {
  it("does not infer edit summaries from read tool content keywords", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        kind: "read",
        status: "completed",
        rawInput: {
          file_path: "/Users/dev/ZCodeProject/demo/snake/index.html",
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "function deleteFood() { return writeScore(); }",
            },
          },
        ],
      },
      {
        kind: "read",
        title: "Read snake/index.html",
        input: {
          file_path: "/Users/dev/ZCodeProject/demo/snake/index.html",
        },
      },
    );

    expect(summaries).toEqual([]);
  });

  it("routes read tools to the read renderer even if raw summaries exist", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-read-weird",
              kind: "read",
              title: "Read snake/index.html",
              input: {
                file_path: "/Users/dev/ZCodeProject/demo/snake/index.html",
              },
              output: {
                content: "function deleteFood() { return writeScore(); }",
              },
              status: "completed",
              raw: {
                kind: "read",
                changes: {
                  "/Users/dev/ZCodeProject/demo/snake/index.html": {
                    type: "add",
                    content: "unexpected",
                  },
                },
                rawInput: {
                  file_path: "/Users/dev/ZCodeProject/demo/snake/index.html",
                },
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("读取");
    expect(html).toMatch(
      /class="[^"]*tool-summary-kind-label[^"]*@max-\[360px\]\/conversation:hidden/,
    );
    expect(html).toMatch(/class="[^"]*tool-summary-content[^"]*flex-1[^"]*overflow-hidden/);
    expect(html).toMatch(
      /class="[^"]*text-foreground-subtlest[^"]*@max-\[360px\]\/conversation:hidden/,
    );
    expect(html).not.toContain("主 Agent");
    expect(html).not.toContain("SubAgent");
    expect(html).toContain("index.html");
    expect(html).not.toContain("已写入");
    expect(html).not.toContain("已删除");
    expect(html).not.toContain("已编辑");
  });

  it("does not infer edit summaries for explore nodes backed by Read tool metadata", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        _meta: {
          claudeCode: {
            toolName: "Read",
          },
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "function deleteFood() { return writeScore(); }",
            },
          },
        ],
        rawOutput: "...",
        status: "completed",
        sessionUpdate: "tool_call_update",
      },
      {
        kind: "explore",
        title: "Read snake/game.ts",
        input: {
          file_path: "/Users/dev/ZCodeProject/demo/snake/game.ts",
        },
      },
    );

    expect(summaries).toEqual([]);
  });

  it("reads multi-file ZCode tool display summaries", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        display: {
          kind: "file_diffs",
          files: [
            {
              filePath: "/workspace/src/a.ts",
              additions: 2,
              deletions: 1,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-old", "+new"],
                },
              ],
            },
            {
              filePath: "/workspace/src/b.ts",
              additions: 3,
              deletions: 0,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  lines: ["+created"],
                },
              ],
            },
          ],
        },
      },
      {
        kind: "ApplyPatch",
        title: "Edited 2 files",
        input: {},
      },
    );

    expect(summaries).toHaveLength(2);
    expect(summaries.map((summary) => summary.changeStat)).toEqual([
      { added: 2, removed: 1 },
      { added: 3, removed: 0 },
    ]);
    expect(summaries[1]?.patch).toContain("+created");
  });

  it("does not build delete summaries for non-writable execute tools even with raw changes", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        kind: "execute",
        changes: {
          "/Users/dev/ZCodeProject/demo/snake/game.ts": {
            type: "delete",
            oldText: "console.log('legacy');",
          },
        },
        rawInput: {
          path: "/Users/dev/ZCodeProject/demo/snake/game.ts",
        },
      },
      {
        kind: "execute",
        title: "Run cleanup command",
        input: {
          command: "rm game.ts",
        },
      },
    );

    expect(summaries).toEqual([]);
  });

  it("does not infer delete from explore text without writable tool kind", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        status: "completed",
        rawInput: {
          file_path: "/Users/dev/ZCodeProject/demo/snake/game.ts",
          description: "Delete legacy fallback after inspection",
        },
      },
      {
        kind: "explore",
        title: "Inspect game.ts",
        input: {
          file_path: "/Users/dev/ZCodeProject/demo/snake/game.ts",
          description: "Delete legacy fallback after inspection",
        },
      },
    );

    expect(summaries).toEqual([]);
  });

  it("normalizes hunk-only add patches as newly created files", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        changes: {
          "src/demo.ts": {
            type: "add",
            unified_diff: "@@ -0,0 +1,2 @@\n+export const value = 1;\n+export { value };",
          },
        },
      },
      {
        kind: "write",
        title: "Write src/demo.ts",
        input: {
          path: "src/demo.ts",
        },
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.patch).toContain("--- /dev/null");
    expect(summaries[0]?.patch).toContain("+++ b/demo.ts");
  });

  it("builds write summaries from ZCode protocol input payloads", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        toolName: "Write",
        input: {
          file_path: "src/quicksort.js",
          content: "export const quicksort = () => [];\n",
        },
      },
      {
        kind: "Write",
        title: "Write",
        raw: {
          toolName: "Write",
          input: {
            file_path: "src/quicksort.js",
            content: "export const quicksort = () => [];\n",
          },
        },
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.path).toBe("src/quicksort.js");
    expect(summaries[0]?.operationKind).toBe("write");
    expect(summaries[0]?.changeStat).toEqual({ added: 1, removed: 0 });
  });

  it("builds edit summaries from ZCode protocol input payloads", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        toolName: "Edit",
        input: {
          file_path: "src/quicksort.js",
          old_string: "return left.concat(pivot, right);",
          new_string: "return [...left, pivot, ...right];",
        },
      },
      {
        kind: "Edit",
        title: "Edit",
        raw: {
          toolName: "Edit",
          input: {
            file_path: "src/quicksort.js",
            old_string: "return left.concat(pivot, right);",
            new_string: "return [...left, pivot, ...right];",
          },
        },
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.path).toBe("src/quicksort.js");
    expect(summaries[0]?.operationKind).toBe("edit");
    expect(summaries[0]?.changeStat).toEqual({ added: 1, removed: 1 });
  });

  it("drops multi-file unified diff payloads and falls back to single-file patch", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        changes: {
          "src/demo.ts": {
            type: "update",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
            unified_diff:
              "diff --git a/src/demo.ts b/src/demo.ts\n--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n" +
              "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-console.log('a');\n+console.log('b');",
          },
        },
      },
      {
        kind: "edit",
        title: "Edit src/demo.ts",
        input: {
          path: "src/demo.ts",
        },
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.patch).toContain("--- a/demo.ts");
    expect(summaries[0]?.patch).toContain("+++ b/demo.ts");
    expect(summaries[0]?.patch).not.toContain("src/other.ts");
  });

  it("drops truncated second-file hunks in multi-file unified diff payloads", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        changes: {
          "src/demo.ts": {
            type: "update",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
            // 回归场景：第二个文件 hunk 被流式截断时，仍应识别为多文件并触发 fallback。
            unified_diff:
              "--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n" +
              "--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-console.log('a');",
          },
        },
      },
      {
        kind: "edit",
        title: "Edit src/demo.ts",
        input: {
          path: "src/demo.ts",
        },
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.patch).toContain("--- a/demo.ts");
    expect(summaries[0]?.patch).toContain("+++ b/demo.ts");
    expect(summaries[0]?.patch).not.toContain("src/other.ts");
  });

  it("keeps single-file patches when hunk content contains header-like lines", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        changes: {
          "src/demo.ts": {
            type: "update",
            // 回归场景：正文里以 --- / +++ 开头的文本不应被识别成额外文件头。
            unified_diff:
              "--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1,2 +1,2 @@\n const marker = true;\n--- header-like-old-line\n+++ header-like-new-line",
          },
        },
      },
      {
        kind: "edit",
        title: "Edit src/demo.ts",
        input: {
          path: "src/demo.ts",
        },
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.patch).toContain("--- a/src/demo.ts");
    expect(summaries[0]?.patch).toContain("+++ b/src/demo.ts");
    expect(summaries[0]?.patch).toContain("--- header-like-old-line");
    expect(summaries[0]?.patch).toContain("+++ header-like-new-line");
  });

  it("keeps read-like explore nodes out of edit renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-explore-read-like",
              kind: "explore",
              title: "Read snake/game.ts",
              input: {
                file_path: "/Users/dev/ZCodeProject/demo/snake/game.ts",
              },
              output: "...",
              status: "completed",
              raw: {
                _meta: {
                  claudeCode: {
                    toolName: "Read",
                  },
                },
                content: [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: "function deleteFood() { return writeScore(); }",
                    },
                  },
                ],
                rawOutput: "...",
                status: "completed",
                toolCallId: "call_bcbf3d3258d34b44b3dbc0b4",
                sessionUpdate: "tool_call_update",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).not.toContain("已写入");
    expect(html).not.toContain("已删除");
    expect(html).not.toContain("已编辑");
  });

  it("keeps execute tools with delete-like raw changes out of edit renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-execute-delete-like",
              kind: "execute",
              title: "Run cleanup",
              input: {
                command: "rm snake/game.ts",
              },
              output: {
                stdout: "cleanup finished",
              },
              status: "completed",
              raw: {
                kind: "execute",
                changes: {
                  "/Users/dev/ZCodeProject/demo/snake/game.ts": {
                    type: "delete",
                    oldText: "console.log('legacy');",
                  },
                },
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("终端");
    expect(html).not.toContain("已删除");
    expect(html).not.toContain("已编辑");
    expect(html).not.toContain("Deleting");
    expect(html).not.toContain("Deleted");
  });

  it("把 dwf run 入口与 run 摘要交到 CreateWorkflow renderer 手里", () => {
    // 回归：这两个 prop 之前只被透传给**子**工具卡，从未进过 renderContext，于是 run 态卡片
    // 和它的详情页入口在生产里根本不存在。装配这一层必须自己被钉住。
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-create-workflow",
              kind: "CreateWorkflow",
              title: "CreateWorkflow",
              input: { name: "Fan-out review", script: "const x = 1;" },
              status: "completed",
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
          onOpenWorkflowRun: () => {},
          workflowRun: {
            runId: "dwfrun-42",
            status: "running" as const,
            nodesSettled: 3,
            nodesTotal: 7,
          },
        }),
      ),
    );

    expect(html).toContain("mock-create-workflow-panel");
    expect(html).toContain('data-has-open-run="true"');
    expect(html).toContain('data-run-id="dwfrun-42"');
  });

  it("routes switch_mode tool calls to the dedicated renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-switch-mode",
              kind: "switch_mode",
              title: "Exited Plan Mode",
              input: {
                plan: "# 输出计划\n\n- 渲染 markdown",
              },
              output: "...",
              status: "completed",
              raw: {
                rawOutput: "...",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("mock-switch-mode-panel");
    expect(html).toContain("switch-mode:tool-switch-mode:Exited Plan Mode:switch_mode");
  });

  it("routes Exited Plan Mode titles to the switch mode renderer even when kind is other", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-exited-plan-title",
              kind: "other",
              title: "Exited Plan Mode",
              input: {
                plan: "# 输出计划\n\n- 渲染 markdown",
              },
              output: "...",
              status: "completed",
              raw: {
                rawOutput: "...",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("mock-switch-mode-panel");
    expect(html).toContain("switch-mode:tool-exited-plan-title:Exited Plan Mode:other");
  });

  it("routes current ExitPlanMode tool calls to the switch mode renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-exit-plan-current",
              kind: "ExitPlanMode",
              title: "ExitPlanMode",
              input: {
                plan: "# 输出计划\n\n- 渲染 markdown",
              },
              output: "...",
              status: "completed",
              raw: {
                toolName: "ExitPlanMode",
                rawOutput: "...",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("mock-switch-mode-panel");
    expect(html).toContain("switch-mode:tool-exit-plan-current:ExitPlanMode:ExitPlanMode");
  });

  it("routes EnterPlanMode titles to the plan guidance renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-enter-plan-guidance",
              kind: "other",
              title: "EnterPlanMode",
              input: {},
              output: "Entered plan mode.",
              status: "completed",
              raw: {
                _meta: {
                  claudeCode: {
                    toolName: "EnterPlanMode",
                  },
                },
                rawOutput: "Entered plan mode.",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("mock-plan-guidance-panel");
    expect(html).toContain("plan-guidance:tool-enter-plan-guidance:EnterPlanMode:other");
  });

  it("routes TodoWrite to the todo renderer instead of the file write renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-todo-write",
              kind: "TodoWrite",
              title: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "更新 index.html 标题",
                    priority: "high",
                    status: "in_progress",
                  },
                  {
                    content: "创建番茄时钟组件",
                    priority: "medium",
                    status: "pending",
                  },
                ],
              },
              output: JSON.stringify({
                oldTodos: [],
                todos: [
                  {
                    content: "更新 index.html 标题",
                    priority: "high",
                    status: "in_progress",
                  },
                  {
                    content: "创建番茄时钟组件",
                    priority: "medium",
                    status: "pending",
                  },
                ],
              }),
              status: "completed",
              raw: {
                toolCallId: "tool-todo-write",
                toolName: "TodoWrite",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("待办");
    expect(html).toContain("更新 index.html 标题");
    expect(html).toContain("0/2");
    expect(html).not.toContain("已写入");
  });

  it("routes fixed AskUserQuestion tools without renaming the tool identity", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-ask-user-question",
              toolName: "AskUserQuestion",
              kind: "AskUserQuestion",
              title: "AskUserQuestion",
              input: {
                questions: [
                  {
                    id: "q1",
                    question: "选择实现方向？",
                    options: [
                      { id: "safe", label: "稳妥" },
                      { id: "fast", label: "快速" },
                    ],
                  },
                ],
                answers: {
                  "选择实现方向？": "稳妥",
                },
              },
              status: "completed",
              raw: {
                toolName: "AskUserQuestion",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("已询问");
    expect(html).toContain("1 个问题");
    expect(html).toContain("AskUserQuestion");
    expect(html).not.toContain("AskQuestion");
    expect(html).not.toContain("已写入");
  });

  it("shows an automatic-continuation history label for explicit empty answers", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-ask-auto-continued",
              toolName: "AskUserQuestion",
              kind: "AskUserQuestion",
              title: "AskUserQuestion",
              input: {
                questions: [
                  {
                    id: "q1",
                    question: "选择实现方向？",
                    options: [
                      { id: "safe", label: "稳妥" },
                      { id: "fast", label: "快速" },
                    ],
                  },
                ],
              },
              output: { questions: [], answers: {} },
              status: "completed",
              raw: { toolName: "AskUserQuestion" },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("未回答，已自动继续");
    expect(html).not.toContain("未提供回答");
  });

  it("routes Agent tool calls to the dedicated renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-agent",
              kind: "think",
              title: "Explore project structure",
              input: {
                description: "Explore project structure",
                subagent_type: "Explore",
              },
              output: "...",
              status: "completed",
              raw: {
                _meta: {
                  claudeCode: {
                    toolName: "Agent",
                  },
                },
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("mock-agent-panel");
    expect(html).toContain("agent:tool-agent:Explore project structure:think");
  });
});
