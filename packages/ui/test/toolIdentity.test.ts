import { describe, expect, it } from "vitest";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
} from "../src/lib/toolIdentity.js";

describe("toolIdentity", () => {
  it("keeps fixed AskUserQuestion name while routing it as user-question family", () => {
    expect(
      resolveToolCallIdentity({
        toolName: "AskUserQuestion",
        kind: "AskUserQuestion",
        title: "AskUserQuestion",
        input: {
          questions: [
            {
              id: "q1",
              question: "选哪个方向？",
              options: [{ id: "a", label: "A" }],
            },
          ],
        },
      }),
    ).toMatchObject({
      toolName: "AskUserQuestion",
      family: "ask-user-question",
      isLegacy: false,
    });
  });

  it("does not classify TodoWrite as a file write tool", () => {
    const identity = resolveToolCallIdentity({
      kind: "TodoWrite",
      title: "TodoWrite",
      input: {
        todos: [{ content: "更新 UI", status: "pending", priority: "high" }],
      },
    });

    expect(identity).toMatchObject({
      toolName: "TodoWrite",
      family: "todo",
      isLegacy: false,
    });
    expect(isFileContentWriteToolCall({ kind: "TodoWrite" }, identity)).toBe(false);
    expect(isFileDiffToolCall({ kind: "TodoWrite" }, identity)).toBe(false);
  });

  it("classifies current fixed file tools without regex collisions", () => {
    const writeTool = { kind: "Write", input: { path: "a.ts" } };
    const editTool = { kind: "Edit", input: { path: "a.ts" } };
    const patchTool = { kind: "ApplyPatch", input: { patch: "..." } };

    expect(isFileContentWriteToolCall(writeTool)).toBe(true);
    expect(isFileDiffToolCall(writeTool)).toBe(false);
    expect(isFileContentWriteToolCall(editTool)).toBe(false);
    expect(isFileDiffToolCall(editTool)).toBe(true);
    expect(isFileDiffToolCall(patchTool)).toBe(true);
  });

  it("keeps legacy ZCode Agent agent shapes behind fallback identity", () => {
    expect(
      resolveToolCallIdentity({
        kind: "think",
        title: "Task",
        input: { subagent_type: "Explore" },
      }),
    ).toMatchObject({
      family: "agent",
      isLegacy: true,
    });
  });

  it("keeps explicit Task tool calls as current agent identity", () => {
    expect(
      resolveToolCallIdentity({
        toolName: "Task",
        input: { subagent_type: "Explore" },
      }),
    ).toMatchObject({
      toolName: "Task",
      family: "agent",
      isLegacy: false,
    });
  });

  it("recognizes current SendMessage but not legacy send_message", () => {
    expect(
      resolveToolCallIdentity({
        toolName: "SendMessage",
      }),
    ).toMatchObject({
      toolName: "SendMessage",
      family: "message",
      isLegacy: false,
    });

    expect(
      resolveToolCallIdentity({
        toolName: "send_message",
      }),
    ).toMatchObject({
      toolName: null,
      family: "unknown",
    });
  });

  it("recognizes current TaskStop as task control", () => {
    expect(
      resolveToolCallIdentity({
        toolName: "TaskStop",
      }),
    ).toMatchObject({
      toolName: "TaskStop",
      family: "task-control",
      isLegacy: false,
    });
  });

  it("recognizes TaskOutput and RespondToCoordinator presentation families", () => {
    expect(
      resolveToolCallIdentity({
        toolName: "TaskOutput",
      }),
    ).toMatchObject({
      toolName: "TaskOutput",
      family: "task-control",
      isLegacy: false,
    });

    expect(
      resolveToolCallIdentity({
        toolName: "RespondToCoordinator",
      }),
    ).toMatchObject({
      toolName: "RespondToCoordinator",
      family: "message",
      isLegacy: false,
    });
  });

  it("recognizes the snake_case submit_result as a workflow tool", () => {
    // 唯一一个 snake_case 现役工具名：下划线必须字面登记，否则动态工作流 actor 的提交
    // 会退回 unknown fallback。
    expect(
      resolveToolCallIdentity({
        toolName: "submit_result",
        kind: "submit_result",
        title: "submit_result",
      }),
    ).toMatchObject({
      toolName: "submit_result",
      family: "workflow",
      isLegacy: false,
    });
  });

  it("routes node repl tools through their dedicated presentation family", () => {
    for (const toolName of [
      "js",
      "js_reset",
      "js_add_node_module_dir",
      "mcp__node_repl__js",
      "mcp__node_repl__js_reset",
      "mcp__node_repl__js_add_node_module_dir",
    ]) {
      expect(
        resolveToolCallIdentity({
          toolName,
          kind: toolName,
          title: toolName,
        }),
      ).toMatchObject({
        toolName,
        family: "node-repl",
        isLegacy: false,
      });
    }
  });

  it("routes current no-separator ExitPlanMode names as switch mode", () => {
    expect(
      resolveToolCallIdentity({
        toolName: "ExitPlanMode",
        kind: "ExitPlanMode",
        title: "ExitPlanMode",
      }),
    ).toMatchObject({
      toolName: "switch_mode",
      family: "switch-mode",
      isLegacy: true,
    });
  });
});
